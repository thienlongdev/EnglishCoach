package com.englishcoach.exams.practice;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageImporter.ImportRightsBasis;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.exception.ExamConcurrencyException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamNotFoundException;
import com.englishcoach.exams.job.ExamJobWorker;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamScoringRecords.ScoreArtifactRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.practice.ExamPracticeRecords.*;
import com.englishcoach.exams.repository.*;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamAttemptSnapshotContent;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamScoreAggregator;
import com.englishcoach.exams.service.*;
import com.englishcoach.exams.validation.ExamAttemptEvidenceBasis;
import com.englishcoach.exams.validation.ExamContentValidationRepository;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy;
import com.englishcoach.common.event.ExamScoredEvent;
import com.englishcoach.proficiency.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Exams Phase 6 — Practice + Review end to end on an isolated PostgreSQL 17 Testcontainer (never the dev or production
 * database): exams migrations V1–V10 + drift shape + V71 + V72 (local), the staged ETS 2026 T1 and Cambridge IELTS 17 T1
 * packages imported with the owner-authorized LOCAL dry-run basis, then the real services: scope catalog → practice
 * attempt (server-resolved scope, scoped snapshot) → untimed start → autosave / resume → submit → raw result → review
 * from the snapshot → Practice Again → Proficiency containment (live listener, nightly reconciliation, backfill) →
 * scoped media grants → LABEL_ASSIGNMENT. Rights: ExamRightsService.ownerAuthorizedLocalRuntime (canonical rights policy over
 * the persisted licence closure + V72 authorization). Test-only content mutations happen ONLY inside this container (marked).
 * Writes imports/exams/staging/reports/phase6_practice_dry_run.json (ids, counts, codes — no exam text).
 * Skips without Docker or without the local staged packages. Needs -Dapi.version=1.44 on this machine.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamPracticePostgresTest {

    private static final Path MIGRATIONS = Path.of("src/main/resources/db/migration/exams");
    private static final Path STAGING = Path.of("..", "imports", "exams", "staging");
    private static final Map<String, String> TARGETS = new LinkedHashMap<>();
    static {
        TARGETS.put("ETS26_T1", "extracted/toeic/ets/ets-2026/ets-2026__test-1.json");
        TARGETS.put("CAM17_T1", "extracted/ielts/cambridge/cambridge-ielts-17/cambridge-ielts-17__test-1.json");
    }
    static final long LEARNER = 101L, OTHER = 102L;

    static PostgreSQLContainer<?> pg;
    static com.zaxxer.hikari.HikariDataSource POOL;
    static JdbcTemplate jdbc;
    static NamedParameterJdbcTemplate named;
    static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    static ExamContentRepository contentRepository;
    static ExamAttemptRepository attemptRepository;
    static ExamScoringRepository scoringRepository;
    static ExamContentValidationService validation;
    static ExamPracticeService practice;
    static ExamAttemptService attempts;
    static ExamResponseService responses;
    static ExamManifestService manifests;
    static ExamMediaService media;
    static final Map<String, UUID> FORMS = new LinkedHashMap<>();
    static final Map<String, Object> REPORT = new LinkedHashMap<>();
    static final Map<String, UUID> ATTEMPTS = new LinkedHashMap<>();

    @BeforeAll
    static void setUp() throws Exception {
        assumeTrue(Files.isDirectory(STAGING.resolve("extracted")), "staged packages not present (local data)");
        Map<String, ExamContentPackage> pkgs = new LinkedHashMap<>();
        for (Map.Entry<String, String> t : TARGETS.entrySet()) {
            assumeTrue(Files.isRegularFile(STAGING.resolve(t.getValue())), "missing " + t.getValue());
            pkgs.put(t.getKey(), MAPPER.readValue(STAGING.resolve(t.getValue()).toFile(), ExamContentPackage.class));
        }
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker not available — Practice dry run skipped");
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        // Exams Phase 9H: pooled (one TCP connection per statement exhausted Windows ephemeral ports in batch runs)
        POOL = com.englishcoach.exams.ExamTestDataSources.pooled(pg);
        javax.sql.DataSource ds = POOL;
        jdbc = new JdbcTemplate(ds);
        named = new NamedParameterJdbcTemplate(ds);
        jdbc.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, email VARCHAR(255)); "
                + "INSERT INTO public.users VALUES (1, 'operator@example.test'), (101, 'learner@example.test'), (102, 'other@example.test');");
        for (String v : List.of("V1__content.sql", "V2__runtime.sql", "V3__scoring_profile.sql", "V4__integrity_operations.sql",
                "V5__content_factory.sql", "V6__exams_measurement_pipeline.sql", "V7__exams_profile_production_eligibility.sql",
                "V8__exams_content_import_compatibility.sql", "V9__exams_form_components_role_expansion.sql",
                "V10__exams_runtime_v4_turns_and_evidence.sql")) {
            jdbc.execute(Files.readString(MIGRATIONS.resolve(v)));
        }
        jdbc.execute("ALTER TABLE exams.sections ADD COLUMN is_runnable BOOLEAN; "
                + "ALTER TABLE exams.sections ADD COLUMN health_status VARCHAR(32); "
                + "ALTER TABLE exams.form_versions ADD COLUMN primary_health_status VARCHAR(32); "
                + "ALTER TABLE exams.item_versions ADD COLUMN ordinal INTEGER;");
        jdbc.execute(Files.readString(MIGRATIONS.resolve("V71__exams_content_validation_truth.sql")));
        jdbc.execute(Files.readString(MIGRATIONS.resolve("V72__exams_project_usage_authorization.sql")));

        contentRepository = new ExamContentRepository(named, MAPPER);
        attemptRepository = new ExamAttemptRepository(named, MAPPER);
        scoringRepository = new ExamScoringRepository(named, MAPPER);
        ExamMediaRepository mediaRepository = new ExamMediaRepository(named, MAPPER);
        StaticListableBeanFactory beans = new StaticListableBeanFactory(Map.of("tm", new DataSourceTransactionManager(ds)));
        ExamContentValidationRepository treeRepository = new ExamContentValidationRepository(named, MAPPER);
        validation = new ExamContentValidationService(treeRepository, MAPPER, beans.getBeanProvider(PlatformTransactionManager.class));
        ExamContentPackageImporter importer = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(MAPPER));
        importer.setValidationService(validation);
        importer.setOwnerAuthorizedDryRunEnabled(true);
        for (Map.Entry<String, ExamContentPackage> e : pkgs.entrySet()) {
            ExamContentPackage.ImportResult r = importer.importPackage(e.getValue(), 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN);
            FORMS.put(e.getKey(), r.formId());
            jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'PILOT' WHERE id = ?", r.formId());
            validation.invalidate(r.formId());
        }
        manifests = new ExamManifestService(contentRepository, attemptRepository);
        ExamsProperties props = new ExamsProperties();
        // the runtime counterpart of the LOCAL dry-run import basis above (trusted test wiring; never Spring / a request)
        ExamRightsService rights = ExamRightsService.ownerAuthorizedLocalRuntime(contentRepository, mediaRepository, props);
        ExamObjectiveScorer scorer = new ExamObjectiveScorer(new ExamAnswerNormalizer());
        practice = new ExamPracticeService(contentRepository, attemptRepository, validation, treeRepository, rights, manifests,
                scorer, MAPPER);
        ExamTimingService timing = new ExamTimingService(attemptRepository, contentRepository);
        attempts = new ExamAttemptService(attemptRepository, contentRepository, rights, timing, manifests);
        ExamJobWorker worker = new ExamJobWorker(scoringRepository, attemptRepository, contentRepository,
                new ExamProfileRepository(named, MAPPER), scorer, new ExamScoreAggregator(), null, null, props);
        responses = new ExamResponseService(attemptRepository, scoringRepository, contentRepository, worker);
        media = new ExamMediaService(mediaRepository, attemptRepository, rights, mock(ExamObjectStorage.class));
    }

    @AfterAll
    static void tearDown() throws Exception {
        if (pg != null) {
            if (POOL != null) POOL.close();
            pg.stop();
            REPORT.put("generatedBy", "ExamPracticePostgresTest (Exams Recovery Phase 6, isolated PostgreSQL 17)");
            MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT)
                    .writeValue(STAGING.resolve("reports").resolve("phase6_practice_dry_run.json").toFile(), REPORT);
        }
    }

    // ─── helpers ───────────────────────────────────────────────────────────────────────────

    static PracticeAttemptDto create(String form, String scope, long user) {
        return practice.createPracticeAttempt(user, new CreatePracticeAttemptRequest(FORMS.get(form), scope, null));
    }

    static AttemptRecord attempt(UUID id) {
        return attemptRepository.findAttemptById(id).orElseThrow();
    }

    static AttemptStateDto start(UUID attemptId, long user) {
        attempts.markReady(user, attemptId);
        return attempts.startAttempt(user, attemptId, "test-session");
    }

    /** itemId → placementId of the learner manifest. */
    static Map<UUID, String> placements(UUID attemptId, long user) {
        Map<UUID, String> out = new LinkedHashMap<>();
        PublicAttemptManifestDto m = attempts.getAttemptManifest(user, attemptId);
        for (PublicSectionDto s : m.sections()) for (PublicPartDto p : s.parts()) for (PublicGroupDto g : p.groups())
            for (PublicItemDto it : g.items()) out.put(it.id(), it.placementId());
        return out;
    }

    static List<ExamAttemptSnapshotContent.SnapshotItem> items(UUID attemptId) {
        return ExamAttemptSnapshotContent.parse(attempt(attemptId).manifestSnapshot()).orElseThrow().allItems();
    }

    @SuppressWarnings("unchecked")
    static String key(ExamAttemptSnapshotContent.SnapshotItem it) {
        Map<String, Object> acc = it.answerSpec().acceptedAnswers();
        if (acc.get("unorderedSet") instanceof Map<?, ?> set) return String.valueOf(((List<Object>) set.get("values")).get(0));
        return ExamObjectiveScorer.nonBlankAccepted(acc).get(0);
    }

    static String wrongLetter(String key) {
        for (String l : List.of("A", "B", "C", "D")) if (!l.equalsIgnoreCase(key)) return l;
        return "Z";
    }

    static void save(UUID attemptId, long user, Map<String, String> answers) {
        List<ResponseItemCommand> cmds = new ArrayList<>();
        answers.forEach((pid, v) -> cmds.add(new ResponseItemCommand(pid, null, Map.of("value", v), v, null, false, null)));
        responses.saveResponseBatch(user, attemptId, new SaveResponseBatchRequest(null, attempt(attemptId).revision(), cmds));
    }

    static UUID submit(UUID attemptId, long user) {
        return responses.submitAttempt(user, attemptId,
                new SubmitAttemptRequest("submit-" + attemptId, attempt(attemptId).revision(), SubmissionReason.MANUAL, List.of()));
    }

    static int count(String sql, Object... args) {
        return jdbc.queryForObject(sql, Integer.class, args);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> row(String key) {
        return (Map<String, Object>) REPORT.computeIfAbsent(key, k -> new LinkedHashMap<String, Object>());
    }

    // ─── tests ─────────────────────────────────────────────────────────────────────────────

    @Test
    @Order(1)
    @DisplayName("catalog: scope readiness per part on the real staged corpus; learner DTO carries no reason codes")
    void catalog() throws Exception {
        for (String form : TARGETS.keySet()) {
            PracticeCatalogDto cat = practice.getCatalog(FORMS.get(form));
            List<PracticeScopeDiagnosticDto> diag = practice.getDiagnostics(FORMS.get(form));
            String json = MAPPER.writeValueAsString(cat);
            assertFalse(json.contains("reasonCodes") || json.contains("MEDIA_") || json.contains("VALIDATION_"),
                    "learner DTO must not carry internal codes");
            Map<String, Object> scopes = new LinkedHashMap<>();
            for (PracticeScopeDiagnosticDto d : diag) {
                scopes.put(d.scopeCode(), Map.of("availability", d.learnerAvailability(), "questions", d.questionCount(),
                        "reasonCodes", d.reasonCodes()));
                if (d.ready()) assertEquals("AVAILABLE", d.learnerAvailability());
                if (!d.ready() && d.reasonCodes().equals(List.of("MEDIA_IMAGE_PENDING"))) {
                    assertEquals("CONTENT_IN_PROGRESS", d.learnerAvailability(), d.scopeCode());
                }
            }
            row(form).put("scopes", scopes);
        }
        Map<String, PracticeScopeDiagnosticDto> ets = byCode(FORMS.get("ETS26_T1"));
        assertEquals(List.of("MEDIA_IMAGE_PENDING"), ets.get("TOEIC_PART_1").reasonCodes(),
                "Part 1 photos still await the owner's crop approval: not practisable, no approval fabricated");
        // the staged ETS 2026 Test 1 package (re-extracted 2026-10-07 under the owner's independent-Part release policy)
        // carries Parts 1–6 only: Part 7 is checked when, and only when, the staged package has it
        for (String code : List.of("TOEIC_PART_2", "TOEIC_PART_5", "TOEIC_PART_6")) {
            assertTrue(ets.get(code).ready(), code + " " + ets.get(code).reasonCodes());
        }
        if (ets.containsKey("TOEIC_PART_7")) assertTrue(ets.get("TOEIC_PART_7").ready(), ets.get("TOEIC_PART_7").reasonCodes().toString());
        Map<String, PracticeScopeDiagnosticDto> cam = byCode(FORMS.get("CAM17_T1"));
        for (String code : List.of("IELTS_LISTENING_SECTION_1", "IELTS_LISTENING_SECTION_2", "IELTS_LISTENING_SECTION_3",
                "IELTS_LISTENING_SECTION_4", "IELTS_READING_PASSAGE_1", "IELTS_READING_PASSAGE_2", "IELTS_READING_PASSAGE_3",
                "IELTS_WRITING_TASK_2")) {
            assertTrue(cam.get(code).ready(), code + " " + cam.get(code).reasonCodes());
        }
        assertEquals("CONTENT_IN_PROGRESS", cam.get("IELTS_WRITING_TASK_1").learnerAvailability(),
                "Task 1 visual awaits crop approval");
        assertTrue(cam.keySet().stream().anyMatch(c -> c.contains("SPEAKING")));
        assertTrue(cam.values().stream().filter(s -> s.scopeType().equals("IELTS_SPEAKING_PART"))
                .allMatch(s -> s.objectiveItemCount() == 0));
    }

    static Map<String, PracticeScopeDiagnosticDto> byCode(UUID formId) {
        Map<String, PracticeScopeDiagnosticDto> out = new LinkedHashMap<>();
        for (PracticeScopeDiagnosticDto d : practice.getDiagnostics(formId)) out.put(d.scopeCode(), d);
        return out;
    }

    @Test
    @Order(20)
    void originalPilotBankUsesCanonicalImportAndIsIdempotent() throws Exception {
        var importer = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(MAPPER));
        importer.setValidationService(validation);
        var bank = new com.englishcoach.exams.content.ExamOriginalPracticeBootstrapService(
                MAPPER, importer, contentRepository, practice, new ExamsProperties());
        var predecessor = MAPPER.readValue(getClass().getResourceAsStream(
                "/exams/original-practice/EC_ORIGINAL_TOEIC_LR_PRACTICE_20261006.json"), ExamContentPackage.class);
        importer.importPackage(predecessor, 1L);
        contentRepository.updateFormLifecycle(predecessor.form().id(), LifecycleState.PILOT, null, null);
        var oldAttempt = practice.createPracticeAttempt(LEARNER,
                new CreatePracticeAttemptRequest(predecessor.form().id(), "TOEIC_PART_7", null));
        var oldSnapshot = MAPPER.writeValueAsString(attempt(oldAttempt.attemptId()).manifestSnapshot());
        var first = bank.bootstrap(1L);
        assertEquals(6, first.size());
        for (var imported : first) {
            assertEquals(LifecycleState.PILOT, contentRepository.findFormById(imported.formId()).orElseThrow().lifecycleState());
            assertTrue(practice.evaluateForm(imported.formId()).scopes().stream().allMatch(s -> s.ready()));
        }
        var second = bank.bootstrap(1L);
        assertTrue(second.stream().allMatch(r -> r.status() == ExamContentPackage.ImportStatus.ALREADY_IMPORTED));
        assertEquals(LifecycleState.RETIRED, contentRepository.findFormById(predecessor.form().id()).orElseThrow().lifecycleState());
        assertEquals(predecessor.form().id(), attempt(oldAttempt.attemptId()).formId());
        assertEquals(oldSnapshot, MAPPER.writeValueAsString(attempt(oldAttempt.attemptId()).manifestSnapshot()));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM exams.audit_events WHERE action = 'ORIGINAL_PRACTICE_SUPERSEDED'", Integer.class));
        var strict = new ExamsProperties(); strict.setStrictMode(true);
        var forbidden = new com.englishcoach.exams.content.ExamOriginalPracticeBootstrapService(
                MAPPER, importer, contentRepository, practice, strict);
        assertThrows(IllegalStateException.class, () -> forbidden.bootstrap(1L));
    }

    @Test
    @Order(2)
    @DisplayName("02/05/06/07/10/11/13/17: practice attempt pins ONLY the selected part; runner payload has no keys / source metadata")
    @SuppressWarnings("unchecked")
    void scopedSnapshotAndManifest() throws Exception {
        List<String[]> targets = new ArrayList<>(List.of(new String[]{"ETS26_T1", "TOEIC_PART_2"}, new String[]{"ETS26_T1", "TOEIC_PART_5"},
                new String[]{"ETS26_T1", "TOEIC_PART_6"},
                new String[]{"CAM17_T1", "IELTS_LISTENING_SECTION_1"}, new String[]{"CAM17_T1", "IELTS_READING_PASSAGE_2"},
                new String[]{"CAM17_T1", "IELTS_WRITING_TASK_2"}));
        // Part 7 (multi-document sets) only when the staged package still has it (see catalog())
        if (byCode(FORMS.get("ETS26_T1")).containsKey("TOEIC_PART_7")) targets.add(3, new String[]{"ETS26_T1", "TOEIC_PART_7"});
        for (String[] t : targets) {
            PracticeAttemptDto dto = create(t[0], t[1], LEARNER);
            ATTEMPTS.put(t[1], dto.attemptId());
            AttemptRecord a = attempt(dto.attemptId());
            assertEquals(ExamAttemptMode.PRACTICE, a.attemptMode());
            assertEquals(ExamSnapshotState.SNAPSHOTTED, a.snapshotState());
            Map<String, Object> scope = ExamPracticeScope.pinned(a.manifestSnapshot()).orElseThrow();
            assertEquals(t[1], scope.get("scopeCode"));
            assertEquals("UNTIMED", scope.get("timingMode"));
            List<Map<String, Object>> sections = (List<Map<String, Object>>) a.manifestSnapshot().get("sections");
            assertEquals(1, sections.size(), "only the scope's section");
            List<Map<String, Object>> parts = (List<Map<String, Object>>) sections.get(0).get("parts");
            assertEquals(1, parts.size(), "only the scope's part");
            assertEquals(scope.get("partCode"), parts.get(0).get("partCode"));
            PracticeScopeDiagnosticDto d = byCode(FORMS.get(t[0])).get(t[1]);
            assertEquals(d.groupCount(), ((List<?>) parts.get(0).get("groups")).size(), "every group of the part, nothing else");
            assertEquals(d.questionCount(), items(dto.attemptId()).size());
            assertEquals(ExamManifestService.canonicalHash(withoutBasis(a.manifestSnapshot())), a.pinnedManifestHash(),
                    "pinned hash covers the scoped snapshot incl. the scope");
            Map<String, Object> basis = (Map<String, Object>) a.manifestSnapshot().get(ExamAttemptEvidenceBasis.SNAPSHOT_KEY);
            assertEquals(List.of(), basis.get("evidenceSkills"), "PRACTICE pins no evidence skill");

            PublicAttemptManifestDto m = attempts.getAttemptManifest(LEARNER, dto.attemptId());
            assertEquals("PRACTICE_SCOPE", m.manifestScope());
            assertEquals(t[1], m.practiceScope().get("scopeCode"));
            String json = MAPPER.writeValueAsString(m);
            for (String forbidden : List.of("acceptedAnswers", "answerSpec", "keySource", "sourcePages", "sourcePage",
                    "mappingConfidence", "sourceRole", "rendering", "transcriptAvailable", "explanation")) {
                assertFalse(json.contains("\"" + forbidden + "\""), t[1] + ": runner payload leaks " + forbidden);
            }
            if (t[1].equals("TOEIC_PART_2")) {
                for (PublicGroupDto g : m.sections().get(0).parts().get(0).groups())
                    for (PublicItemDto it : g.items())
                        assertEquals(3, ((List<?>) it.optionDefinitions().get("options")).size(), "Part 2 keeps A–C");
            }
            if (t[1].equals("TOEIC_PART_7")) {
                long multi = m.sections().get(0).parts().get(0).groups().stream()
                        .filter(g -> g.stimuli().stream().anyMatch(s -> "MULTI_DOC".equals(s.kind()))).count();
                assertTrue(multi >= 5, "double / triple passage sets stay grouped documents (" + multi + ")");
                row("ETS26_T1").put("part7", Map.of("groups", d.groupCount(), "multiDocGroups", multi, "items", d.questionCount()));
            }
            row(t[0]).put("attempt:" + t[1], Map.of("sections", 1, "parts", 1, "groups", d.groupCount(), "items", d.questionCount()));
        }
    }

    static Map<String, Object> withoutBasis(Map<String, Object> snapshot) {
        Map<String, Object> copy = new LinkedHashMap<>(snapshot);
        copy.remove(ExamAttemptEvidenceBasis.SNAPSHOT_KEY);
        return copy;
    }

    @Test
    @Order(3)
    @DisplayName("14/16: unavailable scope, unknown scope, malformed scope and injected placements are refused server-side")
    void refusals() {
        assertThrows(ExamPracticeService.ScopeUnavailableException.class, () -> create("ETS26_T1", "TOEIC_PART_1", LEARNER));
        assertThrows(ExamNotFoundException.class, () -> create("ETS26_T1", "TOEIC_PART_9", LEARNER));
        assertThrows(IllegalArgumentException.class, () -> create("ETS26_T1", "part5'; drop", LEARNER));
        assertThrows(ExamNotFoundException.class, () -> practice.createPracticeAttempt(LEARNER,
                new CreatePracticeAttemptRequest(UUID.randomUUID(), "TOEIC_PART_5", null)));

        UUID part5 = ATTEMPTS.get("TOEIC_PART_5");
        start(part5, LEARNER);
        UUID part6 = ATTEMPTS.get("TOEIC_PART_6");
        String foreignPlacement = placements(part6, LEARNER).values().iterator().next();
        ExamConcurrencyException ex = assertThrows(ExamConcurrencyException.class,
                () -> save(part5, LEARNER, Map.of(foreignPlacement, "A")));
        assertEquals("PLACEMENT_NOT_IN_SCOPE", ex.getCode(), "a placement of another part of the SAME form is refused");
        assertEquals("PLACEMENT_NOT_IN_SCOPE", assertThrows(ExamConcurrencyException.class,
                () -> save(part5, LEARNER, Map.of("p_READING_PART_5_g_x_i_999", "A"))).getCode());
        assertEquals("PLACEMENT_NOT_IN_SCOPE", assertThrows(ExamConcurrencyException.class,
                () -> responses.submitAttempt(LEARNER, part5, new SubmitAttemptRequest("inject", attempt(part5).revision(),
                        SubmissionReason.MANUAL, List.of(new ResponseItemCommand(foreignPlacement, null, Map.of("value", "A"), "A",
                        null, false, null))))).getCode());
        assertEquals(ExamAttemptStatus.IN_PROGRESS, attempt(part5).status(), "refused submit changed nothing");
        row("security").put("injection", "PLACEMENT_NOT_IN_SCOPE on save + submit; unknown scope 404; unavailable scope 409");
    }

    @Test
    @Order(4)
    @DisplayName("18/19/22-untimed: untimed start, autosave + resume; a new attempt never sees another attempt's answers")
    void autosaveResume() {
        UUID part5 = ATTEMPTS.get("TOEIC_PART_5");
        AttemptRecord a = attempt(part5);
        assertNull(a.scheduledEndAt(), "untimed practice: no scheduled end");
        AttemptStateDto state = attempts.getAttemptState(LEARNER, part5);
        assertEquals(1, state.sections().size());
        assertNull(state.sections().get(0).deadlineAt(), "untimed practice: no section deadline");
        assertNull(state.sections().get(0).remainingSeconds());

        List<ExamAttemptSnapshotContent.SnapshotItem> its = items(part5);
        Map<UUID, String> pl = placements(part5, LEARNER);
        Map<String, String> answers = new LinkedHashMap<>();
        for (int i = 0; i < 15; i++) {
            ExamAttemptSnapshotContent.SnapshotItem it = its.get(i);
            answers.put(pl.get(it.itemId()), i < 10 ? key(it) : wrongLetter(key(it)));
        }
        save(part5, LEARNER, answers);
        AttemptStateDto resumed = attempts.getAttemptState(LEARNER, part5);
        assertEquals(15, resumed.responses().size(), "answers restored on resume");
        assertEquals(answers.keySet(), resumed.responses().keySet());

        PracticeAttemptDto parallel = create("ETS26_T1", "TOEIC_PART_5", LEARNER);
        start(parallel.attemptId(), LEARNER);
        assertTrue(attempts.getAttemptState(LEARNER, parallel.attemptId()).responses().isEmpty(),
                "another attempt of the same scope starts clean (attempt-scoped state)");
        ATTEMPTS.put("PARALLEL_PART5", parallel.attemptId());
    }

    @Test
    @Order(5)
    @DisplayName("20–24/25: submit → raw counts + accuracy; no TOEIC scale / IELTS band component; zero official evidence")
    void submitRawMetrics() {
        UUID part5 = ATTEMPTS.get("TOEIC_PART_5");
        UUID submissionId = submit(part5, LEARNER);
        PracticeResultDto r = practice.getResult(LEARNER, part5);
        assertEquals("SUBMITTED", r.completionStatus());
        assertEquals(10, r.correct());
        assertEquals(5, r.incorrect());
        assertEquals(15, r.unanswered());
        assertEquals(15, r.answered());
        assertEquals(30, r.total());
        assertEquals(33.3, r.rawAccuracyPercent());
        assertFalse(r.standardizedScoreAvailable());
        assertTrue(r.reviewAvailable());

        ScoreArtifactRecord art = scoringRepository.findLatestArtifactBySubmissionId(submissionId).orElseThrow();
        assertTrue(scoringRepository.findComponentsByArtifactId(art.id()).isEmpty(),
                "no scaled component (no TOEIC 5–495 / 10–990, no band) for a part");
        assertTrue(art.versionBundle().get("practiceRawScores") instanceof Map<?, ?>, "raw metrics recorded");
        assertEquals(0, count("SELECT COUNT(*) FROM exams.jobs j JOIN exams.submissions s ON s.id = j.submission_id WHERE s.attempt_id = ?",
                part5), "no AI scoring job");

        UUID listening = ATTEMPTS.get("IELTS_LISTENING_SECTION_1");
        start(listening, LEARNER);
        Map<UUID, String> pl = placements(listening, LEARNER);
        Map<String, String> answers = new LinkedHashMap<>();
        for (ExamAttemptSnapshotContent.SnapshotItem it : items(listening)) answers.put(pl.get(it.itemId()), key(it));
        save(listening, LEARNER, answers);
        UUID lsub = submit(listening, LEARNER);
        PracticeResultDto lr = practice.getResult(LEARNER, listening);
        assertEquals(lr.total(), lr.correct(), "all keys entered ⇒ all correct");
        assertEquals(100.0, lr.rawAccuracyPercent());
        ScoreArtifactRecord lart = scoringRepository.findLatestArtifactBySubmissionId(lsub).orElseThrow();
        assertTrue(scoringRepository.findComponentsByArtifactId(lart.id()).isEmpty(), "10/10 is NOT an IELTS band");
        assertEquals(0, count("SELECT COUNT(*) FROM exams.profile_evidence"), "practice ⇒ zero official evidence");
        row("ETS26_T1").put("resultPart5", Map.of("correct", 10, "incorrect", 5, "unanswered", 15, "total", 30,
                "rawAccuracyPercent", 33.3, "scaledComponents", 0));
        row("CAM17_T1").put("resultListening1", Map.of("correct", lr.correct(), "total", lr.total(), "bandComponents", 0));
    }

    @Test
    @Order(6)
    @DisplayName("25–28: zero official proficiency evidence through live listener, nightly reconciliation and backfill")
    void proficiencyContainment() {
        ProficiencySourceReadRepository sources = new ProficiencySourceReadRepository(named);
        RatingConverter converter = mock(RatingConverter.class);
        when(converter.interpolate(anyString(), anyDouble())).thenReturn(Optional.of(600));
        ProficiencyService service = mock(ProficiencyService.class);
        when(service.storeEvidence(anyList())).thenAnswer(inv -> inv.getArgument(0));
        ProficiencyProperties props = new ProficiencyProperties();
        EvidenceMapper mapper = new EvidenceMapper(props, sources, converter);
        ProficiencyIngestService ingest = new ProficiencyIngestService(props, mapper, service, sources);

        int artifacts = 0;
        for (String scope : List.of("TOEIC_PART_5", "IELTS_LISTENING_SECTION_1")) {
            UUID attemptId = ATTEMPTS.get(scope);
            AttemptRecord a = attempt(attemptId);
            SubmissionRecord sub = attemptRepository.findSubmissionByAttemptId(attemptId).orElseThrow();
            ScoreArtifactRecord art = scoringRepository.findLatestArtifactBySubmissionId(sub.id()).orElseThrow();
            assertTrue(mapper.fromExamArtifact(art.id()).isEmpty(), scope + ": mapper");
            assertTrue(ingest.ingestExam(new ExamScoredEvent(LEARNER, attemptId, sub.id(), art.id(), 1, a.formId(),
                    a.family().name(), a.variant(), a.scope(), a.attemptMode().name(), "COMPLETED", new HashMap<>(), Instant.now()))
                    .isEmpty(), scope + ": live listener");
            ExamAttemptEvidenceBasis.Resolution basis = ExamAttemptEvidenceBasis.resolveFromSnapshot(a.snapshotState(),
                    a.manifestSnapshot(), a.formId(), a.attemptMode().name());
            assertEquals(ExamEvidenceEligibilityPolicy.Reason.PRACTICE_MODE, ExamEvidenceEligibilityPolicy.decide("PRACTICE",
                    "COMPLETED", "READING", 7.0, false, basis).reason());
            artifacts++;
        }
        assertEquals(0, ingest.reconcileT1(Instant.now().minusSeconds(86_400)), "nightly reconciliation");
        assertEquals(0, ingest.reconcileT1(null), "backfill (ProficiencyBackfillRunner path)");
        verify(service, never()).storeEvidence(anyList());
        verify(service, never()).recompute(anyLong(), any(), any());
        assertEquals(0, count("SELECT COUNT(*) FROM exams.profile_evidence"));
        row("containment").put("practiceArtifacts", artifacts);
        row("containment").put("evidenceRows", Map.of("directSubmit", 0, "worker", 0, "liveListener", 0, "reconciliation", 0, "backfill", 0));
    }

    @Test
    @Order(7)
    @DisplayName("29–35: review from the snapshot only, owner-only, after submission; content edited later never changes it")
    void review() throws Exception {
        UUID part5 = ATTEMPTS.get("TOEIC_PART_5");
        PracticeReviewDto before = practice.getReview(LEARNER, part5);
        assertEquals("ATTEMPT_SNAPSHOT", before.contentBasis());
        List<ReviewItemDto> its = before.groups().stream().flatMap(g -> g.items().stream()).toList();
        assertEquals(30, its.size());
        assertEquals(10, its.stream().filter(i -> "CORRECT".equals(i.status())).count());
        assertEquals(5, its.stream().filter(i -> "INCORRECT".equals(i.status())).count());
        assertEquals(15, its.stream().filter(i -> "UNANSWERED".equals(i.status())).count());
        ReviewItemDto firstWrong = its.stream().filter(i -> "INCORRECT".equals(i.status())).findFirst().orElseThrow();
        assertNotEquals(firstWrong.correctAnswers().get(0), firstWrong.learnerAnswer(), "learner answer vs correct answer");
        assertTrue(firstWrong.correctAnswerAvailable());
        assertFalse(firstWrong.explanationAvailable(), "no curated explanation in the corpus ⇒ none shown, none generated");
        assertFalse(firstWrong.aiAssistAvailable());
        String json = MAPPER.writeValueAsString(before);
        for (String forbidden : List.of("keySource", "sourcePages", "sourcePage", "rawManifestRef", "fingerprint", "policy")) {
            assertFalse(json.contains("\"" + forbidden + "\""), "review leaks " + forbidden);
        }

        // live content edited after submission (TEST-ONLY, in-container): a different valid key + a changed prompt
        ExamAttemptSnapshotContent.SnapshotItem edited = items(part5).get(0);
        String oldKey = key(edited);
        jdbc.update("UPDATE exams.answer_specs SET accepted_answers = jsonb_set(accepted_answers, '{values}', to_jsonb(ARRAY[?]::text[])) "
                + "WHERE item_id = ?", wrongLetter(oldKey), edited.itemId());
        jdbc.update("UPDATE exams.item_versions SET prompt = prompt || ' (edited)' WHERE id = ?", edited.itemId());
        validation.invalidate(FORMS.get("ETS26_T1"));
        PracticeReviewDto after = practice.getReview(LEARNER, part5);
        assertEquals(MAPPER.writeValueAsString(before), MAPPER.writeValueAsString(after), "review = the attempt snapshot, unchanged");

        // before submission: no answers disclosed
        IllegalStateException early = assertThrows(IllegalStateException.class,
                () -> practice.getReview(LEARNER, ATTEMPTS.get("PARALLEL_PART5")));
        assertTrue(early.getMessage().startsWith(ExamPracticeService.REVIEW_NOT_AVAILABLE_CODE));
        assertFalse(practice.getResult(LEARNER, ATTEMPTS.get("PARALLEL_PART5")).reviewAvailable());
        assertNull(practice.getResult(LEARNER, ATTEMPTS.get("PARALLEL_PART5")).correct(), "no metrics before submission");

        // another learner: indistinguishable from a missing attempt
        assertThrows(ExamNotFoundException.class, () -> practice.getReview(OTHER, part5));
        assertThrows(ExamNotFoundException.class, () -> practice.getResult(OTHER, part5));
        assertThrows(ExamNotFoundException.class, () -> practice.practiceAgain(OTHER, part5, null));
        assertThrows(ExamNotFoundException.class, () -> practice.getReview(LEARNER, UUID.randomUUID()));
        row("security").put("crossUser", "result / review / practice again of another learner ⇒ 404 (ExamNotFoundException)");
        row("review").put("snapshotStableAfterLiveEdit", true);
    }

    @Test
    @Order(8)
    @DisplayName("36/37: Practice Again creates a NEW attempt on the same pinned form version; the old one is immutable")
    void practiceAgain() {
        UUID old = ATTEMPTS.get("TOEIC_PART_5");
        AttemptRecord oldBefore = attempt(old);
        int oldResponses = attemptRepository.findResponsesByAttemptId(old).size();
        PracticeAttemptDto next = practice.practiceAgain(LEARNER, old, "again-1");
        assertNotEquals(old, next.attemptId());
        assertEquals(oldBefore.formId(), next.formId(), "same pinned form version (never silently a successor)");
        assertEquals(old, next.practiceAgainOf());
        assertEquals(old.toString(), ExamPracticeScope.pinned(attempt(next.attemptId()).manifestSnapshot()).orElseThrow()
                .get("practiceAgainOf"));
        assertTrue(attemptRepository.findResponsesByAttemptId(next.attemptId()).isEmpty());
        PracticeAttemptDto replay = practice.practiceAgain(LEARNER, old, "again-1");
        assertTrue(replay.resumedExisting(), "same client mutation id ⇒ same attempt");
        assertEquals(next.attemptId(), replay.attemptId());

        AttemptRecord oldAfter = attempt(old);
        assertEquals(oldBefore.status(), oldAfter.status());
        assertEquals(oldBefore.pinnedManifestHash(), oldAfter.pinnedManifestHash());
        assertEquals(oldBefore.manifestSnapshot(), oldAfter.manifestSnapshot());
        assertEquals(oldResponses, attemptRepository.findResponsesByAttemptId(old).size());

        IllegalStateException inProgress = assertThrows(IllegalStateException.class,
                () -> practice.practiceAgain(LEARNER, ATTEMPTS.get("PARALLEL_PART5"), null));
        assertTrue(inProgress.getMessage().startsWith(ExamPracticeService.IN_PROGRESS_CODE));
        row("practiceAgain").put("newAttempt", true);
        row("practiceAgain").put("oldAttemptUnchanged", true);
    }

    @Test
    @Order(9)
    @DisplayName("38: media grants are limited to the practice scope's own assets")
    void scopedGrants() {
        UUID listening = ATTEMPTS.get("IELTS_LISTENING_SECTION_1");
        Map<String, Object> scope = ExamPracticeScope.pinned(attempt(listening).manifestSnapshot()).orElseThrow();
        UUID own = UUID.fromString(String.valueOf(((List<?>) scope.get("mediaAssetIds")).get(0)));
        assertNotNull(media.createPlaybackGrant(LEARNER, listening, own, MediaPurpose.SIMULATION_LISTENING).mediaStreamUrl());

        PracticeAttemptDto s2 = create("CAM17_T1", "IELTS_LISTENING_SECTION_2", LEARNER);
        UUID otherPart = UUID.fromString(String.valueOf(((List<?>) ExamPracticeScope.pinned(attempt(s2.attemptId()).manifestSnapshot())
                .orElseThrow().get("mediaAssetIds")).get(0)));
        IllegalStateException refused = assertThrows(IllegalStateException.class,
                () -> media.createPlaybackGrant(LEARNER, listening, otherPart, MediaPurpose.SIMULATION_LISTENING));
        assertTrue(refused.getMessage().startsWith("ASSET_NOT_IN_ATTEMPT_SCOPE"));
        assertThrows(IllegalArgumentException.class,
                () -> media.createPlaybackGrant(OTHER, listening, own, MediaPurpose.SIMULATION_LISTENING), "foreign attempt");
        row("security").put("grants", "own scope asset granted; another part's asset refused; foreign attempt refused");
    }

    @Test
    @Order(10)
    @DisplayName("12/13: writing task practice keeps the response; no AI call, no band, no heuristic score")
    void writingPractice() {
        UUID w = ATTEMPTS.get("IELTS_WRITING_TASK_2");
        start(w, LEARNER);
        String pid = placements(w, LEARNER).values().iterator().next();
        String essay = "synthetic practice response ".repeat(40).trim();
        save(w, LEARNER, Map.of(pid, essay));
        UUID sub = submit(w, LEARNER);
        PracticeResultDto r = practice.getResult(LEARNER, w);
        assertEquals("RESPONSE_ONLY", r.scoringMode());
        assertEquals(120, r.wordCount());
        assertEquals("NOT_SCORED", r.writingAssessment());
        assertNull(r.correct());
        assertFalse(r.standardizedScoreAvailable());
        assertEquals(0, count("SELECT COUNT(*) FROM exams.jobs WHERE submission_id = ?", sub), "no AI scoring job queued");
        ScoreArtifactRecord art = scoringRepository.findLatestArtifactBySubmissionId(sub).orElseThrow();
        assertTrue(scoringRepository.findComponentsByArtifactId(art.id()).isEmpty(), "no writing band");
        PracticeReviewDto rv = practice.getReview(LEARNER, w);
        ReviewItemDto item = rv.groups().get(0).items().get(0);
        assertEquals("NOT_SCORED", item.status());
        assertEquals(essay, item.learnerAnswer());
        assertTrue(item.correctAnswers().isEmpty());
        assertFalse(item.correctAnswerAvailable());
        assertFalse(item.explanationAvailable());
        assertEquals(0, count("SELECT COUNT(*) FROM exams.profile_evidence"));
        row("CAM17_T1").put("writingTask2", Map.of("wordCount", r.wordCount(), "assessment", "NOT_SCORED", "aiJobs", 0, "components", 0));
    }

    @Test
    @Order(11)
    @DisplayName("47–53: LABEL_ASSIGNMENT end to end (TEST-ONLY in-container re-typing of a lettered matching group + figure)")
    @SuppressWarnings("unchecked")
    void labelAssignment() throws Exception {
        UUID form = FORMS.get("CAM17_T1");
        UUID group = jdbc.queryForObject("SELECT iv.group_id FROM exams.item_versions iv JOIN exams.form_groups fg ON fg.group_id = iv.group_id "
                + "JOIN exams.parts p ON p.id = fg.part_id JOIN exams.sections s ON s.id = p.section_id "
                + "WHERE s.form_id = ? AND p.part_code = 'LISTENING_PART_3' AND iv.interaction_type = 'MATCHING' LIMIT 1", UUID.class, form);
        UUID prov = jdbc.queryForObject("SELECT provenance_id FROM exams.form_versions WHERE id = ?", UUID.class, form);
        UUID stim = UUID.randomUUID(), asset = UUID.randomUUID();
        jdbc.update("UPDATE exams.item_versions SET interaction_type = 'LABEL_ASSIGNMENT' WHERE group_id = ?", group);
        jdbc.update("INSERT INTO exams.stimulus_versions (id, logical_stimulus_key, version, kind, title, body_payload, provenance_id, content_hash) "
                + "VALUES (?, ?, 1, 'MAP', 'synthetic map', '{\"altText\":\"synthetic map\",\"sourcePage\":7}'::jsonb, ?, 'h')",
                stim, "test-map-" + stim, prov);
        jdbc.update("INSERT INTO exams.assets (id, provenance_id, object_key, version_id, sha256_hash, mime_type, byte_size, validation_state) "
                + "VALUES (?, ?, ?, 'v1', ?, 'image/png', 10, 'VALIDATED')", asset, prov, "sha256/test-map-" + asset, "0".repeat(64));
        jdbc.update("INSERT INTO exams.stimulus_assets (stimulus_id, asset_id, role, ordinal) VALUES (?, ?, 'VISIBLE_MEDIA', 0)", stim, asset);
        jdbc.update("INSERT INTO exams.group_stimuli (group_id, stimulus_id, role, ordinal) VALUES (?, ?, 'PRIMARY_VISUAL', 9)", group, stim);
        validation.invalidate(form);

        PracticeScopeDiagnosticDto d = byCode(form).get("IELTS_LISTENING_SECTION_3");
        assertTrue(d.ready(), "LABEL_ASSIGNMENT is declared SUPPORTED and its figure is deliverable: " + d.reasonCodes());
        UUID attemptId = create("CAM17_T1", "IELTS_LISTENING_SECTION_3", LEARNER).attemptId();
        start(attemptId, LEARNER);
        PublicAttemptManifestDto m = attempts.getAttemptManifest(LEARNER, attemptId);
        PublicGroupDto lg = m.sections().get(0).parts().get(0).groups().stream()
                .filter(g -> g.items().stream().anyMatch(i -> "LABEL_ASSIGNMENT".equals(i.interactionType()))).findFirst().orElseThrow();
        PublicStimulusDto map = lg.stimuli().stream().filter(s -> "MAP".equals(s.kind())).findFirst().orElseThrow();
        assertEquals("PLAYBACK_GRANT", map.assets().get(0).delivery(), "figure rendered through a grant");
        assertFalse(map.bodyPayload().containsKey("sourcePage"), "no source metadata in the practice payload");
        assertNotNull(media.createPlaybackGrant(LEARNER, attemptId, asset, MediaPurpose.SIMULATION_LISTENING), "figure in scope");

        List<ExamAttemptSnapshotContent.SnapshotItem> labelItems = items(attemptId).stream()
                .filter(i -> "LABEL_ASSIGNMENT".equals(i.interactionType())).toList();
        assertTrue(labelItems.size() >= 4);
        Map<UUID, String> pl = placements(attemptId, LEARNER);
        String k0 = key(labelItems.get(0));
        Map<String, String> answers = new LinkedHashMap<>();
        answers.put(pl.get(labelItems.get(0).itemId()), k0);                          // correct
        answers.put(pl.get(labelItems.get(1).itemId()), k0);                          // same letter reused
        answers.put(pl.get(labelItems.get(2).itemId()), key(labelItems.get(2)));      // correct
        save(attemptId, LEARNER, answers);                                            // 4th target left blank
        assertEquals(answers.keySet(), attempts.getAttemptState(LEARNER, attemptId).responses().keySet(), "assignment resumes");
        submit(attemptId, LEARNER);
        Map<UUID, ReviewItemDto> review = new HashMap<>();
        for (ReviewGroupDto g : practice.getReview(LEARNER, attemptId).groups()) for (ReviewItemDto i : g.items()) review.put(i.itemId(), i);
        assertEquals("CORRECT", review.get(labelItems.get(0).itemId()).status());
        String second = key(labelItems.get(1)).equalsIgnoreCase(k0) ? "CORRECT" : "INCORRECT";
        assertEquals(second, review.get(labelItems.get(1).itemId()).status(), "each target scored independently (canonical spec)");
        assertEquals(k0, review.get(labelItems.get(1).itemId()).learnerAnswer());
        assertEquals("CORRECT", review.get(labelItems.get(2).itemId()).status());
        assertEquals("UNANSWERED", review.get(labelItems.get(3).itemId()).status());
        assertEquals(List.of(key(labelItems.get(3))), review.get(labelItems.get(3).itemId()).correctAnswers());
        row("labelAssignment").put("endToEnd", Map.of("targets", labelItems.size(), "figureGrant", true, "resume", true,
                "reviewStatuses", List.of("CORRECT", second, "CORRECT", "UNANSWERED")));
    }

    @Test
    @Order(12)
    @DisplayName("14/15: a scope whose keys disappear (TEST-ONLY blanking) becomes unavailable; sibling scopes stay available")
    void blankedKeysBlockOnlyThatScope() {
        UUID form = FORMS.get("CAM17_T1");
        jdbc.update("UPDATE exams.answer_specs SET accepted_answers = '{\"values\":[]}'::jsonb WHERE item_id IN ("
                + "SELECT iv.id FROM exams.item_versions iv JOIN exams.form_groups fg ON fg.group_id = iv.group_id "
                + "JOIN exams.parts p ON p.id = fg.part_id JOIN exams.sections s ON s.id = p.section_id "
                + "WHERE s.form_id = ? AND p.part_code = 'READING_PASSAGE_3')", form);
        validation.invalidate(form);
        Map<String, PracticeScopeDiagnosticDto> d = byCode(form);
        assertFalse(d.get("IELTS_READING_PASSAGE_3").ready());
        assertTrue(d.get("IELTS_READING_PASSAGE_3").reasonCodes().contains("ANSWER_KEY_MISSING"));
        assertEquals("UNAVAILABLE", d.get("IELTS_READING_PASSAGE_3").learnerAvailability());
        assertTrue(d.get("IELTS_READING_PASSAGE_1").ready(), d.get("IELTS_READING_PASSAGE_1").reasonCodes().toString());
        assertThrows(ExamPracticeService.ScopeUnavailableException.class, () -> create("CAM17_T1", "IELTS_READING_PASSAGE_3", LEARNER));
    }

    @Test
    @Order(13)
    @DisplayName("Practice Again on a retired source version is refused explicitly; the historical result stays readable")
    void practiceAgainRetiredSource() {
        UUID listening = ATTEMPTS.get("IELTS_LISTENING_SECTION_1");
        UUID form = FORMS.get("CAM17_T1");
        jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'RETIRED' WHERE id = ?", form);
        validation.invalidate(form);
        IllegalStateException ex = assertThrows(IllegalStateException.class, () -> practice.practiceAgain(LEARNER, listening, null));
        assertTrue(ex.getMessage().startsWith(ExamPracticeService.SOURCE_UNAVAILABLE_CODE));
        assertEquals("SUBMITTED", practice.getResult(LEARNER, listening).completionStatus());
        jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'PILOT' WHERE id = ?", form);
        validation.invalidate(form);
        assertEquals(0, count("SELECT COUNT(*) FROM exams.profile_evidence"), "no evidence at any point");
        row("practiceAgain").put("retiredSource", ExamPracticeService.SOURCE_UNAVAILABLE_CODE);
    }

    @Test
    @Order(30)
    @DisplayName("Learning Path: a REAL submitted practice part completes exactly the task assigned to that form + part")
    void learningPathExamTaskCompletesFromTheRealSubmittedPart() throws Exception {
        // the Learning Path tables (V96 + V98) on the same isolated database as the Exams runtime
        for (String v : List.of("V96__learning_path.sql", "V98__learning_path_writing_exam_completion.sql"))
            jdbc.execute(Files.readString(MIGRATIONS.resolve(v)));
        UUID form = FORMS.get("ETS26_T1");
        UUID part5 = ATTEMPTS.get("TOEIC_PART_5");           // submitted in @Order(5): 15 of 30 answered, 10 correct
        UUID part6 = ATTEMPTS.get("TOEIC_PART_6");           // created, never submitted
        java.time.Instant assigned = java.time.Instant.now().minus(java.time.Duration.ofDays(1));
        java.time.LocalDate day = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Ho_Chi_Minh"));
        jdbc.update("INSERT INTO public.learning_path_plan (user_id, goal, daily_minutes, target, start_cefr, start_basis) "
                + "VALUES (?, 'TOEIC', 60, '650', 'B1', 'PLACEMENT'), (?, 'TOEIC', 60, '650', 'B1', 'PLACEMENT')", LEARNER, OTHER);
        long task5 = lpTask(LEARNER, day, 1, form + "/TOEIC_PART_5", assigned);
        long task6 = lpTask(LEARNER, day, 2, form + "/TOEIC_PART_6", assigned);
        long foreign = lpTask(OTHER, day, 1, form + "/TOEIC_PART_5", assigned);

        com.englishcoach.learningpath.LearningPathRepository repo = new com.englishcoach.learningpath.LearningPathRepository(named, MAPPER);
        com.englishcoach.learningpath.LearningEvidenceReader reader = new com.englishcoach.learningpath.LearningEvidenceReader(named);
        java.time.Instant since = day.minusDays(1).atStartOfDay(java.time.ZoneId.of("Asia/Ho_Chi_Minh")).toInstant();
        Map<Long, java.time.Instant> from = Map.of(task5, since, task6, since, foreign, since);
        var mine = reader.evaluate(LEARNER, repo.tasksOn(LEARNER, day), from);
        var theirs = reader.evaluate(OTHER, repo.tasksOn(OTHER, day), from);
        var e5 = mine.stream().filter(e -> e.taskId() == task5).findFirst().orElseThrow();
        var e6 = mine.stream().filter(e -> e.taskId() == task6).findFirst().orElseThrow();
        assertEquals(1, e5.count(), "the learner's own submitted attempt of exactly that part");
        assertEquals("ex:" + part5, e5.ref());
        assertEquals(0, e6.count(), "a created but unsubmitted part never counts");
        assertNotNull(part6);
        assertEquals(0, theirs.get(0).count(), "another learner's attempt never counts");

        // the outcome comes from the Exams module's own scorer on the attempt snapshot, owner-scoped
        com.englishcoach.learningpath.ExamPracticeAdapter adapter = new com.englishcoach.learningpath.ExamPracticeAdapter(null, practice, null, null);
        var outcome = adapter.outcome(LEARNER, part5).orElseThrow();
        assertEquals(15, outcome.answered());
        assertEquals(30, outcome.total());
        assertEquals(33, outcome.accuracyPct());
        assertTrue(adapter.outcome(OTHER, part5).isEmpty(), "a foreign attempt has no outcome (404 inside the Exams module)");
        assertTrue(adapter.outcome(LEARNER, part6).isEmpty(), "an unsubmitted part has no outcome");
        row("learningPath").put("examTask", Map.of("evidence", "ex:<attempt>", "answered", 15, "total", 30, "accuracyPct", 33));
    }

    @Test
    @Order(31)
    @DisplayName("Learning Path evidence: full then partial ⇒ the full attempt; a later complete worse attempt ⇒ that one; "
            + "foreign / replayed evidence never completes a task (real Exams scorer)")
    void learningPathExamEvidencePrefersCompleteAttemptsAndStaysResponsive() throws Exception {
        UUID form = FORMS.get("ETS26_T1");
        java.time.Instant mark = java.time.Instant.now().minusSeconds(1);
        java.time.LocalDate day = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Ho_Chi_Minh"));
        UUID full = answered("TOEIC_PART_6", Integer.MAX_VALUE, true);   // every item, every key right
        Thread.sleep(25);
        UUID partial = answered("TOEIC_PART_6", 2, true);                // 2 of 16 answered, submitted later
        long task = lpTask(LEARNER, day, 3, form + "/TOEIC_PART_6", mark);
        long foreign = lpTask(OTHER, day, 3, form + "/TOEIC_PART_6", mark);

        com.englishcoach.learningpath.LearningPathRepository repo = new com.englishcoach.learningpath.LearningPathRepository(named, MAPPER);
        com.englishcoach.learningpath.LearningEvidenceReader reader = new com.englishcoach.learningpath.LearningEvidenceReader(named);
        com.englishcoach.learningpath.ExamPracticeAdapter adapter = new com.englishcoach.learningpath.ExamPracticeAdapter(null, practice, null, null);

        // Scenario A: the newer low-information submit does not displace the complete attempt
        var ev = reader.evaluate(LEARNER, List.of(one(repo, LEARNER, day, task)), Map.of(task, mark)).get(0);
        assertEquals(2, ev.count());
        assertEquals("ex:" + partial + ",ex:" + full, ev.ref(), "candidates, newest first");
        var chosen = choose(adapter, ev.ref());
        assertEquals("ex:" + full, chosen.ref());
        assertEquals(100, chosen.accuracyPct());

        // Scenario B: a later, comparably complete attempt is the current evidence — also when it is worse
        Thread.sleep(25);
        UUID worse = answered("TOEIC_PART_6", Integer.MAX_VALUE, false);  // every item answered, every one wrong
        ev = reader.evaluate(LEARNER, List.of(one(repo, LEARNER, day, task)), Map.of(task, mark)).get(0);
        chosen = choose(adapter, ev.ref());
        assertEquals("ex:" + worse, chosen.ref());
        assertEquals(0, chosen.accuracyPct());

        // Scenario D: the other learner's task on the same part sees none of these attempts
        assertEquals(0, reader.evaluate(OTHER, List.of(one(repo, OTHER, day, foreign)), Map.of(foreign, mark)).get(0).count());

        // Scenario E: evidence completes one task once; a replay or a second task of the kind cannot reuse it
        assertTrue(repo.complete(LEARNER, task, chosen.ref(), chosen.answered(), chosen.accuracyPct()));
        assertFalse(repo.complete(LEARNER, task, chosen.ref(), chosen.answered(), chosen.accuracyPct()), "replay: no second write");
        long second = lpTask(LEARNER, day, 4, form + "/TOEIC_PART_6", mark);
        assertFalse(repo.complete(LEARNER, second, chosen.ref(), chosen.answered(), chosen.accuracyPct()), "one evidence row, one task");
        var rest = reader.evaluate(LEARNER, List.of(one(repo, LEARNER, day, second)), Map.of(second, mark)).get(0);
        assertFalse(rest.ref().contains(worse.toString()), "linked evidence is never offered again");
        assertEquals(1, count("SELECT count(*) FROM public.learning_path_task WHERE user_id = ? AND evidence_ref = ?", LEARNER, chosen.ref()));
        assertEquals(0, count("SELECT COUNT(*) FROM exams.profile_evidence"), "practice evidence never becomes official evidence");
        row("learningPath").put("examEvidence", Map.of("fullThenPartial", "full", "laterCompleteWorse", "later", "foreign", 0));
    }

    static com.englishcoach.learningpath.LearningPathRepository.Task one(com.englishcoach.learningpath.LearningPathRepository repo,
            long user, java.time.LocalDate day, long id) {
        return repo.tasksOn(user, day).stream().filter(t -> t.id() == id).findFirst().orElseThrow();
    }

    /** Creates, answers ({@code limit} items, keys right or wrong) and submits one practice attempt of a part. */
    static UUID answered(String scope, int limit, boolean right) {
        UUID id = create("ETS26_T1", scope, LEARNER).attemptId();
        start(id, LEARNER);
        Map<UUID, String> pl = placements(id, LEARNER);
        Map<String, String> answers = new LinkedHashMap<>();
        for (ExamAttemptSnapshotContent.SnapshotItem it : items(id)) {
            if (answers.size() >= limit) break;
            answers.put(pl.get(it.itemId()), right ? key(it) : wrongLetter(key(it)));
        }
        save(id, LEARNER, answers);
        submit(id, LEARNER);
        return id;
    }

    /** The Learning Path's own choice over the Exams module's scores of the candidate attempts. */
    static com.englishcoach.learningpath.LearningPathEngine.ExamAttemptOutcome choose(
            com.englishcoach.learningpath.ExamPracticeAdapter adapter, String refs) {
        List<com.englishcoach.learningpath.LearningPathEngine.ExamAttemptOutcome> scored = new ArrayList<>();
        for (String ref : refs.split(",")) {
            adapter.outcome(LEARNER, UUID.fromString(ref.substring(3))).ifPresent(o -> scored.add(
                    new com.englishcoach.learningpath.LearningPathEngine.ExamAttemptOutcome(ref, o.answered(), o.total(), o.accuracyPct())));
        }
        return com.englishcoach.learningpath.LearningPathEngine.examEvidence(scored).orElseThrow();
    }

    static long lpTask(long user, java.time.LocalDate day, int position, String ref, java.time.Instant assigned) {
        return jdbc.queryForObject("INSERT INTO public.learning_path_task (user_id, plan_day, position, plan_version, kind, skill, "
                + "target_key, title, minutes, goal_count, reason_code, assigned_at, target_ref) VALUES (?, ?, ?, 1, 'EXAM_PRACTICE', "
                + "'READING', 'TOEIC', 'ETS 2026 Test 1', 12, 1, 'GOAL_CHECK', ?, ?) RETURNING id", Long.class, user,
                java.sql.Date.valueOf(day), position, java.sql.Timestamp.from(assigned), ref);
    }
}
