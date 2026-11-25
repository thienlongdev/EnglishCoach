package com.englishcoach.exams.operations;

import com.englishcoach.exams.content.ExamRightsDecisionPolicy;
import com.englishcoach.exams.content.ExamRightsDecisionPolicy.Operation;
import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.operations.ExamOperationsRecords.*;
import com.englishcoach.exams.practice.ExamPracticeReadiness;
import com.englishcoach.exams.practice.ExamPracticeRecords.PracticeScopeDiagnosticDto;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.release.ExamImportPlanner;
import com.englishcoach.exams.release.ExamImportStateJdbcReader;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.englishcoach.exams.validation.ExamFormValidator;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import java.util.stream.Stream;

/**
 * Exams Phase 8D — admin operations center service.
 *
 * <p><b>Staging view</b> (local Exams worktree only): enabled ONLY when {@code app.exams.operations.corpus-root} points at a
 * repository root that contains {@code imports/exams/staging}. The key has no production value (not in any compose / env
 * template), so in production the staging view is simply "not configured" and QA decisions are refused. The view is
 * recomputed only when a staged package, a canonical report or the decision ledger changes (file stamp).
 *
 * <p><b>Persisted view</b>: one database form through the canonical services (validation service, practice readiness,
 * the Spring {@link ExamRightsService} = production PUBLISHER_LICENCE basis). Publication / retirement are PLANS only;
 * nothing here publishes, retires, imports or writes to the database. The only write in the whole operations center is
 * the append-only human QA ledger ({@link ExamQaDecisionLedger}).
 */
@Slf4j
@Service
public class ExamOperationsService {

    private final ExamContentRepository contentRepository;
    private final ExamContentValidationService validationService;
    private final ExamPracticeService practiceService;
    private final ExamRightsService rightsService;
    private final NamedParameterJdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final String corpusRootSetting;
    private final Object loadLock = new Object();
    private volatile Cached cached;

    private record Cached(String stamp, ExamStagingCorpus corpus, String note) {}

    @org.springframework.beans.factory.annotation.Autowired
    public ExamOperationsService(ExamContentRepository contentRepository, ExamContentValidationService validationService,
                                 ExamPracticeService practiceService, ExamRightsService rightsService,
                                 NamedParameterJdbcTemplate jdbc, ObjectMapper mapper,
                                 @Value("${app.exams.operations.corpus-root:}") String corpusRootSetting) {
        this(contentRepository, validationService, practiceService, rightsService, jdbc, mapper, corpusRootSetting, Clock.systemUTC());
    }

    ExamOperationsService(ExamContentRepository contentRepository, ExamContentValidationService validationService,
                          ExamPracticeService practiceService, ExamRightsService rightsService, NamedParameterJdbcTemplate jdbc,
                          ObjectMapper mapper, String corpusRootSetting, Clock clock) {
        this.contentRepository = contentRepository;
        this.validationService = validationService;
        this.practiceService = practiceService;
        this.rightsService = rightsService;
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.corpusRootSetting = corpusRootSetting;
        this.clock = clock;
    }

    /** Repository root of the local staged corpus, or empty when the staging view is not configured (production). */
    Optional<Path> corpusRoot() {
        if (corpusRootSetting == null || corpusRootSetting.isBlank()) return Optional.empty();
        Path root = Path.of(corpusRootSetting.trim()).toAbsolutePath().normalize();
        return Files.isDirectory(root.resolve("imports").resolve("exams").resolve("staging")) ? Optional.of(root) : Optional.empty();
    }

    Optional<ExamStagingCorpus> corpus() {
        Optional<Path> root = corpusRoot();
        if (root.isEmpty()) return Optional.empty();
        String stamp = stamp(root.get());
        Cached c = cached;
        if (c != null && c.stamp().equals(stamp)) return Optional.of(c.corpus());
        synchronized (loadLock) {
            c = cached;
            if (c != null && c.stamp().equals(stamp)) return Optional.of(c.corpus());
            ExamStagingCorpus corpus;
            String note = null;
            try {
                try {
                    corpus = ExamStagingCorpus.load(root.get(), mapper, new ExamImportStateJdbcReader(jdbc, mapper), clock.instant());
                } catch (RuntimeException dbUnavailable) {
                    // local import state unreadable: plans are computed against an empty target (still BLOCKED by the gate)
                    log.warn("[ExamsOps] local import state unavailable: {}", dbUnavailable.getMessage());
                    corpus = ExamStagingCorpus.load(root.get(), mapper, ExamImportPlanner.StateReader.EMPTY, clock.instant());
                    note = "LOCAL_IMPORT_STATE_UNAVAILABLE";
                }
            } catch (IOException e) {
                throw new IllegalStateException("STAGING_CORPUS_UNREADABLE: " + e.getMessage(), e);
            }
            cached = new Cached(stamp, corpus, note);
            return Optional.of(corpus);
        }
    }

    /** Changes whenever a staged package, a canonical report or the decision ledger changes. */
    static String stamp(Path root) {
        Path staging = root.resolve("imports").resolve("exams").resolve("staging");
        StringBuilder sb = new StringBuilder();
        List<Path> files = new ArrayList<>();
        Path extracted = staging.resolve("extracted");
        if (Files.isDirectory(extracted)) {
            try (Stream<Path> s = Files.walk(extracted, 6)) {
                files.addAll(s.filter(f -> f.toString().endsWith(".json")).sorted().toList());
            } catch (IOException ignored) {
                sb.append("walk-failed");
            }
        }
        for (String r : List.of("qa_release_review.json", "corpus_closure_matrix.json", "legacy_replacement_mapping.json")) {
            files.add(staging.resolve("reports").resolve(r));
        }
        files.add(staging.resolve("qa").resolve("approvals.json"));
        for (Path f : files) {
            try {
                sb.append(f).append('|').append(Files.isRegularFile(f) ? Files.size(f) + ":" + Files.getLastModifiedTime(f).toMillis() : "-")
                        .append('\n');
            } catch (IOException e) {
                sb.append(f).append("|?\n");
            }
        }
        return ExamStagingCorpus.sha256(sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    // ─── staging ───────────────────────────────────────────────────────────────────────────────

    public OperationsOverviewDto overview() {
        Map<String, String> versions = new LinkedHashMap<>();
        versions.put("view", ExamStagingCorpus.VIEW_VERSION);
        versions.put("validator", ExamFormValidator.VALIDATOR_VERSION);
        versions.put("practiceReadiness", ExamPracticeReadiness.READINESS_VERSION);
        versions.put("importPlan", ExamImportPlanner.PLAN_VERSION);
        versions.put("rightsPolicy", ExamRightsDecisionPolicy.POLICY_VERSION);
        Optional<ExamStagingCorpus> corpus = corpus();
        if (corpus.isEmpty()) {
            return new OperationsOverviewDto(clock.instant(), false,
                    "STAGING_CORPUS_NOT_CONFIGURED: the staged corpus is a local Exams-worktree view (app.exams.operations.corpus-root)",
                    Map.of(), Map.of(), Map.of(), new LedgerSummaryDto(false, 0, 0, 0, 0), List.of(), versions);
        }
        ExamStagingCorpus c = corpus.get();
        Cached snapshot = cached;
        return new OperationsOverviewDto(clock.instant(), true, snapshot == null ? null : snapshot.note(), c.gateTotals(),
                c.dispositionTotals(), c.practiceTotals(), c.ledgerSummary(), c.rows(), versions);
    }

    public Optional<PackageDetailDto> packageDetail(String testId) {
        return corpus().flatMap(c -> c.detail(testId));
    }

    public Optional<byte[]> imageBytes(String testId, String sha256) throws IOException {
        Optional<ExamStagingCorpus> c = corpus();
        return c.isEmpty() ? Optional.empty() : c.get().imageBytes(testId, sha256);
    }

    public Optional<String> imageMime(String testId, String sha256) {
        return corpus().flatMap(c -> c.imageMime(testId, sha256));
    }

    /** Appends one fingerprinted human decision (refused when the staging view is not configured). */
    public QaDecisionReceipt recordDecision(Long adminUserId, QaDecisionRequest request) {
        Optional<Path> root = corpusRoot();
        ExamStagingCorpus corpus = corpus().orElseThrow(() -> new ExamQaDecisionLedger.Rejected(404,
                "STAGING_CORPUS_NOT_CONFIGURED", "human QA decisions are recorded in the local staged corpus only"));
        Path ledger = root.orElseThrow().resolve("imports").resolve("exams").resolve("staging").resolve("qa").resolve("approvals.json");
        QaDecisionReceipt receipt = ExamQaDecisionLedger.record(ledger, mapper, corpus, request, adminUserId, clock.instant());
        log.info("[ExamsOps] QA decision recorded: package {} entry {} decision {} by {} (previous {})", receipt.testId(),
                receipt.entryId(), receipt.decision(), receipt.reviewer(), receipt.previousStatus());
        cached = null;   // the ledger changed: the next read recomputes
        return receipt;
    }

    // ─── persisted forms ───────────────────────────────────────────────────────────────────────

    public Optional<PersistedFormOpsDto> persistedForm(UUID formId) {
        Optional<FormVersionRecord> formOpt = contentRepository.findFormById(formId);
        if (formOpt.isEmpty()) return Optional.empty();
        FormVersionRecord form = formOpt.get();
        ExamFormValidationReport report = validationService.evaluate(formId);
        Map<String, Object> validation = new LinkedHashMap<>();
        validation.put("status", report.status().name());
        validation.put("fullSimulationEligible", report.fullSimulationEligible());
        validation.put("validatorVersion", report.validatorVersion());
        validation.put("contentFingerprint", report.contentFingerprint());
        validation.put("blockingCodes", report.blockingCodes().stream().map(Object::toString).toList());
        validation.put("availableModes", report.availableModes());

        List<PracticeScopeOpsDto> scopes = new ArrayList<>();
        try {
            for (PracticeScopeDiagnosticDto d : practiceService.getDiagnostics(formId)) {
                scopes.add(new PracticeScopeOpsDto(d.scopeCode(), d.scopeType(), d.number(), d.learnerAvailability(), d.ready(),
                        d.reasonCodes(), d.questionCount()));
            }
        } catch (RuntimeException e) {
            log.warn("[ExamsOps] practice diagnostics unavailable for {}: {}", formId, e.getMessage());
        }

        List<RightsDecisionDto> decisions = new ArrayList<>();
        for (Operation op : List.of(Operation.LEARNER_RUNTIME, Operation.PUBLICATION)) {
            rightsService.evaluateFormRights(formId, op).ifPresentOrElse(
                    d -> decisions.add(new RightsDecisionDto(d.basis().name(), d.operation().name(), d.allowed(), d.reason().name(),
                            d.grantedBy(), d.unclearedRightsCodes())),
                    () -> decisions.add(new RightsDecisionDto(rightsService.getBasis().name(), op.name(), false,
                            "RIGHTS_FACTS_UNAVAILABLE", null, Set.of())));
        }
        Map<String, Object> auth = new LinkedHashMap<>();
        try {
            contentRepository.findLatestProjectUsageAuthorization(formId).ifPresentOrElse(r -> {
                Object a = r.metadata().get("projectUsageAuthorization");
                if (a instanceof Map<?, ?> m) m.forEach((k, v) -> auth.put(String.valueOf(k), v));
                auth.put("recordedImportBasis", r.importBasis());
            }, () -> auth.put("status", "ABSENT"));
        } catch (RuntimeException e) {
            auth.put("status", "UNAVAILABLE");
        }
        RightsDto rights = new RightsDto(auth, List.of(), List.of(), decisions, ExamRightsDecisionPolicy.POLICY_VERSION);

        List<String> blockers = new ArrayList<>();
        boolean published = form.lifecycleState() == LifecycleState.PUBLISHED;
        if (published) blockers.add("ALREADY_PUBLISHED");
        if (!report.fullSimulationEligible()) blockers.add("PUBLICATION_CONTENT_VALIDATION_FAILED");
        decisions.stream().filter(d -> d.operation().equals(Operation.PUBLICATION.name()) && !d.allowed())
                .forEach(d -> blockers.add("PUBLICATION_RIGHTS:" + d.reason()));
        blockers.add("PRODUCTION_PUBLICATION_DEFERRED_TO_PHASE_10");
        LifecyclePlanDto lifecycle = new LifecyclePlanDto("PLAN_ONLY", false, blockers, false,
                published ? List.of("RETIREMENT_ONLY_AFTER_A_PUBLISHED_REPLACEMENT (plan; never executed here)") : List.of());

        return Optional.of(new PersistedFormOpsDto(form.id(), form.logicalKey(), form.version(),
                form.family() == null ? null : form.family().name(), form.title(),
                form.lifecycleState() == null ? null : form.lifecycleState().name(), validation, scopes, rights,
                recordedIdentity(formId), lifecycle));
    }

    /** The package identity the importer recorded for this form (summary fields only), if any. */
    @SuppressWarnings("unchecked")
    Map<String, Object> recordedIdentity(UUID formId) {
        try {
            List<String> rows = jdbc.query("""
                    SELECT q.findings -> 'packageIdentity' AS identity
                      FROM exams.content_package_imports i
                      JOIN exams.content_qa_runs q ON q.package_import_id = i.id
                     WHERE i.form_id = :formId AND q.findings -> 'packageIdentity' IS NOT NULL
                     ORDER BY q.created_at DESC
                     LIMIT 1
                    """, new MapSqlParameterSource("formId", formId), (rs, n) -> rs.getString("identity"));
            if (rows.isEmpty() || rows.get(0) == null) return null;
            Map<String, Object> id = mapper.readValue(rows.get(0), Map.class);
            Map<String, Object> out = new LinkedHashMap<>();
            for (String k : List.of("identityVersion", "sourceKey", "semanticFingerprint", "packageId", "packageVersion",
                    "formLogicalKey", "formVersion", "manifestContentHash")) {
                if (id.containsKey(k)) out.put(k, id.get(k));
            }
            return out;
        } catch (Exception e) {
            return null;
        }
    }
}
