package com.englishcoach.exams.release;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageImporter.ImportRightsBasis;
import com.englishcoach.exams.content.ExamContentPackageValidationException;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.job.ExamJobWorker;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamScoringRecords.ScoreArtifactRecord;
import com.englishcoach.exams.model.ExamScoringRecords.ScoreComponentRecord;
import com.englishcoach.exams.model.ExamTypes.*;
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
import com.englishcoach.exams.validation.ExamContentValidationRepository;
import com.englishcoach.exams.validation.ExamAttemptEvidenceBasis;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
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

/**
 * Exams Recovery Phase 4D.7 — LOCAL import dry run on an isolated PostgreSQL 17 Testcontainer (never the dev or
 * production database): exams migrations V1–V10 + the production drift shape + V71 + V72 (local), then
 * package → importer (owner-authorized LOCAL dry-run basis) → DB → Phase 2 validation → catalog DTO → attempt snapshot
 * → learner manifest → objective scorer, for Cambridge IELTS 17 T1, Cambridge IELTS 21 T3, ETS 2026 T1 and T2.
 * Also: production basis still refuses, import twice is idempotent, a replacement package version leaves historical
 * attempts on their version, content edited after an attempt started does not change its score, Practice creates no
 * official evidence. Writes imports/exams/staging/reports/phase4_import_dry_run.json (ids, counts, booleans only).
 * Skips without Docker or without the local staged packages. Needs -Dapi.version=1.44 on this machine.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamImportDryRunPostgresTest {

    private static final Path MIGRATIONS = Path.of("src/main/resources/db/migration/exams");
    private static final Path STAGING = Path.of("..", "imports", "exams", "staging");
    private static final Map<String, String> TARGETS = new LinkedHashMap<>();
    static {
        TARGETS.put("CAM17_T1", "extracted/ielts/cambridge/cambridge-ielts-17/cambridge-ielts-17__test-1.json");
        TARGETS.put("CAM21_T3", "extracted/ielts/cambridge/cambridge-ielts-21/cambridge-ielts-21__test-3.json");
        TARGETS.put("ETS26_T1", "extracted/toeic/ets/ets-2026/ets-2026__test-1.json");
        TARGETS.put("ETS26_T2", "extracted/toeic/ets/ets-2026/ets-2026__test-2.json");
    }

    static PostgreSQLContainer<?> pg;
    static com.zaxxer.hikari.HikariDataSource POOL;
    static JdbcTemplate jdbc;
    static NamedParameterJdbcTemplate named;
    static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    static ExamContentRepository contentRepository;
    static ExamAttemptRepository attemptRepository;
    static ExamScoringRepository scoringRepository;
    static ExamContentValidationService validation;
    static ExamContentPackageImporter importer;
    static ExamManifestService manifestService;
    static ExamJobWorker worker;
    static ExamContentService catalog;
    static final Map<String, ExamContentPackage> PKGS = new LinkedHashMap<>();
    static final Map<String, UUID> FORMS = new LinkedHashMap<>();
    static final Map<String, AttemptRecord> ATTEMPTS = new LinkedHashMap<>();
    static final Map<String, SubmissionRecord> SUBMISSIONS = new LinkedHashMap<>();
    static final Map<String, Object> REPORT = new LinkedHashMap<>();

    @BeforeAll
    static void setUp() throws Exception {
        assumeTrue(Files.isDirectory(STAGING.resolve("extracted")), "staged packages not present (local data)");
        for (Map.Entry<String, String> t : TARGETS.entrySet()) {
            assumeTrue(Files.isRegularFile(STAGING.resolve(t.getValue())), "missing " + t.getValue());
            PKGS.put(t.getKey(), MAPPER.readValue(STAGING.resolve(t.getValue()).toFile(), ExamContentPackage.class));
        }
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker not available — PostgreSQL dry run skipped");
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        // Exams Phase 9H: pooled (one TCP connection per statement exhausted Windows ephemeral ports in batch runs)
        POOL = com.englishcoach.exams.ExamTestDataSources.pooled(pg);
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
        String v72 = Files.readString(MIGRATIONS.resolve("V72__exams_project_usage_authorization.sql"));
        jdbc.execute(v72);
        jdbc.execute(v72); // idempotent

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
    }

    @AfterAll
    static void tearDown() throws Exception {
        if (pg != null) {
            if (POOL != null) POOL.close();
            pg.stop();
            REPORT.put("generatedBy", "ExamImportDryRunPostgresTest (Exams Recovery Phase 4D.7, isolated PostgreSQL 17)");
            MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT)
                    .writeValue(STAGING.resolve("reports").resolve("phase4_import_dry_run.json").toFile(), REPORT);
        }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> row(String key) {
        return (Map<String, Object>) REPORT.computeIfAbsent(key, k -> new LinkedHashMap<String, Object>());
    }

    static int count(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM exams." + table, Integer.class);
    }

    @Test
    @Order(1)
    @DisplayName("production basis (publisher licence) still refuses every staged package; owner basis is off by default")
    void productionBasisRefuses() {
        for (Map.Entry<String, ExamContentPackage> e : PKGS.entrySet()) {
            ExamContentPackageValidationException ex = assertThrows(ExamContentPackageValidationException.class,
                    () -> importer.importPackage(e.getValue(), 1L, ImportRightsBasis.PUBLISHER_LICENCE));
            assertTrue(ex.errors().stream().anyMatch(err -> err.code().startsWith("RIGHTS_")), e.getKey() + ": " + ex.getMessage());
            assertTrue(ex.errors().stream().allMatch(err -> err.code().startsWith("RIGHTS_")),
                    e.getKey() + ": only the publisher-licence rights block the package: " + ex.getMessage());
        }
        assertEquals(0, count("form_versions"));
        ExamContentPackageImporter fresh = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(MAPPER));
        IllegalStateException off = assertThrows(IllegalStateException.class,
                () -> fresh.importPackage(PKGS.get("CAM17_T1"), 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN));
        assertTrue(off.getMessage().startsWith("CONTENT_IMPORT_BASIS_DISABLED"));
    }

    @Test
    @Order(2)
    @DisplayName("owner-authorized LOCAL import: imported once; a second import of the same package is idempotent")
    void importAndIdempotency() {
        for (Map.Entry<String, ExamContentPackage> e : PKGS.entrySet()) {
            ExamContentPackage.ImportResult r = importer.importPackage(e.getValue(), 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN);
            assertEquals(ExamContentPackage.ImportStatus.IMPORTED, r.status(), e.getKey());
            FORMS.put(e.getKey(), r.formId());
            row(e.getKey()).put("import", "IMPORTED");
            row(e.getKey()).put("formId", r.formId().toString());
        }
        Map<String, Integer> before = new LinkedHashMap<>();
        for (String t : List.of("form_versions", "sections", "parts", "group_versions", "form_groups", "item_versions",
                "answer_specs", "stimulus_versions", "assets", "stimulus_assets", "content_package_imports", "project_usage_authorizations")) {
            before.put(t, count(t));
        }
        for (Map.Entry<String, ExamContentPackage> e : PKGS.entrySet()) {
            ExamContentPackage.ImportResult again = importer.importPackage(e.getValue(), 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN);
            assertEquals(ExamContentPackage.ImportStatus.ALREADY_IMPORTED, again.status());
            assertTrue(again.idempotentReplay());
            assertEquals(FORMS.get(e.getKey()), again.formId());
            row(e.getKey()).put("idempotency", "ALREADY_IMPORTED (no new rows)");
        }
        for (Map.Entry<String, Integer> b : before.entrySet()) {
            assertEquals(b.getValue(), count(b.getKey()), "duplicate rows in " + b.getKey());
        }
        REPORT.put("rowCountsAfterImport", before);
    }

    @Test
    @Order(3)
    @DisplayName("owner authorization stored apart from the publisher licence (UNKNOWN / PENDING kept); provenance preserved")
    void authorizationAndProvenance() {
        for (Map.Entry<String, ExamContentPackage> e : PKGS.entrySet()) {
            ExamContentPackage pkg = e.getValue();
            Map<String, Object> a = jdbc.queryForMap("SELECT status, publisher_licence, publisher_endorsement, production_import, "
                    + "import_basis, source_identity->>'rawSourceSha256' AS raw_sha, source_provenance->>'rawManifestRef' AS manifest_ref, "
                    + "display_name_at_import FROM exams.project_usage_authorizations WHERE package_id = ? AND package_version = ?",
                    pkg.manifest().packageId(), pkg.manifest().packageVersion());
            assertEquals("OWNER_AUTHORIZED", a.get("status"));
            assertEquals("NOT_ESTABLISHED", a.get("publisher_licence"));
            assertEquals(Boolean.FALSE, a.get("publisher_endorsement"));
            assertEquals("OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN", a.get("import_basis"));
            Map<String, Object> prov = (Map<String, Object>) pkg.manifest().metadata().get("sourceProvenance");
            assertEquals(((Map<?, ?>) prov.get("rawSourceFile")).get("sha256"), a.get("raw_sha"));
            assertEquals(prov.get("rawManifestRef"), a.get("manifest_ref"));
            List<Map<String, Object>> lic = jdbc.queryForList("SELECT l.provenance_category, l.legal_status FROM exams.licenses l "
                    + "JOIN exams.sources s ON s.id = l.source_id WHERE s.source_type = 'THIRD_PARTY_PUBLICATION' AND l.id IN (:ids)"
                    .replace(":ids", String.join(",", pkg.licenses().stream().map(x -> "'" + x.id() + "'").toList())));
            assertFalse(lic.isEmpty());
            for (Map<String, Object> l : lic) {
                assertEquals("UNKNOWN", l.get("provenance_category"));
                assertEquals("PENDING", l.get("legal_status"));
            }
            String findings = jdbc.queryForObject("SELECT findings::text FROM exams.content_qa_runs WHERE form_id = ?", String.class,
                    FORMS.get(e.getKey()));
            assertTrue(findings.contains("OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN") && findings.contains("PENDING_LEGAL_REVIEW"));
            Map<String, Object> r = row(e.getKey());
            r.put("projectAuthorization", "OWNER_AUTHORIZED (publisher licence UNKNOWN/PENDING unchanged)");
            r.put("provenancePreserved", true);
            r.put("displayNameAtImport", a.get("display_name_at_import") != null);
        }
        assertThrows(Exception.class, () -> jdbc.update("UPDATE exams.project_usage_authorizations SET scope = 'X'"));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM exams.project_usage_authorizations"));
    }

    @Test
    @Order(4)
    @DisplayName("DB-loaded validation = package validation (VALID); catalog DTO lists the PILOT form as fully runnable")
    void validationAndCatalog() {
        for (Map.Entry<String, ExamContentPackage> e : PKGS.entrySet()) {
            UUID formId = FORMS.get(e.getKey());
            ExamFormValidationReport fromPkg = validation.validatePackage(e.getValue());
            ExamFormValidationReport fromDb = validation.revalidate(formId, ExamContentValidationService.Trigger.IMPORT);
            assertEquals(fromPkg.status(), fromDb.status(), e.getKey() + " " + fromDb.blockingCodes());
            assertEquals(fromPkg.blockingCodes(), fromDb.blockingCodes());
            assertTrue(fromDb.fullSimulationEligible(), e.getKey() + " " + fromDb.blockingCodes());
            row(e.getKey()).put("validation", fromDb.status().name());
            jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'PILOT' WHERE id = ?", formId);
            ExamFamily family = e.getValue().form().family();
            CatalogFormDto dto = catalog.getCatalog(family, null, null, 50, 0, true).stream()
                    .filter(c -> c.id().equals(formId)).findFirst().orElseThrow(() -> new AssertionError("not in catalog: " + e.getKey()));
            assertTrue(dto.fullExamRunnable(), e.getKey());
            assertTrue(dto.availableModes().contains("EXAM_SIMULATION"), dto.availableModes().toString());
            row(e.getKey()).put("catalog", "listed; fullExamRunnable=" + dto.fullExamRunnable() + " modes=" + dto.availableModes());
        }
    }

    @Test
    @Order(5)
    @DisplayName("attempt snapshot → manifest → scorer: all-correct answers score full marks; Practice creates no evidence")
    void snapshotManifestScoring() {
        for (Map.Entry<String, ExamContentPackage> e : PKGS.entrySet()) {
            String key = e.getKey();
            UUID formId = FORMS.get(key);
            FormVersionRecord form = contentRepository.findFormById(formId).orElseThrow();
            AttemptRecord attempt = createPracticeAttempt(form);
            ATTEMPTS.put(key, attempt);
            PublicAttemptManifestDto manifest = manifestService.compileAttemptManifest(attempt);

            Map<UUID, String[]> placement = new HashMap<>();
            int presented = 0, chooseN = 0, withLimit = 0, segmentedDocs = 0, assetsTotal = 0, grantAssets = 0, presentations = 0;
            for (PublicSectionDto s : manifest.sections()) for (PublicPartDto p : s.parts()) for (PublicGroupDto g : p.groups()) {
                if (g.presentation() != null) presentations++;
                for (PublicItemDto it : g.items()) {
                    placement.put(it.id(), new String[]{s.id().toString(), it.placementId()});
                    presented++;
                    if (it.cardinality() == 2) chooseN++;
                    if (it.wordLimit() != null) withLimit++;
                }
                for (PublicStimulusDto st : g.stimuli()) {
                    if ("MULTI_DOC".equals(st.kind()) && "SEGMENTED".equals(st.bodyPayload().get("documentBoundaries"))) segmentedDocs++;
                    for (PublicAssetRefDto a : st.assets()) {
                        assetsTotal++;
                        if ("PLAYBACK_GRANT".equals(a.delivery())) grantAssets++;
                    }
                }
            }
            assertEquals(assetsTotal, grantAssets, "every asset resolvable through a grant");
            assertTrue(presentations > 0, "group presentation carried");
            if (key.startsWith("ETS")) {
                assertEquals(200, presented);
                assertTrue(segmentedDocs > 0, "segmented multi-document Part 7 sets reach the runner");
            }
            if (key.equals("CAM17_T1")) {
                assertTrue(chooseN >= 2, "choose-TWO cardinality reaches the runner");
                assertTrue(withLimit > 0, "word limits reach the runner");
            }

            ExamAttemptSnapshotContent snap = ExamAttemptSnapshotContent.parse(attempt.manifestSnapshot()).orElseThrow();
            answerAll(attempt, snap, placement, false);
            ScoreArtifactRecord art = score(key, attempt);
            Map<ScoreMetric, ScoreComponentRecord> comps = components(art);
            double expected = key.startsWith("ETS") ? 100 : 40;
            assertEquals(expected, comps.get(ScoreMetric.LISTENING).rawScore(), key);
            assertEquals(expected, comps.get(ScoreMetric.READING).rawScore(), key);
            assertEquals(key.startsWith("ETS") ? 495.0 : 9.0, comps.get(ScoreMetric.LISTENING).scaledScore(), key);
            assertEquals("ATTEMPT_SNAPSHOT", art.versionBundle().get("objectiveContentSource"));
            assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM exams.profile_evidence WHERE attempt_id = ?", Integer.class,
                    attempt.id()), "Practice never creates official evidence");
            Map<String, Object> r = row(key);
            r.put("attemptSnapshot", "SNAPSHOTTED v4.0");
            r.put("manifest", Map.of("items", presented, "groupsWithPresentation", presentations, "chooseNItems", chooseN,
                    "itemsWithWordLimit", withLimit, "segmentedMultiDocStimuli", segmentedDocs, "assets", assetsTotal,
                    "grantDelivery", grantAssets));
            r.put("scoringContract", Map.of("listeningRaw", comps.get(ScoreMetric.LISTENING).rawScore(),
                    "readingRaw", comps.get(ScoreMetric.READING).rawScore(),
                    "listeningScaled", comps.get(ScoreMetric.LISTENING).scaledScore(),
                    "readingScaled", comps.get(ScoreMetric.READING).scaledScore(),
                    "contentSource", art.versionBundle().get("objectiveContentSource"), "practiceEvidence", 0));
        }
    }

    @Test
    @Order(6)
    @DisplayName("choose-TWO duplicate on Cambridge 17 T1 earns one mark, not two")
    void chooseTwoDuplicate() {
        UUID formId = FORMS.get("CAM17_T1");
        AttemptRecord attempt = createPracticeAttempt(contentRepository.findFormById(formId).orElseThrow());
        PublicAttemptManifestDto manifest = manifestService.compileAttemptManifest(attempt);
        Map<UUID, String[]> placement = placements(manifest);
        answerAll(attempt, ExamAttemptSnapshotContent.parse(attempt.manifestSnapshot()).orElseThrow(), placement, true);
        Map<ScoreMetric, ScoreComponentRecord> comps = components(score("CAM17_T1_DUP", attempt));
        assertEquals(39.0, comps.get(ScoreMetric.LISTENING).rawScore(), "one duplicated pair loses exactly one mark");
        row("CAM17_T1").put("chooseTwoDuplicate", "listening raw 39/40 (duplicate selection credited once)");
    }

    @Test
    @Order(7)
    @DisplayName("content edited after the attempt started does not change the attempt's score (snapshot scoring)")
    void snapshotSafety() {
        AttemptRecord attempt = ATTEMPTS.get("ETS26_T1");
        SubmissionRecord sub = SUBMISSIONS.get("ETS26_T1");
        ExamAttemptSnapshotContent snap = ExamAttemptSnapshotContent.parse(attempt.manifestSnapshot()).orElseThrow();
        ExamAttemptSnapshotContent.SnapshotItem first = snap.sections().stream()
                .filter(s -> s.skill() == SkillType.READING).findFirst().orElseThrow().items().get(0);
        jdbc.update("UPDATE exams.answer_specs SET accepted_answers = '{\"values\":[\"EDITED\"]}'::jsonb WHERE item_id = ?", first.itemId());
        ScoreArtifactRecord rescored = worker.scoreObjectiveSubmissionDirectly(sub, attemptRepository.findAttemptById(attempt.id()).orElseThrow());
        assertEquals(100.0, components(rescored).get(ScoreMetric.READING).rawScore(), "historical truth = the pinned snapshot");
        row("ETS26_T1").put("snapshotSafety", "answer spec edited after attempt creation; rescore still 100/100 from the snapshot");
    }

    @Test
    @Order(8)
    @DisplayName("replacement import = new form VERSION; the historical attempt keeps its version and its score")
    void replacementVersion() throws Exception {
        ExamContentPackage v2 = successorVersion(TARGETS.get("CAM17_T1"));
        ExamContentPackage.ImportResult r = importer.importPackage(v2, 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN);
        assertEquals(ExamContentPackage.ImportStatus.IMPORTED, r.status());
        UUID v1Form = FORMS.get("CAM17_T1");
        assertNotEquals(v1Form, r.formId());
        assertEquals(2, contentRepository.findFormById(r.formId()).orElseThrow().version());
        AttemptRecord old = attemptRepository.findAttemptById(ATTEMPTS.get("CAM17_T1").id()).orElseThrow();
        assertEquals(v1Form, old.formId(), "historical attempt still references the old version");
        assertEquals(contentRepository.findItemsByFormId(v1Form).size(), PKGS.get("CAM17_T1").items().size(),
                "the old version's items are untouched");
        ScoreArtifactRecord rescored = worker.scoreObjectiveSubmissionDirectly(SUBMISSIONS.get("CAM17_T1"), old);
        assertEquals(40.0, components(rescored).get(ScoreMetric.LISTENING).rawScore());
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM exams.project_usage_authorizations WHERE package_id = ?",
                Integer.class, v2.manifest().packageId()));
        row("CAM17_T1").put("replacement", "package v2 → form version 2 (new id); v1 rows and the v1 attempt unchanged");
    }

    @Test
    @Order(9)
    @DisplayName("4.1D: evidence decision of a v1 attempt is unchanged after v1 is invalidated / retired and v2 published")
    void snapshotEvidenceStable() {
        UUID v1 = FORMS.get("CAM17_T1");
        FormVersionRecord form = contentRepository.findFormById(v1).orElseThrow();
        AttemptRecord sim = createAttempt(form, ExamAttemptMode.EXAM_SIMULATION);
        Map<String, String> before = evidenceDecisions(attemptRepository.findAttemptById(sim.id()).orElseThrow());
        assertEquals("ELIGIBLE", before.get("LISTENING"));
        assertEquals("ELIGIBLE", before.get("READING"));
        assertEquals("PRACTICE_MODE", evidenceDecisions(ATTEMPTS.get("CAM17_T1")).get("READING"), "Practice stays ineligible");

        // day 30: v2 published, v1 retired AND restricted by an operator flag; current validation of v1 now refuses
        UUID v2 = jdbc.queryForObject("SELECT id FROM exams.form_versions WHERE logical_key = ? AND version = 2", UUID.class,
                form.logicalKey());
        jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'PUBLISHED', published_at = now() WHERE id = ?", v2);
        jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'RETIRED', primary_health_status = 'DISABLED' WHERE id = ?", v1);
        validation.invalidate(v1);
        assertFalse(validation.evaluate(v1).isSimulationReady(SkillType.READING), "current validation of v1 changed");

        AttemptRecord reread = attemptRepository.findAttemptById(sim.id()).orElseThrow();
        assertEquals(before, evidenceDecisions(reread), "reconciliation answer = the pinned basis, unchanged");
        ExamAttemptEvidenceBasis.Resolution basis = ExamAttemptEvidenceBasis.resolveFromSnapshot(reread.snapshotState(),
                reread.manifestSnapshot(), reread.formId(), reread.attemptMode().name());
        assertEquals("PILOT", basis.basis().formLifecycleState(), "lifecycle pinned at attempt time (dry-run forms are PILOT)");

        // the Proficiency read path (live listener / nightly reconciliation / backfill) reads the same pinned basis
        UUID sub = UUID.randomUUID(), art = UUID.randomUUID();
        jdbc.update("INSERT INTO exams.submissions (id, attempt_id, reason, cutoff_time, response_snapshot, manifest_hash, "
                + "submission_hash) VALUES (?, ?, 'MANUAL', now(), '{}'::jsonb, 'h', 'h')", sub, sim.id());
        jdbc.update("INSERT INTO exams.score_artifacts (id, submission_id, run_ordinal, version_bundle, evidence_hash, result_status) "
                + "VALUES (?, ?, 1, '{}'::jsonb, 'h', 'COMPLETED')", art, sub);
        com.englishcoach.proficiency.ProficiencySourceReadRepository.ExamArtifact row =
                new com.englishcoach.proficiency.ProficiencySourceReadRepository(named).examArtifact(art).orElseThrow();
        assertEquals("RETIRED", row.lifecycleState(), "the current form state is visible ...");
        assertEquals("SNAPSHOTTED", row.snapshotState());
        Map<String, Object> stored;
        try {
            stored = MAPPER.readValue(row.evidenceBasisJson(), Map.class);
        } catch (Exception ex) {
            throw new AssertionError(ex);
        }
        assertEquals(basis.basis(), ExamAttemptEvidenceBasis.fromMap(stored).orElseThrow(), "... but the pinned basis decides");

        // legacy attempt without a basis fails safely
        AttemptRecord legacy = new AttemptRecord(sim.id(), 101L, v1, form.family(), form.variant(), form.scope(),
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.SUBMITTED, 1, 1, null, null, null, Map.of(),
                null, null, null, null, null, List.of(), Instant.now(), Instant.now());
        assertEquals("LEGACY_VALIDATION_UNAVAILABLE", evidenceDecisions(legacy).get("READING"));
        row("CAM17_T1").put("snapshotEvidence", Map.of("before", before, "afterV1RetiredDisabledAndV2Published", evidenceDecisions(reread),
                "currentV1SimulationReadyReading", false, "pinnedLifecycle", "PILOT", "legacy", "LEGACY_VALIDATION_UNAVAILABLE",
                "practice", "PRACTICE_MODE"));
        jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'PILOT', primary_health_status = NULL WHERE id = ?", v1);
        validation.invalidate(v1);
    }

    /** Skill → policy reason for a completed attempt scored on both objective skills (no AI fallback). */
    static Map<String, String> evidenceDecisions(AttemptRecord attempt) {
        ExamAttemptEvidenceBasis.Resolution basis = ExamAttemptEvidenceBasis.resolveFromSnapshot(attempt.snapshotState(),
                attempt.manifestSnapshot(), attempt.formId(), attempt.attemptMode().name());
        Map<String, String> out = new TreeMap<>();
        for (String metric : List.of("LISTENING", "READING")) {
            out.put(metric, ExamEvidenceEligibilityPolicy.decide(attempt.attemptMode().name(), "COMPLETED", metric, 7.0, false,
                    basis).reason().name());
        }
        return out;
    }

    // ------------------------------------------------------------------------------------------------------------

    static AttemptRecord createPracticeAttempt(FormVersionRecord form) {
        return createAttempt(form, ExamAttemptMode.PRACTICE);
    }

    /** Same snapshot + pinned evidence basis as ExamAttemptService#createAttempt (shared helper). */
    static AttemptRecord createAttempt(FormVersionRecord form, ExamAttemptMode mode) {
        ExamManifestService.FormSnapshotResult snap = manifestService.serializeFormSnapshot(form);
        Map<String, Object> pinned = com.englishcoach.exams.service.ExamAttemptService.pinEvidenceBasis(snap,
                validation.evaluate(form.id()), form, mode, EnumSet.of(SkillType.LISTENING, SkillType.READING));
        UUID id = UUID.randomUUID();
        AttemptRecord a = new AttemptRecord(id, 101L, form.id(), form.family(), form.variant(), form.scope(), mode,
                null, null, ExamAttemptStatus.SUBMITTED, 1, 1, null, null, snap.hash(),
                Map.of("selectedSkills", List.of("LISTENING", "READING")), Instant.now(), Instant.now(), null, Instant.now(), null,
                List.of(), Instant.now(), Instant.now(), pinned, snap.version(), ExamSnapshotState.SNAPSHOTTED);
        attemptRepository.insertAttempt(a);
        for (SectionRecord s : contentRepository.findSectionsByFormId(form.id())) {
            if (s.skill() == SkillType.LISTENING || s.skill() == SkillType.READING) {
                attemptRepository.insertAttemptSection(new AttemptSectionRecord(null, id, s.id(), ExamSectionState.COMPLETED,
                        "MAIN", Instant.now(), null, Instant.now(), Map.of(), Instant.now()));
            }
        }
        return attemptRepository.findAttemptById(id).orElseThrow();
    }

    static Map<UUID, String[]> placements(PublicAttemptManifestDto manifest) {
        Map<UUID, String[]> out = new HashMap<>();
        for (PublicSectionDto s : manifest.sections()) for (PublicPartDto p : s.parts()) for (PublicGroupDto g : p.groups())
            for (PublicItemDto it : g.items()) out.put(it.id(), new String[]{s.id().toString(), it.placementId()});
        return out;
    }

    /** Answers every objective item with its pinned key; choose-TWO sets get their distinct keys (or one duplicate). */
    @SuppressWarnings("unchecked")
    static void answerAll(AttemptRecord attempt, ExamAttemptSnapshotContent snap, Map<UUID, String[]> placement, boolean duplicateOnePair) {
        Map<String, List<ExamAttemptSnapshotContent.SnapshotItem>> sets = new LinkedHashMap<>();
        for (ExamAttemptSnapshotContent.SnapshotItem it : snap.allItems()) {
            AnswerSpecRecord spec = it.answerSpec();
            if (spec == null || !placement.containsKey(it.itemId())) continue;
            if (spec.acceptedAnswers() != null && spec.acceptedAnswers().get("unorderedSet") instanceof Map<?, ?> set) {
                sets.computeIfAbsent(String.valueOf(set.get("questions")), k -> new ArrayList<>()).add(it);
                continue;
            }
            List<String> accepted = ExamObjectiveScorer.nonBlankAccepted(spec.acceptedAnswers());
            if (accepted.isEmpty()) continue;
            put(attempt, placement.get(it.itemId()), it.itemId(), accepted.get(0));
        }
        boolean duplicated = false;
        for (List<ExamAttemptSnapshotContent.SnapshotItem> members : sets.values()) {
            members.sort(Comparator.comparing(ExamAttemptSnapshotContent.SnapshotItem::questionNumber));
            List<String> values = new ArrayList<>((List<String>) ((Map<String, Object>) members.get(0).answerSpec().acceptedAnswers()
                    .get("unorderedSet")).get("values"));
            for (int i = 0; i < members.size(); i++) {
                String v = (duplicateOnePair && !duplicated) ? values.get(0) : values.get(i % values.size());
                put(attempt, placement.get(members.get(i).itemId()), members.get(i).itemId(), v);
            }
            if (duplicateOnePair) duplicated = true;
        }
    }

    static void put(AttemptRecord attempt, String[] placement, UUID itemId, String value) {
        attemptRepository.upsertResponse(attempt.id(), UUID.fromString(placement[0]), placement[1], itemId,
                Map.of("value", value), value, null, false, null, "dry-run");
    }

    static ScoreArtifactRecord score(String key, AttemptRecord attempt) {
        SubmissionRecord sub = new SubmissionRecord(UUID.randomUUID(), attempt.id(), SubmissionReason.MANUAL, Instant.now(), Map.of(),
                attempt.pinnedManifestHash(), Map.of(), "dry-run-" + attempt.id(), Instant.now());
        attemptRepository.insertSubmission(sub);
        SUBMISSIONS.put(key, sub);
        return worker.scoreObjectiveSubmissionDirectly(sub, attempt);
    }

    static Map<ScoreMetric, ScoreComponentRecord> components(ScoreArtifactRecord art) {
        Map<ScoreMetric, ScoreComponentRecord> out = new EnumMap<>(ScoreMetric.class);
        for (ScoreComponentRecord c : scoringRepository.findComponentsByArtifactId(art.id())) out.put(c.metric(), c);
        return out;
    }

    /**
     * Builds a successor package (packageVersion 2) the way a corrected re-extraction must: a NEW form version (new form /
     * section / part / placement ids), and for the one group whose content changed a NEW group version with new item
     * versions and answer specs; every unchanged group, stimulus and asset is shared by id + hash.
     */
    static ExamContentPackage successorVersion(String rel) throws Exception {
        String text = Files.readString(STAGING.resolve(rel));
        ObjectNode pkg = (ObjectNode) MAPPER.readTree(text);
        JsonNode changedGroup = null;
        for (JsonNode it : pkg.path("items")) {
            if ("TEXT_GAP".equals(it.path("interactionType").asText())) {
                for (JsonNode g : pkg.path("groups")) if (g.path("id").asText().equals(it.path("groupId").asText())) changedGroup = g;
                break;
            }
        }
        assertNotNull(changedGroup);
        String groupId = changedGroup.path("id").asText();
        Set<String> remap = new LinkedHashSet<>();
        remap.add(pkg.path("form").path("id").asText());
        pkg.path("sections").forEach(n -> remap.add(n.path("id").asText()));
        pkg.path("parts").forEach(n -> remap.add(n.path("id").asText()));
        pkg.path("formGroups").forEach(n -> remap.add(n.path("id").asText()));
        remap.add(groupId);
        Set<String> changedItems = new HashSet<>();
        pkg.path("items").forEach(n -> { if (n.path("groupId").asText().equals(groupId)) { remap.add(n.path("id").asText()); changedItems.add(n.path("id").asText()); } });
        pkg.path("answerSpecs").forEach(n -> { if (changedItems.contains(n.path("itemId").asText())) remap.add(n.path("id").asText()); });
        pkg.path("groupStimuli").forEach(n -> { if (n.path("groupId").asText().equals(groupId)) remap.add(n.path("id").asText()); });
        for (String old : remap) text = text.replace(old, UUID.nameUUIDFromBytes((old + ":v2").getBytes()).toString());
        ObjectNode v2 = (ObjectNode) MAPPER.readTree(text);
        ((ObjectNode) v2.path("manifest")).put("packageVersion", 2);
        ((ObjectNode) v2.path("form")).put("version", 2);
        String newGroup = UUID.nameUUIDFromBytes((groupId + ":v2").getBytes()).toString();
        for (JsonNode g : v2.path("groups")) if (g.path("id").asText().equals(newGroup)) ((ObjectNode) g).put("version", 2);
        Set<String> newItems = new HashSet<>();
        for (JsonNode it : v2.path("items")) if (it.path("groupId").asText().equals(newGroup)) {
            ((ObjectNode) it).put("version", 2);
            newItems.add(it.path("id").asText());
        }
        boolean edited = false;
        for (JsonNode s : v2.path("answerSpecs")) if (!edited && newItems.contains(s.path("itemId").asText())) {
            ArrayNode values = MAPPER.createArrayNode().add("corrected");
            ((ObjectNode) s.path("acceptedAnswers")).set("values", values);
            edited = true;
        }
        ExamContentPackage parsed = MAPPER.treeToValue(v2, ExamContentPackage.class);
        String hash = new ExamContentPackageValidator(MAPPER).computeContentHash(parsed);
        ((ObjectNode) v2.path("manifest")).put("contentHash", hash);
        return MAPPER.treeToValue(v2, ExamContentPackage.class);
    }
}
