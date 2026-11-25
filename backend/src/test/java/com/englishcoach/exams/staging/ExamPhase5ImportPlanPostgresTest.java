package com.englishcoach.exams.staging;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.*;
import com.englishcoach.exams.content.ExamContentPackageImporter.ImportRightsBasis;
import com.englishcoach.exams.job.ExamJobWorker;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamScoringRecords.ScoreArtifactRecord;
import com.englishcoach.exams.model.ExamScoringRecords.ScoreComponentRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.release.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamProfileRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamAttemptSnapshotContent;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamScoreAggregator;
import com.englishcoach.exams.service.ExamContentService;
import com.englishcoach.exams.service.ExamManifestService;
import com.englishcoach.exams.validation.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.transaction.PlatformTransactionManager;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Exams Recovery Phase 5L — LOCAL import dry run of the Phase 5 architecture on an isolated PostgreSQL 17 Testcontainer
 * (never the dev or production database). Scenarios: A IELTS candidate (Cambridge 21 T4), B TOEIC candidate (ETS 2026
 * T3), C exact re-import, D changed version of the same source identity (planner NEW_VERSION + immutable successor),
 * E release-blocked package (ETS 2019 T1), F human-QA-pending plan refused, G media rows imported once, H Practice ⇒ no
 * official evidence, I attempt snapshot / score / evidence decision preserved across a new version + retirement,
 * J legacy replacement planned but never executed. The planner runs on a READ-ONLY connection. Imports use the
 * existing Phase 4 owner-authorized LOCAL dry-run basis only; the release gate is never bypassed (every real plan of
 * these packages is BLOCKED: READY_EXCEPT_HUMAN_QA is not IMPORT_READY). Writes reports/phase5_import_dry_run.json
 * (ids, counts, codes). Needs -Dapi.version=1.44 on this machine; skips without Docker or local staged data.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamPhase5ImportPlanPostgresTest {

    private static final Path MIGRATIONS = Path.of("src/main/resources/db/migration/exams");
    private static final Path STAGING = Path.of("..", "imports", "exams", "staging");
    private static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    private static final Map<String, String> TARGETS = new LinkedHashMap<>();
    static {
        TARGETS.put("ielts/cambridge-ielts-21/test-4", "extracted/ielts/cambridge/cambridge-ielts-21/cambridge-ielts-21__test-4.json");
        TARGETS.put("toeic/ets-2026/test-3", "extracted/toeic/ets/ets-2026/ets-2026__test-3.json");
        TARGETS.put("toeic/ets-2019/test-1", "extracted/toeic/ets/ets-2019/ets-2019__test-1.json");
        TARGETS.put("ielts/cambridge-ielts-17/test-1", "extracted/ielts/cambridge/cambridge-ielts-17/cambridge-ielts-17__test-1.json");
    }
    static final String CAM21 = "ielts/cambridge-ielts-21/test-4", ETS26 = "toeic/ets-2026/test-3",
            ETS19 = "toeic/ets-2019/test-1", CAM17 = "ielts/cambridge-ielts-17/test-1";

    static PostgreSQLContainer<?> pg;
    static com.zaxxer.hikari.HikariDataSource POOL;
    static JdbcTemplate jdbc;
    static NamedParameterJdbcTemplate named;
    static NamedParameterJdbcTemplate readOnly;
    static ExamContentRepository contentRepository;
    static ExamAttemptRepository attemptRepository;
    static ExamScoringRepository scoringRepository;
    static ExamContentValidationService validation;
    static ExamContentPackageImporter importer;
    static ExamManifestService manifestService;
    static ExamJobWorker worker;
    static ExamContentService catalog;
    static ExamImportPlanner.StateReader reader;
    static final Map<String, ExamContentPackage> PKGS = new LinkedHashMap<>();
    static final Map<String, ExamReleaseReadinessGate.Decision> GATES = new LinkedHashMap<>();
    static final Map<String, ExamFormValidationReport> STRUCT = new LinkedHashMap<>();
    static final Map<String, UUID> FORMS = new LinkedHashMap<>();
    static final Map<String, Object> REPORT = new LinkedHashMap<>();
    static final List<String> TABLES = List.of("form_versions", "sections", "parts", "group_versions", "form_groups",
            "item_versions", "answer_specs", "stimulus_versions", "group_stimuli", "assets", "stimulus_assets",
            "content_package_imports", "content_qa_runs", "project_usage_authorizations", "attempts", "profile_evidence");

    @BeforeAll
    static void setUp() throws Exception {
        ExamPhase4ReleaseReadinessTest.load();
        for (Map.Entry<String, String> t : TARGETS.entrySet()) {
            assumeTrue(Files.isRegularFile(STAGING.resolve(t.getValue())), "missing " + t.getValue());
            ExamContentPackage pkg = MAPPER.readValue(STAGING.resolve(t.getValue()).toFile(), ExamContentPackage.class);
            PKGS.put(t.getKey(), pkg);
            ExamFormValidationReport structural = ExamPhase4ReleaseReadinessTest.structural(pkg);
            STRUCT.put(t.getKey(), structural);
            GATES.put(t.getKey(), ExamReleaseReadinessGate.evaluate(pkg, structural, ExamPhase4ReleaseReadinessTest.closureCodes(pkg),
                    ExamRuntimeCompatibility.audit(pkg), ExamPhase4ReleaseReadinessTest.qa(t.getKey()),
                    ExamMediaImportPlan.plan(pkg, Path.of(".."), true, ExamPhase4ReleaseReadinessTest.cropQa(t.getKey()))));
        }
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker not available — PostgreSQL dry run skipped");
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        // a small pool: the importer issues thousands of statements (a new TCP connection each would exhaust sockets)
        com.zaxxer.hikari.HikariConfig hc = new com.zaxxer.hikari.HikariConfig();
        hc.setJdbcUrl(pg.getJdbcUrl());
        hc.setUsername(pg.getUsername());
        hc.setPassword(pg.getPassword());
        hc.setMaximumPoolSize(4);
        POOL = new com.zaxxer.hikari.HikariDataSource(hc);
        javax.sql.DataSource ds = POOL;
        jdbc = new JdbcTemplate(ds);
        named = new NamedParameterJdbcTemplate(ds);
        jdbc.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, email VARCHAR(255)); "
                + "INSERT INTO public.users VALUES (1, 'operator@example.test'), (101, 'learner@example.test');");
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
        StaticListableBeanFactory beans = new StaticListableBeanFactory(Map.of("tm", new DataSourceTransactionManager(ds)));
        validation = new ExamContentValidationService(new ExamContentValidationRepository(named, MAPPER), MAPPER,
                beans.getBeanProvider(PlatformTransactionManager.class));
        importer = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(MAPPER));
        importer.setValidationService(validation);
        importer.setOwnerAuthorizedDryRunEnabled(true);
        manifestService = new ExamManifestService(contentRepository, attemptRepository);
        worker = new ExamJobWorker(scoringRepository, attemptRepository, contentRepository,
                new ExamProfileRepository(named, MAPPER), new ExamObjectiveScorer(new ExamAnswerNormalizer()),
                new ExamScoreAggregator(), null, null, new ExamsProperties());
        catalog = new ExamContentService(contentRepository, new ExamsProperties(), validation);
        // the planner's view: a READ-ONLY session (any write would fail)
        Connection ro = DriverManager.getConnection(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (java.sql.Statement st = ro.createStatement()) {
            st.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");   // every statement of this session
        }
        readOnly = new NamedParameterJdbcTemplate(new SingleConnectionDataSource(ro, true));
        reader = new ExamImportStateJdbcReader(readOnly, MAPPER);
    }

    @AfterAll
    static void tearDown() throws Exception {
        if (pg != null) {
            if (POOL != null) POOL.close();
            pg.stop();
            REPORT.put("generatedBy", "ExamPhase5ImportPlanPostgresTest (Exams Recovery Phase 5L, isolated PostgreSQL 17)");
            MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT)
                    .writeValue(STAGING.resolve("reports").resolve("phase5_import_dry_run.json").toFile(), REPORT);
        }
    }

    static int count(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM exams." + table, Integer.class);
    }

    static Map<String, Integer> counts() {
        Map<String, Integer> m = new LinkedHashMap<>();
        for (String t : TABLES) m.put(t, count(t));
        return m;
    }

    static ExamImportPlanner.Plan plan(String key, ExamContentPackage pkg, List<ExamImportPlanner.ReplacementMapping> maps) {
        return ExamImportPlanner.plan(pkg, ExamPhase4ReleaseReadinessTest.structural(pkg), GATES.get(key), null, maps, reader,
                ExamImportPlanner.Target.LOCAL_DRY_RUN);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> row(String key) {
        return (Map<String, Object>) REPORT.computeIfAbsent(key, k -> new LinkedHashMap<String, Object>());
    }

    /** A copy of a staged package with one answer key changed (content change, same source identity). */
    static ExamContentPackage withChangedKey(ExamContentPackage pkg) throws Exception {
        ObjectNode json = (ObjectNode) MAPPER.valueToTree(pkg);
        for (com.fasterxml.jackson.databind.JsonNode s : json.path("answerSpecs")) {
            if (s.path("acceptedAnswers").path("values").isArray() && !s.path("acceptedAnswers").has("unorderedSet")) {
                ((ObjectNode) s.path("acceptedAnswers")).set("values", MAPPER.createArrayNode().add("phase5 corrected value"));
                break;
            }
        }
        return rehash(json);
    }

    static ExamContentPackage withMetadataDrift(ExamContentPackage pkg) throws Exception {
        ObjectNode json = (ObjectNode) MAPPER.valueToTree(pkg);
        ((ObjectNode) json.path("manifest").path("metadata").path("sourceProvenance")).put("extractorVersion", "3.7.0-rerun");
        return rehash(json);
    }

    static ExamContentPackage rehash(ObjectNode json) throws Exception {
        ExamContentPackage parsed = MAPPER.treeToValue(json, ExamContentPackage.class);
        ((ObjectNode) json.path("manifest")).put("contentHash", new ExamContentPackageValidator(MAPPER).computeContentHash(parsed));
        return MAPPER.treeToValue(json, ExamContentPackage.class);
    }

    // ── scenarios ──────────────────────────────────────────────────────────────────────────────────────

    @Test
    @Order(1)
    @DisplayName("E/F/24: plans on an empty target are BLOCKED by the gate (candidates READY_EXCEPT_HUMAN_QA, ETS 2019 "
            + "source-blocked); the executor refuses; nothing is written; production is BLOCKED")
    void blockedPlansWriteNothing() {
        Map<String, Integer> before = counts();
        ExamImportExecutor exec = new ExamImportExecutor(importer, reader, MAPPER);
        for (String key : List.of(CAM21, ETS26, ETS19)) {
            ExamImportPlanner.Plan p = plan(key, PKGS.get(key), List.of());
            assertEquals(ExamImportPlanner.Operation.BLOCKED, p.operation(), key);
            assertEquals(ExamImportPlanner.Operation.CREATE, p.contentOperation(), key);
            assertTrue(p.blockers().contains("RELEASE_GATE_NOT_IMPORT_READY"));
            IllegalStateException ex = assertThrows(IllegalStateException.class, () -> exec.execute(p, PKGS.get(key), 1L));
            assertTrue(ex.getMessage().startsWith("IMPORT_PLAN_BLOCKED"));
            ExamImportPlanner.Plan prod = ExamImportPlanner.plan(PKGS.get(key), STRUCT.get(key), GATES.get(key), null,
                    List.of(), reader, ExamImportPlanner.Target.PRODUCTION);
            assertFalse(prod.blockers().contains("PRODUCTION_IMPORT_BASIS_NOT_ESTABLISHED"), "covered source has the owner production basis");
            assertTrue(prod.blockers().contains("RELEASE_GATE_NOT_IMPORT_READY"), "technical and human QA gates still block the full package");
            row(key).put("emptyTargetPlan", Map.of("operation", p.operation().name(), "content", p.contentOperation().name(),
                    "blockers", p.blockers(), "notes", p.notes(), "production", prod.operation().name()));
        }
        assertTrue(plan(CAM21, PKGS.get(CAM21), List.of()).notes().contains("READY_EXCEPT_HUMAN_QA"));
        assertTrue(plan(ETS26, PKGS.get(ETS26), List.of()).notes().contains("READY_EXCEPT_HUMAN_QA"));
        assertTrue(plan(ETS19, PKGS.get(ETS19), List.of()).blockers().containsAll(List.of("GATE_STRUCTURAL_VALID_NO",
                "GATE_SCORING_COMPATIBLE_NO")));
        assertEquals(before, counts(), "planning and refused execution write nothing");
        assertThrows(Exception.class, () -> readOnly.getJdbcTemplate().update("DELETE FROM exams.assets"),
                "the planner's session is read-only");
    }

    @Test
    @Order(2)
    @DisplayName("A/B/G: owner-authorized LOCAL import of the IELTS + TOEIC candidates; identity recorded; media once")
    void importCandidates() {
        for (String key : List.of(CAM21, ETS26)) {
            ExamContentPackage.ImportResult r = importer.importPackage(PKGS.get(key), 1L,
                    ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN);
            assertEquals(ExamContentPackage.ImportStatus.IMPORTED, r.status());
            FORMS.put(key, r.formId());
            String sourceKey = jdbc.queryForObject("SELECT findings -> 'packageIdentity' ->> 'sourceKey' FROM exams.content_qa_runs "
                    + "WHERE form_id = ?", String.class, r.formId());
            assertEquals(ExamPackageIdentity.of(PKGS.get(key)).sourceKey(), sourceKey, "identity recorded at import");
            row(key).put("import", Map.of("status", r.status().name(), "sourceKey", sourceKey));
        }
        Set<String> shas = new HashSet<>();
        int placements = 0;
        for (String key : List.of(CAM21, ETS26)) {
            PKGS.get(key).assets().forEach(a -> shas.add(a.sha256Hash()));
            placements += PKGS.get(key).stimulusAssets().size();
        }
        assertEquals(shas.size(), count("assets"), "one asset row per content-addressed file");
        assertEquals(placements, count("stimulus_assets"));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM exams.assets WHERE object_key ILIKE 'http%' "
                + "OR object_key ILIKE '%localhost%'", Integer.class), "no URL is persisted as content");
        REPORT.put("mediaRows", Map.of("assets", count("assets"), "stimulusAssets", count("stimulus_assets"),
                "distinctSha256", shas.size()));
        // E: the source-blocked package cannot be imported even on the local owner basis (no answer key, missing parts)
        ExamContentPackageValidationException ex = assertThrows(ExamContentPackageValidationException.class,
                () -> importer.importPackage(PKGS.get(ETS19), 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN));
        assertTrue(ex.errors().stream().anyMatch(e -> !e.code().startsWith("RIGHTS_")), ex.getMessage());
        row(ETS19).put("ownerBasisImport", "REFUSED " + ex.errors().stream().map(ExamContentPackage.ValidationError::code)
                .distinct().sorted().toList());
    }

    @Test
    @Order(3)
    @DisplayName("C: exact re-import and a metadata-only re-extraction are ALREADY_IMPORTED (importer + planner); no new rows")
    void idempotency() throws Exception {
        Map<String, Integer> before = counts();
        for (String key : List.of(CAM21, ETS26)) {
            ExamContentPackage same = PKGS.get(key);
            assertEquals(ExamContentPackage.ImportStatus.ALREADY_IMPORTED, importer.importPackage(same, 1L,
                    ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN).status());
            ExamContentPackage drift = withMetadataDrift(same);
            assertNotEquals(same.manifest().contentHash(), drift.manifest().contentHash());
            ExamContentPackage.ImportResult d = importer.importPackage(drift, 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN);
            assertEquals(ExamContentPackage.ImportStatus.ALREADY_IMPORTED, d.status(), "semantic idempotency");
            assertEquals(FORMS.get(key), d.formId());
            ExamImportPlanner.Plan p = plan(key, drift, List.of());
            assertEquals(ExamImportPlanner.Operation.ALREADY_IMPORTED, p.operation(), "nothing to write, whatever the gate");
            assertTrue(p.notes().contains("METADATA_ONLY_DRIFT"));
            assertEquals(ExamImportPlanner.Operation.ALREADY_IMPORTED, new ExamImportExecutor(importer, reader, MAPPER)
                    .execute(p, drift, 1L).operation());
            row(key).put("reimport", "ALREADY_IMPORTED (exact + metadata drift); plan " + p.operation() + " " + p.notes());
        }
        assertEquals(before, counts(), "no duplicate form / version / item / group / stimulus / media / validation rows");
    }

    @Test
    @Order(4)
    @DisplayName("H: validation + catalog + snapshot scoring of the imported forms; Practice creates no evidence")
    void snapshotScoringAndPractice() {
        for (String key : List.of(CAM21, ETS26)) {
            UUID formId = FORMS.get(key);
            ExamFormValidationReport fromDb = validation.revalidate(formId, ExamContentValidationService.Trigger.IMPORT);
            assertTrue(fromDb.fullSimulationEligible(), key + " " + fromDb.blockingCodes());
            jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'PILOT' WHERE id = ?", formId);
            FormVersionRecord form = contentRepository.findFormById(formId).orElseThrow();
            AttemptRecord practice = Helpers.createAttempt(form, ExamAttemptMode.PRACTICE);
            Map<ScoreMetric, ScoreComponentRecord> c = Helpers.scoreAllCorrect(practice);
            double expected = key.startsWith("toeic") ? 100 : 40;
            assertEquals(expected, c.get(ScoreMetric.LISTENING).rawScore(), key);
            assertEquals(expected, c.get(ScoreMetric.READING).rawScore(), key);
            assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM exams.profile_evidence WHERE attempt_id = ?", Integer.class,
                    practice.id()), "Practice never creates official evidence");
            row(key).put("scoring", Map.of("validation", fromDb.status().name(), "listeningRaw", c.get(ScoreMetric.LISTENING).rawScore(),
                    "readingRaw", c.get(ScoreMetric.READING).rawScore(), "listeningScaled", c.get(ScoreMetric.LISTENING).scaledScore(),
                    "practiceEvidenceRows", 0));
        }
    }

    @Test
    @Order(5)
    @DisplayName("D/I: changed content of the same source ⇒ NEW_VERSION (gate-blocked plan refused); the immutable successor "
            + "leaves v1 rows, the v1 attempt snapshot, its score and its evidence decision unchanged")
    void newVersionPreservesHistory() throws Exception {
        UUID v1 = FORMS.get(CAM21);
        FormVersionRecord v1Form = contentRepository.findFormById(v1).orElseThrow();
        AttemptRecord sim = Helpers.createAttempt(v1Form, ExamAttemptMode.EXAM_SIMULATION);
        Map<ScoreMetric, ScoreComponentRecord> before = Helpers.scoreAllCorrect(sim);
        Map<String, String> decisionsBefore = Helpers.evidenceDecisions(attemptRepository.findAttemptById(sim.id()).orElseThrow());
        Map<String, Object> snapBefore = attemptRepository.findAttemptById(sim.id()).orElseThrow().manifestSnapshot();
        int v1Items = contentRepository.findItemsByFormId(v1).size();
        Map<String, Integer> rowsBefore = counts();

        ExamContentPackage changed = withChangedKey(PKGS.get(CAM21));
        ExamImportPlanner.Plan p = plan(CAM21, changed, List.of());
        assertEquals(ExamImportPlanner.Operation.NEW_VERSION, p.contentOperation());
        assertEquals(ExamImportPlanner.Operation.BLOCKED, p.operation(), "a new version needs the release gate too");
        assertEquals(2, p.plannedFormVersion());
        assertEquals(1, p.changedPlacements().size());
        assertThrows(IllegalStateException.class, () -> new ExamImportExecutor(importer, reader, MAPPER).execute(p, changed, 1L));
        assertEquals(rowsBefore, counts(), "refused plan wrote nothing");

        // the successor the plan describes, imported on the LOCAL owner basis (same as every dry-run import here)
        ExamImportPlanner.ImportedVersion latest = reader.importsForSource(p.sourceKey()).get(0);
        ExamPackageSuccessorBuilder.Result succ = ExamPackageSuccessorBuilder.build(changed, latest.identity(),
                p.plannedFormVersion(), p.plannedPackageVersion(), MAPPER);
        ExamContentPackage.ImportResult r = importer.importPackage(succ.pkg(), 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN);
        assertEquals(ExamContentPackage.ImportStatus.IMPORTED, r.status());
        assertNotEquals(v1, r.formId());
        assertEquals(2, contentRepository.findFormById(r.formId()).orElseThrow().version());
        Map<String, Integer> rowsAfter = counts();
        assertEquals(rowsBefore.get("form_versions") + 1, rowsAfter.get("form_versions"));
        assertEquals(rowsBefore.get("group_versions") + 1, rowsAfter.get("group_versions"), "only the changed group is new");
        assertEquals(rowsBefore.get("assets"), rowsAfter.get("assets"), "media shared, never duplicated");

        // v1 retired after v2 is published: history keeps its truth
        jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'PUBLISHED', published_at = now() WHERE id = ?", r.formId());
        jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'RETIRED' WHERE id = ?", v1);
        validation.invalidate(v1);
        AttemptRecord reread = attemptRepository.findAttemptById(sim.id()).orElseThrow();
        assertEquals(v1, reread.formId(), "the attempt is never re-pointed to the replacement");
        assertEquals(snapBefore, reread.manifestSnapshot(), "snapshot unchanged");
        assertEquals(v1Items, contentRepository.findItemsByFormId(v1).size(), "v1 items untouched");
        ScoreArtifactRecord rescored = worker.scoreObjectiveSubmissionDirectly(Helpers.SUBMISSIONS.get(sim.id()), reread);
        assertEquals(before.get(ScoreMetric.LISTENING).rawScore(), Helpers.components(rescored).get(ScoreMetric.LISTENING).rawScore());
        assertEquals(decisionsBefore, Helpers.evidenceDecisions(reread), "pinned evidence decision unchanged");

        assertEquals(ExamImportPlanner.Operation.ALREADY_IMPORTED, plan(CAM21, changed, List.of()).operation());
        ExamImportPlanner.Plan orig = plan(CAM21, PKGS.get(CAM21), List.of());
        assertEquals(ExamImportPlanner.Operation.ALREADY_IMPORTED, orig.operation());
        assertTrue(orig.notes().contains("MATCHES_SUPERSEDED_VERSION"));
        row(CAM21).put("newVersion", Map.of("plan", p.contentOperation().name() + " (operation " + p.operation() + ")",
                "changedPlacements", p.changedPlacements().size(), "reusedPlacements", p.reusedPlacements().size(),
                "successorFormVersion", 2, "v1AttemptPinned", true, "scoreUnchanged", true, "evidenceDecisionUnchanged", decisionsBefore));
        jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'PILOT' WHERE id = ?", v1);
    }

    @Test
    @Order(6)
    @DisplayName("J: an EXACT_SOURCE_MATCH legacy form makes a REPLACEMENT_CANDIDATE plan; nothing is retired, its attempt stays")
    void replacementPlanned() {
        String key = CAM17;
        ExamContentPackage pkg = PKGS.get(key);
        FormVersionRecord f = pkg.form();
        UUID legacyId = UUID.nameUUIDFromBytes("phase5-legacy-cam17-t1".getBytes());
        // legacy placeholder form (direct-SQL era shape) borrowing an imported form's catalog / spec / scheme rows
        FormVersionRecord host = contentRepository.findFormById(FORMS.get(CAM21)).orElseThrow();
        contentRepository.insertFormVersion(new FormVersionRecord(legacyId, "FORM_REAL_CAMBRIDGE_IELTS_VOL_17_TEST_01", 1,
                "Legacy placeholder", f.family(), f.variant(), f.scope(), host.catalogNodeId(), host.specificationId(),
                host.scoringSchemeId(), LifecycleState.PUBLISHED, host.provenanceId(), null, "legacy-hash", Instant.now(), null,
                Instant.now()));
        UUID legacyAttempt = UUID.randomUUID();
        attemptRepository.insertAttempt(new AttemptRecord(legacyAttempt, 101L, legacyId, f.family(), f.variant(), f.scope(),
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.SUBMITTED, 1, 1, null, null, "legacy-manifest-hash",
                Map.of(), null, null, null, null, null, List.of(), Instant.now(), Instant.now()));
        String sourceKey = ExamPackageIdentity.of(pkg).sourceKey();
        List<ExamImportPlanner.ReplacementMapping> exact = List.of(new ExamImportPlanner.ReplacementMapping(
                "FORM_REAL_CAMBRIDGE_IELTS_VOL_17_TEST_01", "REAL_CAMBRIDGE_IELTS_VOL_17_TEST_01", sourceKey, "EXACT_SOURCE_MATCH"));
        ExamImportPlanner.Plan real = plan(key, pkg, exact);
        assertEquals(ExamImportPlanner.Operation.BLOCKED, real.operation(), "the real gate is READY_EXCEPT_HUMAN_QA");
        assertEquals(1, real.retireConsiderations().size());
        // planning semantics with a hypothetical IMPORT_READY decision (test-only value, never produced by the gate here)
        ExamReleaseReadinessGate.Decision hypothetical = new ExamReleaseReadinessGate.Decision(pkg.manifest().packageId(),
                true, true, true, true, true, true, true, List.of(), false);
        ExamImportPlanner.Plan rp = ExamImportPlanner.plan(pkg, STRUCT.get(key), hypothetical, null, exact, reader,
                ExamImportPlanner.Target.LOCAL_DRY_RUN);
        assertEquals(ExamImportPlanner.Operation.REPLACEMENT_CANDIDATE, rp.operation());
        assertEquals(false, rp.retireConsiderations().get(0).get("executedByPlan"));
        ExamImportPlanner.Plan review = ExamImportPlanner.plan(pkg, STRUCT.get(key), hypothetical, null,
                List.of(new ExamImportPlanner.ReplacementMapping(exact.get(0).legacyLogicalKey(), "x", sourceKey, "REVIEW_REQUIRED")),
                reader, ExamImportPlanner.Target.LOCAL_DRY_RUN);
        assertEquals(ExamImportPlanner.Operation.CREATE, review.operation(), "unproven mapping never drives replacement");
        // the canonical form arrives (owner local basis); the legacy form and its attempt are untouched
        importer.importPackage(pkg, 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN);
        assertEquals("PUBLISHED", jdbc.queryForObject("SELECT lifecycle_state FROM exams.form_versions WHERE id = ?", String.class, legacyId));
        assertEquals(legacyId, attemptRepository.findAttemptById(legacyAttempt).orElseThrow().formId());
        assertEquals(ExamImportPlanner.Operation.ALREADY_IMPORTED, plan(key, pkg, exact).operation());
        row(key).put("replacement", Map.of("realPlan", real.operation().name(), "hypotheticalImportReadyPlan", rp.operation().name(),
                "retireConsiderations", rp.retireConsiderations().size(), "legacyLifecycleAfterImport", "PUBLISHED (not retired)",
                "legacyAttemptPinned", true));
    }

    /** Attempt / scoring helpers (same snapshot + pinned basis path as ExamAttemptService#createAttempt). */
    static final class Helpers {
        static final Map<UUID, SubmissionRecord> SUBMISSIONS = new HashMap<>();

        static AttemptRecord createAttempt(FormVersionRecord form, ExamAttemptMode mode) {
            ExamManifestService.FormSnapshotResult snap = manifestService.serializeFormSnapshot(form);
            Map<String, Object> pinned = com.englishcoach.exams.service.ExamAttemptService.pinEvidenceBasis(snap,
                    validation.evaluate(form.id()), form, mode, EnumSet.of(SkillType.LISTENING, SkillType.READING));
            UUID id = UUID.randomUUID();
            attemptRepository.insertAttempt(new AttemptRecord(id, 101L, form.id(), form.family(), form.variant(), form.scope(), mode,
                    null, null, ExamAttemptStatus.SUBMITTED, 1, 1, null, null, snap.hash(),
                    Map.of("selectedSkills", List.of("LISTENING", "READING")), Instant.now(), Instant.now(), null, Instant.now(), null,
                    List.of(), Instant.now(), Instant.now(), pinned, snap.version(), ExamSnapshotState.SNAPSHOTTED));
            for (SectionRecord s : contentRepository.findSectionsByFormId(form.id())) {
                if (s.skill() == SkillType.LISTENING || s.skill() == SkillType.READING) {
                    attemptRepository.insertAttemptSection(new AttemptSectionRecord(null, id, s.id(), ExamSectionState.COMPLETED,
                            "MAIN", Instant.now(), null, Instant.now(), Map.of(), Instant.now()));
                }
            }
            return attemptRepository.findAttemptById(id).orElseThrow();
        }

        @SuppressWarnings("unchecked")
        static Map<ScoreMetric, ScoreComponentRecord> scoreAllCorrect(AttemptRecord attempt) {
            PublicAttemptManifestDto manifest = manifestService.compileAttemptManifest(attempt);
            Map<UUID, String[]> placement = new HashMap<>();
            for (PublicSectionDto s : manifest.sections()) for (PublicPartDto p : s.parts()) for (PublicGroupDto g : p.groups())
                for (PublicItemDto it : g.items()) placement.put(it.id(), new String[]{s.id().toString(), it.placementId()});
            ExamAttemptSnapshotContent snap = ExamAttemptSnapshotContent.parse(attempt.manifestSnapshot()).orElseThrow();
            Map<String, List<ExamAttemptSnapshotContent.SnapshotItem>> sets = new LinkedHashMap<>();
            for (ExamAttemptSnapshotContent.SnapshotItem it : snap.allItems()) {
                AnswerSpecRecord spec = it.answerSpec();
                if (spec == null || !placement.containsKey(it.itemId())) continue;
                if (spec.acceptedAnswers() != null && spec.acceptedAnswers().get("unorderedSet") instanceof Map<?, ?> set) {
                    sets.computeIfAbsent(String.valueOf(set.get("questions")), k -> new ArrayList<>()).add(it);
                    continue;
                }
                List<String> accepted = ExamObjectiveScorer.nonBlankAccepted(spec.acceptedAnswers());
                if (!accepted.isEmpty()) put(attempt, placement.get(it.itemId()), it.itemId(), accepted.get(0));
            }
            for (List<ExamAttemptSnapshotContent.SnapshotItem> members : sets.values()) {
                members.sort(Comparator.comparing(ExamAttemptSnapshotContent.SnapshotItem::questionNumber));
                List<String> values = new ArrayList<>((List<String>) ((Map<String, Object>) members.get(0).answerSpec()
                        .acceptedAnswers().get("unorderedSet")).get("values"));
                for (int i = 0; i < members.size(); i++) {
                    put(attempt, placement.get(members.get(i).itemId()), members.get(i).itemId(), values.get(i % values.size()));
                }
            }
            SubmissionRecord sub = new SubmissionRecord(UUID.randomUUID(), attempt.id(), SubmissionReason.MANUAL, Instant.now(),
                    Map.of(), attempt.pinnedManifestHash(), Map.of(), "phase5-" + attempt.id(), Instant.now());
            attemptRepository.insertSubmission(sub);
            SUBMISSIONS.put(attempt.id(), sub);
            return components(worker.scoreObjectiveSubmissionDirectly(sub, attempt));
        }

        static void put(AttemptRecord attempt, String[] placement, UUID itemId, String value) {
            attemptRepository.upsertResponse(attempt.id(), UUID.fromString(placement[0]), placement[1], itemId,
                    Map.of("value", value), value, null, false, null, "phase5");
        }

        static Map<ScoreMetric, ScoreComponentRecord> components(ScoreArtifactRecord art) {
            Map<ScoreMetric, ScoreComponentRecord> out = new EnumMap<>(ScoreMetric.class);
            for (ScoreComponentRecord c : scoringRepository.findComponentsByArtifactId(art.id())) out.put(c.metric(), c);
            return out;
        }

        static Map<String, String> evidenceDecisions(AttemptRecord attempt) {
            ExamAttemptEvidenceBasis.Resolution basis = ExamAttemptEvidenceBasis.resolveFromSnapshot(attempt.snapshotState(),
                    attempt.manifestSnapshot(), attempt.formId(), attempt.attemptMode().name());
            Map<String, String> out = new TreeMap<>();
            for (String metric : List.of("LISTENING", "READING")) {
                out.put(metric, ExamEvidenceEligibilityPolicy.decide(attempt.attemptMode().name(), "COMPLETED", metric, 7.0,
                        false, basis).reason().name());
            }
            return out;
        }
    }
}
