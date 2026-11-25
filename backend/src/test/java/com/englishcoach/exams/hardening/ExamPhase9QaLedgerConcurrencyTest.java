package com.englishcoach.exams.hardening;

import com.englishcoach.exams.operations.ExamOperationsRecords.QaDecisionRequest;
import com.englishcoach.exams.operations.ExamOperationsRecords.QaEntryDto;
import com.englishcoach.exams.operations.ExamQaDecisionLedger;
import com.englishcoach.exams.operations.ExamStagingCorpus;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Exams Phase 9 — local QA ledger writes (matrix 43, 73, 74): concurrent decisions are never lost, never duplicated, never
 * corrupt the file; a malformed ledger fails closed and is left untouched; no temp file survives. Uses the REAL staged
 * corpus view (current fingerprints) and ONLY temporary ledgers — the repository ledger is never written.
 */
@ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamPhase9QaLedgerConcurrencyTest {

    static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    static final Path REPO = Path.of("..");
    static final Path REAL_LEDGER = REPO.resolve("imports/exams/staging/qa/approvals.json");
    static final Instant NOW = Instant.parse("2026-10-04T12:00:00Z");
    static ExamStagingCorpus corpus;
    static String testId;
    static List<QaEntryDto> open;

    @BeforeAll
    static void load() throws Exception {
        assumeTrue(Files.isDirectory(ExamStagingCorpus.extractedDir(REPO)), "staged corpus not present (local data)");
        corpus = ExamStagingCorpus.load(REPO, MAPPER, com.englishcoach.exams.release.ExamImportPlanner.StateReader.EMPTY, NOW);
        for (String id : corpus.testIds()) {
            List<QaEntryDto> entries = corpus.detail(id).orElseThrow().qaEntries().stream()
                    .filter(e -> e.reportCurrent() && !"RESOLVED_BY_PROOF".equals(e.status()) && e.fingerprint() != null)
                    .toList();
            if (entries.size() >= 8) {
                testId = id;
                open = entries;
                break;
            }
        }
        assumeTrue(testId != null, "no package with 8 open QA entries");
    }

    @Test
    @DisplayName("43/74: 8 concurrent decisions on different entries ⇒ all 8 recorded, valid JSON, no temp file left")
    void concurrentDistinctDecisions(@TempDir Path tmp) throws Exception {
        boolean realExisted = Files.isRegularFile(REAL_LEDGER);
        Path ledger = tmp.resolve("approvals.json");
        ExecutorService pool = Executors.newFixedThreadPool(8);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<?>> fs = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            QaEntryDto e = open.get(i);
            fs.add(pool.submit(() -> {
                go.await();
                return ExamQaDecisionLedger.record(ledger, MAPPER, corpus,
                        new QaDecisionRequest(testId, e.entryId(), "REJECT", e.fingerprint(), null, "concurrency test"), 1L, NOW);
            }));
        }
        go.countDown();
        for (Future<?> f : fs) f.get(60, TimeUnit.SECONDS);
        pool.shutdown();
        Map<String, Object> data = MAPPER.readValue(ledger.toFile(), new TypeReference<LinkedHashMap<String, Object>>() {});
        assertEquals(8, ((List<?>) data.get("decisions")).size(), "no lost update");
        assertEquals(8, ExamQaDecisionLedger.read(ledger, MAPPER).valid().size());
        try (Stream<Path> s = Files.list(tmp)) {
            assertTrue(s.noneMatch(p -> p.getFileName().toString().contains(".tmp-")), "no partial temp file left");
        }
        assertEquals(realExisted, Files.isRegularFile(REAL_LEDGER), "the repository ledger is never created");
    }

    @Test
    @DisplayName("43: 6 concurrent decisions on the SAME entry ⇒ exactly one recorded, the rest QA_DECISION_ALREADY_RECORDED")
    void concurrentSameEntry(@TempDir Path tmp) throws Exception {
        Path ledger = tmp.resolve("approvals.json");
        QaEntryDto e = open.get(0);
        ExecutorService pool = Executors.newFixedThreadPool(6);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<String>> fs = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            fs.add(pool.submit(() -> {
                go.await();
                try {
                    ExamQaDecisionLedger.record(ledger, MAPPER, corpus,
                            new QaDecisionRequest(testId, e.entryId(), "APPROVE", e.fingerprint(), null, null), 1L, NOW);
                    return "RECORDED";
                } catch (ExamQaDecisionLedger.Rejected r) {
                    return r.code();
                }
            }));
        }
        go.countDown();
        List<String> results = new ArrayList<>();
        for (Future<String> f : fs) results.add(f.get(60, TimeUnit.SECONDS));
        pool.shutdown();
        assertEquals(1, results.stream().filter("RECORDED"::equals).count(), results.toString());
        assertEquals(5, results.stream().filter("QA_DECISION_ALREADY_RECORDED"::equals).count(), results.toString());
        assertEquals(1, ((List<?>) MAPPER.readValue(ledger.toFile(), Map.class).get("decisions")).size());
    }

    @Test
    @DisplayName("73: a malformed ledger fails closed (409 QA_LEDGER_MALFORMED) and is left byte-for-byte untouched")
    void malformedLedgerFailsClosed(@TempDir Path tmp) throws Exception {
        QaEntryDto e = open.get(0);
        for (String broken : List.of("{ \"decisions\": [ {\"entryId\": \"x\"", "{\"decisions\": \"not-a-list\"}", "[]")) {
            Path ledger = tmp.resolve("approvals-" + UUID.randomUUID() + ".json");
            Files.writeString(ledger, broken);
            ExamQaDecisionLedger.Rejected r = assertThrows(ExamQaDecisionLedger.Rejected.class, () -> ExamQaDecisionLedger.record(ledger,
                    MAPPER, corpus, new QaDecisionRequest(testId, e.entryId(), "APPROVE", e.fingerprint(), null, null), 1L, NOW));
            assertTrue(Set.of("QA_LEDGER_MALFORMED").contains(r.code()), broken + " → " + r.code());
            assertEquals(409, r.status());
            assertEquals(broken, Files.readString(ledger), "never rewritten");
        }
    }

    @Test
    @DisplayName("07/08 (ledger): missing / stale fingerprint and unknown entry are refused; reviewer + time come from the server")
    void fingerprintIntegrity(@TempDir Path tmp) throws Exception {
        Path ledger = tmp.resolve("approvals.json");
        QaEntryDto e = open.get(1);
        assertEquals("QA_FINGERPRINT_REQUIRED", assertThrows(ExamQaDecisionLedger.Rejected.class, () -> ExamQaDecisionLedger.record(ledger,
                MAPPER, corpus, new QaDecisionRequest(testId, e.entryId(), "APPROVE", null, null, null), 1L, NOW)).code());
        assertEquals("QA_FINGERPRINT_STALE", assertThrows(ExamQaDecisionLedger.Rejected.class, () -> ExamQaDecisionLedger.record(ledger,
                MAPPER, corpus, new QaDecisionRequest(testId, e.entryId(), "APPROVE", "sha256:" + "1".repeat(64), null, null), 1L, NOW)).code());
        assertEquals("QA_ENTRY_NOT_FOUND", assertThrows(ExamQaDecisionLedger.Rejected.class, () -> ExamQaDecisionLedger.record(ledger,
                MAPPER, corpus, new QaDecisionRequest(testId, "UNKNOWN-ENTRY", "APPROVE", e.fingerprint(), null, null), 1L, NOW)).code());
        assertFalse(Files.exists(ledger), "refusals write nothing");
        var receipt = ExamQaDecisionLedger.record(ledger, MAPPER, corpus,
                new QaDecisionRequest(testId, e.entryId(), "REJECT", e.fingerprint(), null, null), 1L, NOW);
        assertEquals("admin-user:1", receipt.reviewer());
        assertEquals(NOW.toString(), receipt.reviewedAt());
        assertEquals(e.fingerprint(), receipt.fingerprint(), "the CURRENT fingerprint is recorded, never a default");
    }
}
