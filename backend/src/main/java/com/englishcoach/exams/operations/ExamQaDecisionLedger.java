package com.englishcoach.exams.operations;

import com.englishcoach.exams.operations.ExamOperationsRecords.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Exams Phase 8D — the human QA decision ledger {@code imports/exams/staging/qa/approvals.json}, in EXACTLY the canonical
 * format the QA tooling consumes ({@code scripts/exam_extractor/qa_review.py#read_ledger}):
 * {@code {"decisions": [{entryId, decision APPROVE|REJECT|CORRECT, reviewer, reviewedAt, fingerprint, correctedValue?, note?}]}}.
 * One source of truth — the admin center only APPENDS to it; the decision takes effect when {@code qa-review} is re-run
 * (which re-verifies every fingerprint). No competing store, no database table, no production persistence.
 *
 * <p>Integrity (never fabricated, never silently replaced):
 * <ul>
 *   <li>the reviewer is the authenticated administrator ({@code admin-user:<id>}) and {@code reviewedAt} is the server
 *       clock — neither is accepted from the client;</li>
 *   <li>the entry must exist in the CURRENT QA review report, and that report must describe the current package content
 *       (else {@code QA_REVIEW_REPORT_STALE});</li>
 *   <li>the submitted fingerprint must equal the entry's current fingerprint (else {@code QA_FINGERPRINT_STALE});</li>
 *   <li>a valid decision already recorded for the current fingerprint is never overwritten
 *       ({@code QA_DECISION_ALREADY_RECORDED}); a decision for a stale fingerprint stays in the ledger as history and the
 *       new record says so ({@code previousStatus});</li>
 *   <li>entries closed by deterministic proof are not decidable; CORRECT needs a corrected value.</li>
 * </ul>
 * Every record carries who / when / target / fingerprint / previous state (the ledger is the audit trail).
 */
public final class ExamQaDecisionLedger {

    private ExamQaDecisionLedger() {}

    public static final Set<String> DECISIONS = Set.of("APPROVE", "REJECT", "CORRECT");
    public static final String RECORDED_VIA = "ADMIN_OPERATIONS_CENTER";
    public static final String EFFECT = "RECORDED_PENDING_QA_REVIEW_RUN";
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_.:/\\-]{1,160}$");
    private static final Object LOCK = new Object();

    /** A refused decision: {@code status} is the HTTP status the controller returns, {@code code} the stable reason. */
    public static final class Rejected extends RuntimeException {
        private final int status;
        private final String code;

        public Rejected(int status, String code, String detail) {
            super(code + ": " + detail);
            this.status = status;
            this.code = code;
        }

        public int status() {
            return status;
        }

        public String code() {
            return code;
        }
    }

    public record Decision(String entryId, String decision, String reviewer, String reviewedAt, String fingerprint,
                           Object correctedValue, String recordedVia) {}

    /** Valid decisions (latest per entry by reviewedAt, like the Python reader) + counters. */
    public record LedgerView(boolean present, Map<String, Decision> valid, int invalidCount, int recordedViaAdmin) {
        public Optional<Decision> latest(String entryId) {
            return Optional.ofNullable(valid.get(entryId));
        }

        static final LedgerView EMPTY = new LedgerView(false, Map.of(), 0, 0);
    }

    static String problem(Map<?, ?> a) {
        if (a.get("entryId") == null || String.valueOf(a.get("entryId")).isBlank()) return "MISSING_ENTRY_ID";
        if (!DECISIONS.contains(String.valueOf(a.get("decision")))) return "UNKNOWN_DECISION";
        if (blank(a.get("reviewer")) || blank(a.get("reviewedAt"))) return "MISSING_REVIEWER_OR_TIMESTAMP";
        if (!String.valueOf(a.get("fingerprint")).startsWith("sha256:")) return "MISSING_FINGERPRINT";
        if ("CORRECT".equals(a.get("decision")) && emptyValue(a.get("correctedValue"))) return "CORRECT_WITHOUT_VALUE";
        return null;
    }

    public static LedgerView read(Path file, ObjectMapper mapper) {
        if (file == null || !Files.isRegularFile(file)) return LedgerView.EMPTY;
        Map<String, Object> data;
        try {
            data = mapper.readValue(file.toFile(), new TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (IOException e) {
            // an unreadable ledger grants nothing (no decision is considered valid)
            return new LedgerView(true, Map.of(), 1, 0);
        }
        Map<String, Decision> valid = new TreeMap<>();
        int invalid = 0, viaAdmin = 0;
        List<Object> records = new ArrayList<>();
        if (data.get("decisions") instanceof List<?> l) records.addAll(l);
        if (data.get("approvals") instanceof List<?> l) records.addAll(l);
        for (Object o : records) {
            if (!(o instanceof Map<?, ?> a) || problem(a) != null) {
                invalid++;
                continue;
            }
            Decision d = new Decision(String.valueOf(a.get("entryId")), String.valueOf(a.get("decision")),
                    String.valueOf(a.get("reviewer")), String.valueOf(a.get("reviewedAt")), String.valueOf(a.get("fingerprint")),
                    a.get("correctedValue"), a.get("recordedVia") == null ? null : String.valueOf(a.get("recordedVia")));
            if (RECORDED_VIA.equals(d.recordedVia())) viaAdmin++;
            Decision prev = valid.get(d.entryId());
            if (prev == null || d.reviewedAt().compareTo(prev.reviewedAt()) >= 0) valid.put(d.entryId(), d);
        }
        return new LedgerView(true, valid, invalid, viaAdmin);
    }

    /**
     * Validates the request against the CURRENT corpus view and appends one record. {@code adminUserId} comes from the
     * authenticated principal (controller), never from the request body.
     */
    public static QaDecisionReceipt record(Path ledgerFile, ObjectMapper mapper, ExamStagingCorpus corpus, QaDecisionRequest req,
                                           Long adminUserId, Instant now) {
        if (adminUserId == null) throw new Rejected(403, "QA_REVIEWER_REQUIRED", "authenticated administrator required");
        if (req == null || blank(req.testId()) || blank(req.entryId())
                || !ID.matcher(req.testId()).matches() || !ID.matcher(req.entryId()).matches()) {
            throw new Rejected(400, "QA_DECISION_INVALID", "testId and entryId are required");
        }
        if (!DECISIONS.contains(req.decision())) throw new Rejected(400, "QA_DECISION_INVALID", "decision must be APPROVE, REJECT or CORRECT");
        if (req.fingerprint() == null || !req.fingerprint().startsWith("sha256:")) {
            throw new Rejected(400, "QA_FINGERPRINT_REQUIRED", "the fingerprint printed for the entry is required");
        }
        if ("CORRECT".equals(req.decision()) && emptyValue(req.correctedValue())) {
            throw new Rejected(400, "QA_CORRECTED_VALUE_REQUIRED", "CORRECT needs the corrected value");
        }
        if (req.note() != null && req.note().length() > 1000) throw new Rejected(400, "QA_DECISION_INVALID", "note too long");

        PackageDetailDto detail = corpus.detail(req.testId())
                .orElseThrow(() -> new Rejected(404, "QA_ENTRY_NOT_FOUND", "unknown package " + req.testId()));
        QaEntryDto entry = java.util.stream.Stream.concat(detail.qaEntries().stream(), detail.cropUnits().stream())
                .filter(e -> req.entryId().equals(e.entryId())).findFirst()
                .orElseThrow(() -> new Rejected(404, "QA_ENTRY_NOT_FOUND", "entry " + req.entryId() + " is not in the current QA review"));
        if (!entry.reportCurrent()) {
            throw new Rejected(409, "QA_REVIEW_REPORT_STALE", "the QA review report describes other package content — re-run qa-review");
        }
        if ("RESOLVED_BY_PROOF".equals(entry.status())) {
            throw new Rejected(409, "QA_ENTRY_RESOLVED_BY_PROOF", "closed by deterministic proof; no human decision needed");
        }
        if (!req.fingerprint().equals(entry.fingerprint())) {
            throw new Rejected(409, "QA_FINGERPRINT_STALE", "the decision was prepared for different content");
        }

        // Exams Phase 9 (local / staging tooling only): the in-JVM monitor serializes threads of this backend; the OS file
        // lock on a sibling ".lock" file serializes other processes (a second backend, the Python QA tooling if it locks)
        // so no decision is lost and the duplicate / stale checks below always see the latest ledger. Production QA
        // persistence is a Phase 10 integration item (no distributed lock is built here).
        synchronized (LOCK) {
          try (java.nio.channels.FileChannel lockChannel = openLockChannel(ledgerFile);
               java.nio.channels.FileLock ignored = lockChannel.lock()) {
            requireWellFormed(ledgerFile, mapper);
            LedgerView view = read(ledgerFile, mapper);
            Optional<Decision> previous = view.latest(req.entryId());
            if (previous.isPresent() && previous.get().fingerprint().equals(entry.fingerprint())) {
                throw new Rejected(409, "QA_DECISION_ALREADY_RECORDED",
                        "a decision for this exact content already exists (" + previous.get().decision() + ")");
            }
            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("entryId", req.entryId());
            rec.put("decision", req.decision());
            rec.put("reviewer", "admin-user:" + adminUserId);
            rec.put("reviewedAt", now.toString());
            rec.put("fingerprint", entry.fingerprint());
            if ("CORRECT".equals(req.decision())) rec.put("correctedValue", req.correctedValue());
            if (req.note() != null && !req.note().isBlank()) rec.put("note", req.note().trim());
            rec.put("testId", req.testId());
            String previousStatus = previous.isPresent() ? "STALE_DECISION" : entry.status();
            rec.put("previousStatus", previousStatus);
            previous.ifPresent(p -> rec.put("previousDecision", p.decision()));
            rec.put("recordedVia", RECORDED_VIA);
            int records = append(ledgerFile, mapper, rec);
            return new QaDecisionReceipt(req.testId(), req.entryId(), req.decision(), (String) rec.get("reviewer"),
                    (String) rec.get("reviewedAt"), entry.fingerprint(), previousStatus,
                    previous.map(Decision::decision).orElse(null), records, EFFECT);
          } catch (IOException | java.nio.channels.OverlappingFileLockException e) {
            throw new Rejected(500, "QA_LEDGER_WRITE_FAILED", "ledger could not be locked");
          }
        }
    }

    private static java.nio.channels.FileChannel openLockChannel(Path ledgerFile) throws IOException {
        Files.createDirectories(ledgerFile.getParent());
        Path lockFile = ledgerFile.resolveSibling(ledgerFile.getFileName() + ".lock");
        return java.nio.channels.FileChannel.open(lockFile, java.nio.file.StandardOpenOption.CREATE,
                java.nio.file.StandardOpenOption.WRITE);
    }

    /**
     * Exams Phase 9: an existing ledger that is not valid JSON, or whose {@code decisions} / {@code approvals} are not
     * lists, is never rewritten (that would silently drop human decisions) — the write is refused until a human repairs it.
     */
    static void requireWellFormed(Path ledgerFile, ObjectMapper mapper) {
        if (!Files.isRegularFile(ledgerFile)) return;
        Map<String, Object> data;
        try {
            data = mapper.readValue(ledgerFile.toFile(), new TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (IOException e) {
            throw new Rejected(409, "QA_LEDGER_MALFORMED", "the existing ledger is not valid JSON; repair it before recording");
        }
        for (String key : List.of("decisions", "approvals")) {
            if (data != null && data.containsKey(key) && !(data.get(key) instanceof List<?>)) {
                throw new Rejected(409, "QA_LEDGER_MALFORMED", "the existing ledger field '" + key + "' is not a list");
            }
        }
    }

    /** Appends one record, preserving every existing record and key; atomic replace. Returns the record count. */
    private static int append(Path ledgerFile, ObjectMapper mapper, Map<String, Object> rec) {
        try {
            Files.createDirectories(ledgerFile.getParent());
            LinkedHashMap<String, Object> data = Files.isRegularFile(ledgerFile)
                    ? mapper.readValue(ledgerFile.toFile(), new TypeReference<LinkedHashMap<String, Object>>() {})
                    : new LinkedHashMap<>();
            List<Object> decisions = new ArrayList<>();
            if (data.get("decisions") instanceof List<?> l) decisions.addAll(l);
            decisions.add(rec);
            data.put("decisions", decisions);
            Path tmp = ledgerFile.resolveSibling(ledgerFile.getFileName() + ".tmp-" + UUID.randomUUID());
            // complete temp file, flushed to disk (fsync) before the atomic replace — a crash never leaves a partial ledger
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(tmp.toFile())) {
                mapper.copy().enable(SerializationFeature.INDENT_OUTPUT)
                        .disable(com.fasterxml.jackson.core.JsonGenerator.Feature.AUTO_CLOSE_TARGET)
                        .writeValue(out, data);
                out.flush();
                out.getFD().sync();
            }
            try {
                Files.move(tmp, ledgerFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicUnsupported) {
                Files.move(tmp, ledgerFile, StandardCopyOption.REPLACE_EXISTING);
            }
            return decisions.size();
        } catch (IOException e) {
            throw new Rejected(500, "QA_LEDGER_WRITE_FAILED", "ledger could not be written");
        }
    }

    private static boolean blank(Object o) {
        return o == null || String.valueOf(o).isBlank();
    }

    private static boolean emptyValue(Object o) {
        if (o == null) return true;
        if (o instanceof String s) return s.isBlank();
        if (o instanceof Collection<?> c) return c.isEmpty();
        if (o instanceof Map<?, ?> m) return m.isEmpty();
        return false;
    }
}
