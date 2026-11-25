package com.englishcoach.exams.operations;

import com.englishcoach.exams.operations.ExamOperationsRecords.*;
import com.englishcoach.exams.release.ExamImportExecutor;
import com.englishcoach.exams.release.ExamImportPlanner;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.mock;

/**
 * Exams Phase 8D — the operations center over the REAL local staged corpus (read-only; skips without it). Human QA
 * decisions are written ONLY to a temporary ledger (never the repository ledger). Matrix 39–56 + the corpus numbers.
 * Writes imports/exams/staging/reports/phase8_operations_view.json (counts / codes only — no exam text).
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamOperationsCorpusTest {

    static final Path REPO = Path.of("..").toAbsolutePath().normalize();
    static final Path REAL_LEDGER = REPO.resolve("imports/exams/staging/qa/approvals.json");
    static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    static final Instant NOW = Instant.parse("2026-10-04T12:00:00Z");
    static ExamStagingCorpus corpus;
    static boolean realLedgerExisted;
    static String realLedgerBefore;
    static final Map<String, Object> REPORT = new LinkedHashMap<>();
    static final String ETS_T1 = "toeic/ets-2026/test-1";

    @BeforeAll
    static void load() throws Exception {
        assumeTrue(Files.isDirectory(ExamStagingCorpus.extractedDir(REPO)), "no staged corpus (local data)");
        assumeTrue(Files.isRegularFile(REPO.resolve("imports/exams/staging/reports/qa_release_review.json")), "no QA review report");
        realLedgerExisted = Files.isRegularFile(REAL_LEDGER);
        realLedgerBefore = realLedgerExisted ? Files.readString(REAL_LEDGER) : null;
        corpus = ExamStagingCorpus.load(REPO, MAPPER, ExamImportPlanner.StateReader.EMPTY, NOW);
    }

    @AfterAll
    static void report() throws Exception {
        if (corpus == null) return;
        assertEquals(realLedgerExisted, Files.isRegularFile(REAL_LEDGER), "the repository ledger is never created / deleted by tests");
        if (realLedgerExisted) assertEquals(realLedgerBefore, Files.readString(REAL_LEDGER), "the repository ledger is never modified");
        REPORT.put("generatedBy", "ExamOperationsCorpusTest (Exams Recovery Phase 8D, read-only staging view)");
        MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT)
                .writeValue(REPO.resolve("imports/exams/staging/reports/phase8_operations_view.json").toFile(), REPORT);
    }

    static PackageDetailDto detail(String id) {
        return corpus.detail(id).orElseThrow();
    }

    static QaEntryDto openEntry(PackageDetailDto d) {
        return d.qaEntries().stream().filter(QaEntryDto::decidable).filter(e -> "OPEN".equals(e.status())).findFirst().orElseThrow();
    }

    @Test
    @Order(1)
    @DisplayName("38-46/54: overview = canonical gate truth for every staged package; READY_EXCEPT_HUMAN_QA ≠ IMPORT_READY; all plans BLOCKED")
    void overview() {
        List<PackageRowDto> rows = corpus.rows();
        Map<String, Integer> gate = corpus.gateTotals();
        REPORT.put("gateTotals", gate);
        REPORT.put("dispositionTotals", corpus.dispositionTotals());
        REPORT.put("practiceScopeTotals", corpus.practiceTotals());
        REPORT.put("ledger", corpus.ledgerSummary());
        assertEquals(rows.size(), gate.get("PACKAGES"));
        assertTrue(rows.size() >= 32, "every staged package is listed");
        for (PackageRowDto r : rows) {
            assertNotNull(r.phase2Status());
            assertNotNull(r.semanticFingerprint());
            assertTrue(r.gate().containsKey("STRUCTURAL_VALID") && r.gate().containsKey("RUNNER_COMPATIBLE")
                    && r.gate().containsKey("SCORING_COMPATIBLE") && r.gate().containsKey("MEDIA_READY") && r.gate().containsKey("QA_APPROVED"));
            assertNotEquals("LICENSED", r.publisherLicence(), "publisher licence never fabricated");
            if (r.readyExceptHumanQa()) assertFalse(r.importReady(), "READY_EXCEPT_HUMAN_QA is not IMPORT_READY");
            assertEquals("BLOCKED", r.productionImportOperation(), "production import is always blocked");
            if (!r.importReady()) assertEquals("BLOCKED", r.localImportOperation(), "a non-IMPORT_READY package cannot be imported");
        }
        assertEquals(0, gate.get("QA_APPROVED"), "no human approval exists ⇒ none shown");
        assertEquals(0, gate.get("IMPORT_READY"));
        assertTrue(gate.get("READY_EXCEPT_HUMAN_QA") > 0);
    }

    @Test
    @Order(2)
    @DisplayName("39/40/41/42/45: detail shows validator truth, runner / scoring codes, QA blockers, media state, provenance")
    void detailTruth() throws Exception {
        PackageDetailDto d = detail(ETS_T1);
        assertEquals("VALID", d.summary().phase2Status());
        assertNotNull(d.validatorVersion());
        assertTrue(d.runnerBlocking().isEmpty() && d.scoringBlocking().isEmpty(), "ETS 2026 T1 is runner + scoring compatible");
        assertFalse(d.qaEntries().isEmpty(), "open QA blockers are listed");
        assertTrue(d.qaEntries().stream().allMatch(e -> e.fingerprint() != null && e.fingerprint().startsWith("sha256:")));
        assertFalse(d.media().isEmpty());
        assertTrue(d.media().stream().anyMatch(MediaAssetDto::waitingOnlyForHuman), "crops awaiting a human decision are visible");
        assertTrue(d.provenance().complete());
        assertNotNull(d.provenance().rawSourceSha256());
        assertFalse(String.valueOf(d.provenance().rawSourcePath()).matches("^[A-Za-z]:.*|^/.*|^\\\\\\\\.*"), "repo-relative path only");
        String json = MAPPER.writeValueAsString(d);
        for (String forbidden : List.of("acceptedAnswers", "candidateInterpretation", "numberReads", "\"prompt\"", "bodyPayload")) {
            assertFalse(json.contains(forbidden), "operations detail leaks " + forbidden);
        }
        REPORT.put("etsT1", Map.of("qaEntries", d.qaEntries().size(), "cropUnits", d.cropUnits().size(), "media", d.media().size(),
                "practiceScopes", d.practiceScopes().size()));
    }

    @Test
    @Order(3)
    @DisplayName("43/44/52/53: project authorization, publisher licence, provenance, basis and decision are separate; neither OWNER_AUTHORIZED nor QA is a licence")
    void rightsSeparate() {
        RightsDto r = detail(ETS_T1).rights();
        assertEquals("OWNER_AUTHORIZED", r.projectAuthorization().get("status"));
        assertEquals(Boolean.FALSE, r.projectAuthorization().get("publisherEndorsement"));
        assertFalse(r.publisherLicences().isEmpty());
        assertTrue(r.publisherLicences().stream().noneMatch(l -> "LICENSED".equals(l.get("legalStatus"))));
        Map<String, RightsDecisionDto> byKey = new HashMap<>();
        for (RightsDecisionDto x : r.decisions()) byKey.put(x.basis() + "/" + x.operation(), x);
        assertTrue(byKey.get("OWNER_PROJECT_AUTHORIZATION_LOCAL/LOCAL_STAGING_IMPORT").allowed(), "owner authorization clears LOCAL staging");
        assertFalse(byKey.get("PUBLISHER_LICENCE/LEARNER_RUNTIME").allowed(), "production runtime stays fail closed");
        assertFalse(byKey.get("PUBLISHER_LICENCE/PUBLICATION").allowed());
        RightsDecisionDto ownerPublication = byKey.get("OWNER_PROJECT_AUTHORIZATION_LOCAL/PUBLICATION");
        assertFalse(ownerPublication.allowed());
        assertEquals("OWNER_AUTHORIZATION_NOT_A_PUBLICATION_BASIS", ownerPublication.reason());
    }

    @Test
    @Order(4)
    @DisplayName("46/47/55/56: import plans BLOCKED with reasons, the executor refuses them; publication / retirement are plans only")
    void plansAndLifecycle() {
        PackageDetailDto d = detail(ETS_T1);
        for (ImportPlanDto p : d.importPlans()) {
            assertEquals("BLOCKED", p.operation());
            assertFalse(p.executable());
            assertFalse(p.blockers().isEmpty());
        }
        assertTrue(d.importPlans().stream().anyMatch(p -> p.blockers().contains("RELEASE_GATE_NOT_IMPORT_READY")));
        assertTrue(d.importPlans().stream().filter(p -> p.target().equals("PRODUCTION"))
                .allMatch(p -> !p.blockers().contains("PRODUCTION_IMPORT_BASIS_NOT_ESTABLISHED")
                        && p.blockers().contains("RELEASE_GATE_NOT_IMPORT_READY")));
        // the executor refuses a BLOCKED plan before touching the importer
        ExamStagingCorpus.Evaluated e = corpus.evaluated(ETS_T1).orElseThrow();
        ExamImportExecutor executor = new ExamImportExecutor(mock(com.englishcoach.exams.content.ExamContentPackageImporter.class),
                ExamImportPlanner.StateReader.EMPTY, MAPPER);
        IllegalStateException refused = assertThrows(IllegalStateException.class, () -> executor.execute(e.localPlan(), e.pkg(), 1L));
        assertTrue(refused.getMessage().startsWith("IMPORT_PLAN_BLOCKED"), refused.getMessage());
        LifecyclePlanDto life = d.lifecycle();
        assertEquals("PLAN_ONLY", life.executionMode());
        assertFalse(life.publicationAllowed());
        assertTrue(life.publicationBlockers().contains("RELEASE_GATE_NOT_IMPORT_READY"));
        assertTrue(life.retirementNotes().stream().allMatch(n -> n.contains("executed=false")));
        assertTrue(d.legacyMappings().stream().noneMatch(LegacyMappingDto::executed), "no legacy form retired");
    }

    @Test
    @Order(5)
    @DisplayName("51: a technically valid crop is not a human approval (media not ready, MEDIA_READY false)")
    void technicalCropIsNotApproval() {
        PackageDetailDto d = detail(ETS_T1);
        List<QaEntryDto> crops = d.cropUnits().stream().filter(c -> "TECHNICALLY_VALID".equals(c.technical())).toList();
        assertFalse(crops.isEmpty());
        assertTrue(crops.stream().allMatch(c -> !"APPROVED".equals(c.status())));
        Set<String> cropShas = new HashSet<>();
        crops.forEach(c -> cropShas.add(c.cropSha256()));
        assertTrue(d.media().stream().filter(m -> cropShas.contains(m.sha256().toLowerCase(Locale.ROOT)))
                .noneMatch(MediaAssetDto::ready));
        assertFalse(d.summary().gate().get("MEDIA_READY"));
    }

    @Test
    @Order(6)
    @DisplayName("49/50/67: stale fingerprint refused; valid decision = server reviewer + server time; no silent overwrite; gates unchanged")
    void humanDecisions(@TempDir Path tmp) throws Exception {
        Path ledger = tmp.resolve("approvals.json");
        // a pre-existing human record and an unknown top-level key are preserved byte-for-content
        Map<String, Object> seed = new LinkedHashMap<>();
        seed.put("note", "owner ledger");
        seed.put("decisions", new ArrayList<>(List.of(Map.of("entryId", "OTHER", "decision", "REJECT", "reviewer", "owner",
                "reviewedAt", "2026-10-01T00:00:00Z", "fingerprint", "sha256:abc"))));
        MAPPER.writeValue(ledger.toFile(), seed);
        PackageDetailDto d = detail(ETS_T1);
        QaEntryDto entry = openEntry(d);

        ExamQaDecisionLedger.Rejected stale = assertThrows(ExamQaDecisionLedger.Rejected.class, () -> ExamQaDecisionLedger.record(ledger,
                MAPPER, corpus, new QaDecisionRequest(ETS_T1, entry.entryId(), "APPROVE", "sha256:" + "0".repeat(64), null, null), 1L, NOW));
        assertEquals("QA_FINGERPRINT_STALE", stale.code());
        assertEquals(409, stale.status());
        assertEquals("QA_REVIEWER_REQUIRED", assertThrows(ExamQaDecisionLedger.Rejected.class, () -> ExamQaDecisionLedger.record(ledger,
                MAPPER, corpus, new QaDecisionRequest(ETS_T1, entry.entryId(), "APPROVE", entry.fingerprint(), null, null), null, NOW)).code());
        assertEquals("QA_CORRECTED_VALUE_REQUIRED", assertThrows(ExamQaDecisionLedger.Rejected.class, () -> ExamQaDecisionLedger.record(ledger,
                MAPPER, corpus, new QaDecisionRequest(ETS_T1, entry.entryId(), "CORRECT", entry.fingerprint(), " ", null), 1L, NOW)).code());
        assertEquals("QA_ENTRY_NOT_FOUND", assertThrows(ExamQaDecisionLedger.Rejected.class, () -> ExamQaDecisionLedger.record(ledger,
                MAPPER, corpus, new QaDecisionRequest(ETS_T1, "NOPE-1", "APPROVE", entry.fingerprint(), null, null), 1L, NOW)).code());
        assertEquals(1, ExamQaDecisionLedger.read(ledger, MAPPER).valid().size(), "refusals write nothing");

        QaDecisionReceipt receipt = ExamQaDecisionLedger.record(ledger, MAPPER, corpus,
                new QaDecisionRequest(ETS_T1, entry.entryId(), "APPROVE", entry.fingerprint(), null, "checked against the printed page"), 1L, NOW);
        assertEquals("admin-user:1", receipt.reviewer());
        assertEquals(NOW.toString(), receipt.reviewedAt());
        assertEquals("OPEN", receipt.previousStatus());
        assertEquals(ExamQaDecisionLedger.EFFECT, receipt.effect());
        Map<String, Object> written = MAPPER.readValue(ledger.toFile(), new TypeReference<LinkedHashMap<String, Object>>() {});
        assertEquals("owner ledger", written.get("note"));
        @SuppressWarnings("unchecked") List<Map<String, Object>> recs = (List<Map<String, Object>>) written.get("decisions");
        assertEquals(2, recs.size());
        Map<String, Object> rec = recs.get(1);
        assertEquals(entry.entryId(), rec.get("entryId"));
        assertEquals(entry.fingerprint(), rec.get("fingerprint"));
        assertNull(ExamQaDecisionLedger.problem(rec), "canonical, valid for the QA tooling reader");
        assertEquals("ADMIN_OPERATIONS_CENTER", rec.get("recordedVia"));

        ExamQaDecisionLedger.Rejected dup = assertThrows(ExamQaDecisionLedger.Rejected.class, () -> ExamQaDecisionLedger.record(ledger,
                MAPPER, corpus, new QaDecisionRequest(ETS_T1, entry.entryId(), "REJECT", entry.fingerprint(), null, null), 1L, NOW.plusSeconds(5)));
        assertEquals("QA_DECISION_ALREADY_RECORDED", dup.code(), "no silent overwrite of a current decision");
        assertEquals(2, ((List<?>) MAPPER.readValue(ledger.toFile(), Map.class).get("decisions")).size());

        // the temp decision is not the repository ledger: the canonical gate (built from the QA review report) is unchanged
        ExamStagingCorpus reloaded = ExamStagingCorpus.load(REPO, MAPPER, ExamImportPlanner.StateReader.EMPTY, NOW);
        assertEquals(corpus.gateTotals(), reloaded.gateTotals(), "no approval fabricated, no gate moved by the admin center");
        REPORT.put("decisionDryRun", Map.of("refusals", List.of("QA_FINGERPRINT_STALE", "QA_REVIEWER_REQUIRED", "QA_CORRECTED_VALUE_REQUIRED",
                "QA_ENTRY_NOT_FOUND", "QA_DECISION_ALREADY_RECORDED"), "recorded", 1, "ledger", "TEMP_DIR_ONLY"));
    }

    @Test
    @Order(7)
    @DisplayName("staging practice readiness per scope = Phase 6 readiness (reason codes admin-only)")
    void practiceScopes() {
        PackageDetailDto d = detail(ETS_T1);
        Map<String, PracticeScopeOpsDto> byCode = new HashMap<>();
        d.practiceScopes().forEach(s -> byCode.put(s.scopeCode(), s));
        assertEquals("AVAILABLE", byCode.get("TOEIC_PART_5").learnerState());
        assertEquals("CONTENT_IN_PROGRESS", byCode.get("TOEIC_PART_1").learnerState());
        assertTrue(byCode.get("TOEIC_PART_1").reasonCodes().contains("MEDIA_IMAGE_PENDING"));
    }

    @Test
    @Order(8)
    @DisplayName("media preview returns only hash-verified staged images of the package")
    void mediaPreview() throws Exception {
        PackageDetailDto d = detail(ETS_T1);
        Optional<MediaAssetDto> img = d.media().stream().filter(MediaAssetDto::previewable).findFirst();
        if (img.isPresent()) {
            byte[] bytes = corpus.imageBytes(ETS_T1, img.get().sha256()).orElseThrow();
            assertEquals(img.get().sha256().toLowerCase(Locale.ROOT), ExamStagingCorpus.sha256(bytes));
        }
        assertTrue(corpus.imageBytes(ETS_T1, "0".repeat(64)).isEmpty());
        assertTrue(corpus.imageBytes("toeic/unknown/test-9", "0".repeat(64)).isEmpty());
        Optional<MediaAssetDto> audio = d.media().stream().filter(m -> m.mimeType() != null && m.mimeType().startsWith("audio/")).findFirst();
        audio.ifPresent(a -> assertFalse(a.previewable(), "no audio / raw stream through the preview"));
    }
}
