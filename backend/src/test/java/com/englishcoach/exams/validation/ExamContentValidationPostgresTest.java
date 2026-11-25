package com.englishcoach.exams.validation;

import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Exams Phase 2 on PostgreSQL 17: exams migrations V1–V10, the production drift shape (untracked columns created
 * outside Flyway, nullable, no default), then V71 twice (idempotent). Real pilot packages go through the canonical
 * importer; the DB-loaded tree must validate exactly like the package tree, results persist append-only, and a
 * media-state change yields a new fingerprint and a new result.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamContentValidationPostgresTest {

    private static final Path MIGRATIONS = Path.of("src/main/resources/db/migration/exams");
    private static final Path PILOT = Path.of("..", "content", "exams", "original-pilot");

    static PostgreSQLContainer<?> pg;
    static com.zaxxer.hikari.HikariDataSource POOL;
    static JdbcTemplate jdbc;
    static NamedParameterJdbcTemplate named;
    static ObjectMapper mapper;
    static ExamContentValidationRepository validationRepository;
    static ExamContentValidationService service;
    static ExamContentPackageImporter importer;

    @BeforeAll
    static void setUp() throws Exception {
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker not available — PostgreSQL test skipped");
        assumeTrue(Files.isDirectory(PILOT), "pilot content directory not present");
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        // Exams Phase 9H: pooled (one TCP connection per statement exhausted Windows ephemeral ports in batch runs)
        POOL = com.englishcoach.exams.ExamTestDataSources.pooled(pg);
        javax.sql.DataSource ds = POOL;
        jdbc = new JdbcTemplate(ds);
        named = new NamedParameterJdbcTemplate(ds);
        mapper = new ObjectMapper().findAndRegisterModules();
        jdbc.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, email VARCHAR(255)); "
                + "INSERT INTO public.users VALUES (1, 'author@example.test'), (2, 'reviewer@example.test');");
        for (String v : List.of("V1__content.sql", "V2__runtime.sql", "V3__scoring_profile.sql", "V4__integrity_operations.sql",
                "V5__content_factory.sql", "V6__exams_measurement_pipeline.sql", "V7__exams_profile_production_eligibility.sql",
                "V8__exams_content_import_compatibility.sql", "V9__exams_form_components_role_expansion.sql",
                "V10__exams_runtime_v4_turns_and_evidence.sql")) {
            jdbc.execute(Files.readString(MIGRATIONS.resolve(v)));
        }
        // Production drift shape (EXAM-AUD-007): columns created outside Flyway, nullable, without defaults.
        jdbc.execute("ALTER TABLE exams.sections ADD COLUMN is_runnable BOOLEAN; "
                + "ALTER TABLE exams.sections ADD COLUMN health_status VARCHAR(32); "
                + "ALTER TABLE exams.form_versions ADD COLUMN primary_health_status VARCHAR(32); "
                + "ALTER TABLE exams.item_versions ADD COLUMN ordinal INTEGER;");
        String v71 = Files.readString(MIGRATIONS.resolve("V71__exams_content_validation_truth.sql"));
        jdbc.execute(v71);
        jdbc.execute(v71); // idempotent / non-destructive re-run

        ExamContentRepository contentRepository = new ExamContentRepository(named, mapper);
        importer = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(mapper));
        validationRepository = new ExamContentValidationRepository(named, mapper);
        service = new ExamContentValidationService(validationRepository, mapper,
                new TransactionTemplate(new DataSourceTransactionManager(ds)), Clock.systemUTC());
        importer.setValidationService(service);
    }

    @AfterAll
    static void tearDown() {
        if (POOL != null) POOL.close();
        if (pg != null) pg.stop();
    }

    /**
     * Some pilot files carry a stale declared hash (pre-existing ExamContentBatchValidatorTest failure); this test is
     * about validation, not sealing, so the manifest hash is re-computed locally before import.
     */
    private static ExamContentPackage pkg(String file) throws Exception {
        ExamContentPackage p = mapper.readValue(PILOT.resolve(file).toFile(), ExamContentPackage.class);
        String hash = new ExamContentPackageValidator(mapper).computeContentHash(p);
        ExamContentPackage.PackageManifest m = p.manifest();
        return new ExamContentPackage(new ExamContentPackage.PackageManifest(m.schemaVersion(), m.packageId(), m.packageVersion(),
                hash, m.creator(), m.specificationBaselineId(), m.authoringStatus(), m.createdAt(), m.metadata()),
                p.sources(), p.licenses(), p.provenances(), p.catalogNodes(), p.specifications(), p.rubrics(), p.calibrations(),
                p.scoringSchemes(), p.form(), p.formComponents(), p.sections(), p.parts(), p.groups(), p.formGroups(), p.stimuli(),
                p.groupStimuli(), p.items(), p.answerSpecs(), p.assets(), p.stimulusAssets());
    }

    @Test
    @Order(1)
    @DisplayName("V71 kept the drift columns as they were (nullable) and created the validation table")
    void schemaTruth() {
        assertEquals("YES", jdbc.queryForObject("SELECT is_nullable FROM information_schema.columns "
                + "WHERE table_schema='exams' AND table_name='sections' AND column_name='is_runnable'", String.class));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables "
                + "WHERE table_schema='exams' AND table_name='form_content_validations'", Integer.class));
    }

    @Test
    @Order(2)
    @DisplayName("Imported IELTS Listening pilot: DB tree validates exactly like the package tree; result persisted once")
    void ieltsListeningDbEqualsPackage() throws Exception {
        ExamContentPackage p = pkg("IELTS/IELTS_SHARED_LISTENING_PILOT_001_V2.json");
        UUID formId = importer.importPackage(p, 1L).formId();
        Map<String, Object> qa = jdbc.queryForMap("SELECT findings::text AS f FROM exams.content_qa_runs WHERE form_id = ?", formId);
        assertTrue(String.valueOf(qa.get("f")).contains("structuralValidation"), "import records the structural validation");

        ExamFormValidationReport fromPackage = service.validatePackage(p);
        ExamFormValidationReport fromDb = service.evaluate(formId);
        assertEquals(fromPackage.status(), fromDb.status(), fromDb.blockingCodes().toString());
        assertEquals(fromPackage.blockingCodes(), fromDb.blockingCodes());
        assertEquals(fromPackage.practiceSkills(), fromDb.practiceSkills());
        assertTrue(fromDb.isPracticeRunnable(SkillType.LISTENING), fromDb.blockingCodes().toString());

        service.revalidate(formId, ExamContentValidationService.Trigger.ADMIN); // same fingerprint ⇒ no new row
        assertEquals(1, named.queryForObject("SELECT COUNT(*) FROM exams.form_content_validations WHERE form_id = :f",
                new MapSqlParameterSource("f", formId), Integer.class));
        assertEquals(1, service.history(formId, 10).size());
    }

    @Test
    @Order(3)
    @DisplayName("Media state change ⇒ new fingerprint ⇒ new (fail-closed) result; previous result kept (append-only)")
    void mediaChangeRevalidates() {
        UUID formId = named.queryForObject("SELECT id FROM exams.form_versions WHERE logical_key LIKE 'IELTS%LISTENING%' LIMIT 1",
                new MapSqlParameterSource(), UUID.class);
        ExamFormValidationReport before = service.revalidate(formId, ExamContentValidationService.Trigger.ADMIN);
        jdbc.update("""
                UPDATE exams.assets SET validation_state = 'PENDING' WHERE id IN (
                    SELECT sa.asset_id FROM exams.stimulus_assets sa
                    JOIN exams.group_stimuli gs ON gs.stimulus_id = sa.stimulus_id
                    JOIN exams.form_groups fg ON fg.group_id = gs.group_id
                    JOIN exams.parts p ON p.id = fg.part_id
                    JOIN exams.sections s ON s.id = p.section_id
                    WHERE s.form_id = ?)
                """, formId);
        ExamFormValidationReport after = service.revalidate(formId, ExamContentValidationService.Trigger.ADMIN);
        assertNotEquals(before.contentFingerprint(), after.contentFingerprint());
        assertTrue(after.blockingCodes().contains("REQUIRED_AUDIO_MISSING"), after.blockingCodes().toString());
        assertFalse(after.isPracticeRunnable(SkillType.LISTENING));
        assertEquals(2, named.queryForObject("SELECT COUNT(*) FROM exams.form_content_validations WHERE form_id = :f",
                new MapSqlParameterSource("f", formId), Integer.class));
    }

    @Test
    @Order(4)
    @DisplayName("Imported TOEIC L&R pilot (200 items): DB path = package path; listening without audio fails closed")
    void toeicPilotDbEqualsPackage() throws Exception {
        ExamContentPackage p = pkg("TOEIC/TOEIC_LR_PILOT_001_V2.json");
        UUID formId = importer.importPackage(p, 1L).formId();
        ExamFormValidationReport fromPackage = service.validatePackage(p);
        ExamFormValidationReport fromDb = service.evaluate(formId);
        assertEquals(fromPackage.blockingCodes(), fromDb.blockingCodes());
        assertEquals(fromPackage.status(), fromDb.status());
        assertTrue(fromDb.blockingCodes().contains("REQUIRED_AUDIO_MISSING"));
        assertFalse(fromDb.fullSimulationEligible());

        // Operator kill switch: is_runnable=false on Reading takes Reading away; NULL never grants anything.
        jdbc.update("UPDATE exams.sections SET is_runnable = FALSE WHERE form_id = ? AND skill = 'READING'", formId);
        ExamFormValidationReport off = service.revalidate(formId, ExamContentValidationService.Trigger.ADMIN);
        assertTrue(off.blockingCodes().contains("OPERATOR_SECTION_DISABLED"));
        assertFalse(off.isPracticeRunnable(SkillType.READING));
    }
    @Test @Order(5)
    void catalogBatchBenchmarkAndLiveRights() throws Exception {
        // Production-scale metadata: 137 IELTS and 106 TOEIC roots, sharing one pilot per family.
        // Shared pilots keep this bounded; they do not model the independent production corpus's byte volume.
        UUID child = named.queryForObject("SELECT id FROM exams.form_versions WHERE family='IELTS' LIMIT 1", new MapSqlParameterSource(), UUID.class);
        UUID toeicChild = named.queryForObject("SELECT id FROM exams.form_versions WHERE family='TOEIC' LIMIT 1", new MapSqlParameterSource(), UUID.class);
        java.util.ArrayList<UUID> ids = new java.util.ArrayList<>();
        for (int i = 0; i < 243; i++) {
            UUID component = i < 137 ? child : toeicChild;
            UUID id = UUID.randomUUID(); ids.add(id);
            jdbc.update("""
                INSERT INTO exams.form_versions (id,logical_key,version,title,family,variant,scope,specification_id,
                    scoring_scheme_id,lifecycle_state,provenance_id,author_id,primary_health_status,content_hash)
                SELECT ?,?,1,?,family,variant,scope,specification_id,scoring_scheme_id,'PILOT',provenance_id,author_id,primary_health_status,content_hash
                FROM exams.form_versions WHERE id=?
                """, id, "CATALOG_BENCH_" + i, "Benchmark " + i, component);
            jdbc.update("INSERT INTO exams.form_components(parent_form_id,child_form_id,role,ordinal) VALUES (?,?,'LISTENING',0)", id, component);
        }
        var counted = org.mockito.Mockito.spy(new NamedParameterJdbcTemplate(POOL));
        var loader = new ExamContentValidationRepository(counted, mapper);
        long begin = System.nanoTime();
        var batch = loader.loadTrees(ids);
        assertEquals(243, batch.size());
        long loadMs = (System.nanoTime() - begin) / 1_000_000;
        assertEquals(4, org.mockito.Mockito.mockingDetails(counted).getInvocations().stream()
                .filter(inv -> inv.getMethod().getName().equals("query")).count(), "four SELECTs independent of root count");
        for (UUID id : ids.subList(0, 3)) {
            var single = validationRepository.loadTree(id).orElseThrow();
            assertEquals(single.fingerprint(), batch.get(id).fingerprint(), "batch keeps component structure/order");
        }
        var treeSpy = org.mockito.Mockito.spy(loader);
        var summaries = new ExamContentValidationService(treeSpy, mapper,
                new TransactionTemplate(new DataSourceTransactionManager(POOL)), Clock.systemUTC());
        begin = System.nanoTime(); summaries.warm(ids);
        long coldMs = (System.nanoTime() - begin) / 1_000_000;
        org.mockito.Mockito.clearInvocations(treeSpy);
        begin = System.nanoTime(); summaries.warm(ids);
        long warmMs = (System.nanoTime() - begin) / 1_000_000;
        org.mockito.Mockito.verifyNoInteractions(treeSpy);
        assertTrue(summaries.cacheEntries() <= ExamContentValidationService.CACHE_MAX_ENTRIES);
        assertTrue(summaries.cacheBytes() <= ExamContentValidationService.CACHE_MAX_BYTES);
        var rightsRepository = new ExamContentRepository(counted, mapper);
        var before = rightsRepository.validFormRights(ids, java.time.Instant.now(), true);
        for (UUID id : ids.subList(0, 3)) assertEquals(rightsRepository.hasValidRightsForForm(id, java.time.Instant.now(), true), before.get(id));
        jdbc.update("UPDATE exams.licenses SET valid_until = now() - interval '1 second'");
        assertTrue(rightsRepository.validFormRights(ids, java.time.Instant.now(), true).values().stream().noneMatch(Boolean.TRUE::equals), "rights are live, outside the summary cache");
        summaries.invalidate(ids.getFirst());
        summaries.warm(ids);
        org.mockito.Mockito.verify(treeSpy).loadTrees(List.of(ids.getFirst()));
        org.mockito.Mockito.clearInvocations(treeSpy);
        try (var executor = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            summaries.invalidateAll();
            var futures = new java.util.ArrayList<java.util.concurrent.Future<?>>();
            for (int i=0;i<4;i++) futures.add(executor.submit(() -> summaries.warm(ids.subList(0, 32))));
            for (var future : futures) future.get();
        }
        org.mockito.Mockito.verify(treeSpy, org.mockito.Mockito.times(1)).loadTrees(ids.subList(0, 32));
        System.out.printf("CATALOG_BENCH forms=%d batchSelects=4 loadMs=%d coldMs=%d warmMs=%d summaryBytes=%d entries=%d%n",
                ids.size(), loadMs, coldMs, warmMs, summaries.cacheBytes(), summaries.cacheEntries());
    }

    @Test @Order(6)
    void compactCatalogSurvivesRestartExpiryAndDetectsInputChanges() throws Exception {
        var ids = jdbc.queryForList("SELECT id FROM exams.form_versions WHERE logical_key LIKE 'CATALOG_BENCH_%' ORDER BY id", UUID.class);
        var repositorySpy = org.mockito.Mockito.spy(validationRepository);
        var tx = new TransactionTemplate(new DataSourceTransactionManager(POOL));
        var first = new ExamContentValidationService(repositorySpy, mapper, tx, Clock.systemUTC());
        long start = System.nanoTime();
        var initial = first.catalogSummaries(ids);
        long cold = (System.nanoTime()-start)/1_000_000;
        assertEquals(ids.size(), initial.size());
        org.mockito.Mockito.clearInvocations(repositorySpy);
        var time = new java.util.concurrent.atomic.AtomicReference<>(java.time.Instant.now());
        Clock testClock = new Clock() {
            public java.time.ZoneId getZone() { return java.time.ZoneOffset.UTC; }
            public Clock withZone(java.time.ZoneId zone) { return this; }
            public java.time.Instant instant() { return time.get(); }
        };
        var restarted = new ExamContentValidationService(repositorySpy, mapper, tx, testClock);
        start = System.nanoTime();
        assertEquals(initial, restarted.catalogSummaries(ids));
        long restart = (System.nanoTime()-start)/1_000_000;
        org.mockito.Mockito.verify(repositorySpy, org.mockito.Mockito.never()).loadTrees(org.mockito.ArgumentMatchers.anyCollection());
        org.mockito.Mockito.verify(repositorySpy, org.mockito.Mockito.never()).insertValidations(org.mockito.ArgumentMatchers.anyList(), org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyMap());
        assertEquals(0, restarted.cacheEntries(), "restart reads only compact persisted summaries, no diagnostics/trees");
        assertTrue(restarted.catalogBytes() <= 2*1024*1024);
        assertTrue(restarted.catalogEntries() <= 512);
        String json = mapper.writeValueAsString(initial);
        for (String forbidden : List.of("acceptedAnswers", "prompt", "transcript", "diagnostics", "ownerUserId", "attemptId", "groupIds"))
            assertFalse(json.contains(forbidden));
        org.mockito.Mockito.clearInvocations(repositorySpy);
        time.updateAndGet(t -> t.plus(java.time.Duration.ofMinutes(6)));
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(8)) {
            var tasks = new java.util.ArrayList<java.util.concurrent.Future<?>>();
            for(int i=0;i<8;i++) tasks.add(executor.submit(() -> assertEquals(initial, restarted.catalogSummaries(ids))));
            for(var task:tasks) task.get();
        }
        org.mockito.Mockito.verify(repositorySpy, org.mockito.Mockito.times(1)).catalogInputs(ids);
        org.mockito.Mockito.verify(repositorySpy, org.mockito.Mockito.never()).loadTrees(org.mockito.ArgumentMatchers.anyCollection());
        org.mockito.Mockito.verify(repositorySpy, org.mockito.Mockito.never()).insertValidations(org.mockito.ArgumentMatchers.anyList(), org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyMap());
        // Every validation input change must alter the DB freshness key, even on a cached/persisted form.
        UUID id = ids.getFirst();
        String before = validationRepository.catalogInputs(List.of(id)).get(id).revision();
        jdbc.update("UPDATE exams.form_versions SET primary_health_status='DISABLED' WHERE id=?", id);
        restarted.invalidate(id);
        var denied = restarted.catalogSummaries(List.of(id)).get(id);
        assertNotEquals(before, denied.inputRevision());
        assertTrue(denied.practiceScopeCodes().isEmpty());
        assertFalse(denied.fullSimulationEligible());
        assertEquals(initial.size(), restarted.catalogEntries(), "replacement does not accumulate version keys");
        System.out.printf("COMPACT_CATALOG_BENCH forms=%d initialMs=%d restartAfterTtlMs=%d compactBytes=%d diagnosticBytes=%d%n",
                ids.size(), cold, restart, restarted.catalogBytes(), restarted.cacheBytes());
    }

    @Test @Order(7)
    void revisionCoversCanonicalBindingsKeysMediaAndOperatorFacts() {
        UUID root = jdbc.queryForObject("SELECT id FROM exams.form_versions WHERE logical_key='CATALOG_BENCH_1'", UUID.class);
        UUID child = jdbc.queryForObject("SELECT child_form_id FROM exams.form_components WHERE parent_form_id=?", UUID.class, root);
        var tx = new TransactionTemplate(new DataSourceTransactionManager(POOL));
        String original = validationRepository.catalogInputs(List.of(root)).get(root).revision();
        List<String> mutations = List.of(
            "UPDATE exams.form_versions SET version=version+1 WHERE id='"+root+"'",
            "UPDATE exams.form_components SET ordinal=ordinal+1 WHERE parent_form_id='"+root+"'",
            "UPDATE exams.form_versions SET primary_health_status='DISABLED' WHERE id='"+child+"'",
            "UPDATE exams.sections SET is_runnable=false WHERE form_id='"+child+"'",
            "UPDATE exams.sections SET duration_seconds=duration_seconds+1 WHERE form_id='"+child+"'",
            "UPDATE exams.parts SET ordinal=ordinal+100 WHERE section_id IN (SELECT id FROM exams.sections WHERE form_id='"+child+"')",
            "UPDATE exams.form_groups SET display_numbering='Changed printed label' WHERE part_id IN (SELECT p.id FROM exams.parts p JOIN exams.sections s ON s.id=p.section_id WHERE s.form_id='"+child+"')",
            "UPDATE exams.item_versions SET prompt=prompt || ' changed' WHERE group_id IN (SELECT fg.group_id FROM exams.form_groups fg JOIN exams.parts p ON p.id=fg.part_id JOIN exams.sections s ON s.id=p.section_id WHERE s.form_id='"+child+"')",
            "UPDATE exams.item_versions SET option_definitions='[]'::jsonb WHERE group_id IN (SELECT fg.group_id FROM exams.form_groups fg JOIN exams.parts p ON p.id=fg.part_id JOIN exams.sections s ON s.id=p.section_id WHERE s.form_id='"+child+"')",
            "UPDATE exams.answer_specs SET accepted_answers='[\"changed\"]'::jsonb WHERE item_id IN (SELECT iv.id FROM exams.item_versions iv JOIN exams.form_groups fg ON fg.group_id=iv.group_id JOIN exams.parts p ON p.id=fg.part_id JOIN exams.sections s ON s.id=p.section_id WHERE s.form_id='"+child+"')",
            "UPDATE exams.assets SET validation_state='INVALID' WHERE id IN (SELECT sa.asset_id FROM exams.stimulus_assets sa JOIN exams.group_stimuli gs ON gs.stimulus_id=sa.stimulus_id JOIN exams.form_groups fg ON fg.group_id=gs.group_id JOIN exams.parts p ON p.id=fg.part_id JOIN exams.sections s ON s.id=p.section_id WHERE s.form_id='"+child+"')"
        );
        for (String sql : mutations) tx.executeWithoutResult(status -> {
            assertTrue(jdbc.update(sql)>0, "fixture mutation must reach a canonical input");
            assertNotEquals(original, validationRepository.catalogInputs(List.of(root)).get(root).revision(), sql);
            status.setRollbackOnly();
        });
        assertEquals(original, validationRepository.catalogInputs(List.of(root)).get(root).revision());
        tx.executeWithoutResult(status -> {
            jdbc.update("UPDATE exams.form_versions SET title='Renamed catalog metadata' WHERE id=?", root);
            assertEquals(original, validationRepository.catalogInputs(List.of(root)).get(root).revision(), "live title does not change structural readiness");
            jdbc.update("UPDATE exams.licenses SET valid_until=now()-interval '1 day'");
            assertEquals(original, validationRepository.catalogInputs(List.of(root)).get(root).revision(), "rights are live and never structural cache truth");
            status.setRollbackOnly();
        });
    }
}
