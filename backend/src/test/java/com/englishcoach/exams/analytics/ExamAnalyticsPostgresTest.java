package com.englishcoach.exams.analytics;

import com.englishcoach.exams.analytics.ExamAnalyticsRecords.*;
import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageImporter.ImportRightsBasis;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamNotFoundException;
import com.englishcoach.exams.job.ExamJobWorker;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.practice.ExamPracticeRecords.*;
import com.englishcoach.exams.practice.ExamPracticeScope;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.repository.*;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamAttemptSnapshotContent;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamScoreAggregator;
import com.englishcoach.exams.service.*;
import com.englishcoach.exams.validation.ExamContentValidationRepository;
import com.englishcoach.exams.validation.ExamContentValidationService;
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

/**
 * Exams Phase 8 — learner analytics, mistakes and recommendations end to end on an isolated PostgreSQL 17 Testcontainer
 * (never the dev / production database): staged ETS 2026 T1 + Cambridge IELTS 17 T1 imported with the owner-authorized
 * LOCAL dry-run basis (same wiring as ExamPracticePostgresTest), real practice attempts of two learners through the
 * canonical services, one scored simulation, then the analytics service with the real availability index.
 * Proves: practice vs simulation separation, snapshot-safe counts (a later key edit changes nothing), mistakes /
 * improvement, recommendation = AVAILABLE scopes only + canonical Practice CTA, user isolation, read-only (no row written,
 * no evidence). Writes imports/exams/staging/reports/phase8_analytics_dry_run.json (counts / codes only).
 * Skips without Docker or without the staged packages. Needs -Dapi.version=1.44 on this machine.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamAnalyticsPostgresTest {

    private static final Path MIGRATIONS = Path.of("src/main/resources/db/migration/exams");
    private static final Path STAGING = Path.of("..", "imports", "exams", "staging");
    private static final Map<String, String> TARGETS = new LinkedHashMap<>();
    static {
        TARGETS.put("ETS26_T1", "extracted/toeic/ets/ets-2026/ets-2026__test-1.json");
        TARGETS.put("CAM17_T1", "extracted/ielts/cambridge/cambridge-ielts-17/cambridge-ielts-17__test-1.json");
    }
    static final long LEARNER = 101L, OTHER = 102L;
    static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();

    static PostgreSQLContainer<?> pg;
    static com.zaxxer.hikari.HikariDataSource POOL;
    static JdbcTemplate jdbc;
    static ExamContentRepository contentRepository;
    static ExamAttemptRepository attemptRepository;
    static ExamContentValidationService validation;
    static ExamPracticeService practice;
    static ExamAttemptService attempts;
    static ExamResponseService responses;
    static ExamManifestService manifests;
    static ExamJobWorker worker;
    static ExamLearnerAnalyticsService analytics;
    static final Map<String, UUID> FORMS = new LinkedHashMap<>();
    static final Map<String, UUID> ATTEMPTS = new LinkedHashMap<>();
    static final Map<String, Object> REPORT = new LinkedHashMap<>();

    @BeforeAll
    static void setUp() throws Exception {
        assumeTrue(Files.isDirectory(STAGING.resolve("extracted")), "staged packages not present (local data)");
        Map<String, ExamContentPackage> pkgs = new LinkedHashMap<>();
        for (Map.Entry<String, String> t : TARGETS.entrySet()) {
            assumeTrue(Files.isRegularFile(STAGING.resolve(t.getValue())), "missing " + t.getValue());
            pkgs.put(t.getKey(), MAPPER.readValue(STAGING.resolve(t.getValue()).toFile(), ExamContentPackage.class));
        }
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker not available — analytics dry run skipped");
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        // pooled (the existing ExamPhase5ImportPlanPostgresTest pattern): one TCP connection per statement exhausts
        // Windows ephemeral ports during the import + snapshot reads
        com.zaxxer.hikari.HikariConfig hc = new com.zaxxer.hikari.HikariConfig();
        hc.setJdbcUrl(pg.getJdbcUrl());
        hc.setUsername(pg.getUsername());
        hc.setPassword(pg.getPassword());
        hc.setMaximumPoolSize(4);
        POOL = new com.zaxxer.hikari.HikariDataSource(hc);
        javax.sql.DataSource ds = POOL;
        jdbc = new JdbcTemplate(ds);
        NamedParameterJdbcTemplate named = new NamedParameterJdbcTemplate(ds);
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
        ExamScoringRepository scoringRepository = new ExamScoringRepository(named, MAPPER);
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
        // runtime counterpart of the LOCAL dry-run import basis (trusted test wiring; never Spring / a request)
        ExamRightsService rights = ExamRightsService.ownerAuthorizedLocalRuntime(contentRepository, mediaRepository, props);
        ExamObjectiveScorer scorer = new ExamObjectiveScorer(new ExamAnswerNormalizer());
        practice = new ExamPracticeService(contentRepository, attemptRepository, validation, treeRepository, rights, manifests,
                scorer, MAPPER);
        ExamTimingService timing = new ExamTimingService(attemptRepository, contentRepository);
        attempts = new ExamAttemptService(attemptRepository, contentRepository, rights, timing, manifests);
        worker = new ExamJobWorker(scoringRepository, attemptRepository, contentRepository,
                new ExamProfileRepository(named, MAPPER), scorer, new ExamScoreAggregator(), null, null, props);
        responses = new ExamResponseService(attemptRepository, scoringRepository, contentRepository, worker);
        ExamContentService catalog = new ExamContentService(contentRepository, props, validation);
        analytics = new ExamLearnerAnalyticsService(new ExamLearnerAnalyticsRepository(named, MAPPER), scorer,
                new ExamPracticeAvailabilityIndex(catalog, practice));
    }

    @AfterAll
    static void tearDown() throws Exception {
        if (POOL != null) POOL.close();
        if (pg != null) {
            pg.stop();
            REPORT.put("generatedBy", "ExamAnalyticsPostgresTest (Exams Recovery Phase 8, isolated PostgreSQL 17)");
            MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT)
                    .writeValue(STAGING.resolve("reports").resolve("phase8_analytics_dry_run.json").toFile(), REPORT);
        }
    }

    // ─── helpers ───────────────────────────────────────────────────────────────────────────

    static AttemptRecord attempt(UUID id) {
        return attemptRepository.findAttemptById(id).orElseThrow();
    }

    static void start(UUID attemptId, long user) {
        attempts.markReady(user, attemptId);
        attempts.startAttempt(user, attemptId, "test-session");
    }

    static Map<UUID, String> placements(UUID attemptId, long user) {
        Map<UUID, String> out = new LinkedHashMap<>();
        PublicAttemptManifestDto m = attempts.getAttemptManifest(user, attemptId);
        for (PublicSectionDto s : m.sections()) for (PublicPartDto p : s.parts()) for (PublicGroupDto g : p.groups())
            for (PublicItemDto it : g.items()) out.put(it.id(), it.placementId());
        return out;
    }

    static List<ExamAttemptSnapshotContent.SnapshotItem> items(UUID attemptId) {
        List<ExamAttemptSnapshotContent.SnapshotItem> l = new ArrayList<>(
                ExamAttemptSnapshotContent.parse(attempt(attemptId).manifestSnapshot()).orElseThrow().allItems());
        l.sort(Comparator.comparing(ExamAttemptSnapshotContent.SnapshotItem::questionNumber));
        return l;
    }

    static String key(ExamAttemptSnapshotContent.SnapshotItem it) {
        return ExamObjectiveScorer.nonBlankAccepted(it.answerSpec().acceptedAnswers()).get(0);
    }

    static String wrong(String key) {
        for (String l : List.of("A", "B", "C", "D")) if (!l.equalsIgnoreCase(key)) return l;
        return "Z";
    }

    /** pattern per item in printed order: C correct, I incorrect, U blank. */
    static void answer(UUID attemptId, long user, String pattern) {
        Map<UUID, String> pl = placements(attemptId, user);
        List<ExamAttemptSnapshotContent.SnapshotItem> its = items(attemptId);
        List<ResponseItemCommand> cmds = new ArrayList<>();
        for (int i = 0; i < its.size() && i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            if (c == 'U') continue;
            String v = c == 'C' ? key(its.get(i)) : wrong(key(its.get(i)));
            cmds.add(new ResponseItemCommand(pl.get(its.get(i).itemId()), null, Map.of("value", v), v, null, false, null));
        }
        for (int i = 0; i < cmds.size(); i += 40) {
            responses.saveResponseBatch(user, attemptId, new SaveResponseBatchRequest(null, attempt(attemptId).revision(),
                    cmds.subList(i, Math.min(cmds.size(), i + 40))));
        }
    }

    static void submit(UUID attemptId, long user) {
        responses.submitAttempt(user, attemptId,
                new SubmitAttemptRequest("submit-" + attemptId, attempt(attemptId).revision(), SubmissionReason.MANUAL, List.of()));
    }

    static UUID practise(String form, String scope, long user, String pattern) {
        UUID id = practice.createPracticeAttempt(user, new CreatePracticeAttemptRequest(FORMS.get(form), scope, null)).attemptId();
        start(id, user);
        answer(id, user, pattern);
        submit(id, user);
        return id;
    }

    static FamilyAnalyticsDto family(long user, ExamFamily f) {
        return analytics.getAnalytics(user, f).families().get(0);
    }

    static ScopeStatsDto scope(FamilyAnalyticsDto f, String code) {
        return f.scopes().stream().filter(s -> s.scopeCode().equals(code)).findFirst().orElseThrow();
    }

    static int count(String sql) {
        return jdbc.queryForObject(sql, Integer.class);
    }

    static Map<String, Integer> tableCounts() {
        Map<String, Integer> m = new LinkedHashMap<>();
        for (String t : List.of("attempts", "responses", "submissions", "score_artifacts", "score_components", "profile_evidence",
                "evidence_events", "recommendations", "audit_events", "answer_specs", "item_versions")) {
            m.put(t, count("SELECT COUNT(*) FROM exams." + t));
        }
        return m;
    }

    // ─── tests ─────────────────────────────────────────────────────────────────────────────

    @Test
    @Order(1)
    @DisplayName("01/13/14/15/17/18/19/20: practice attempts of two learners; analytics = the Phase 6 result counts, mistakes from history")
    void practiceAnalytics() {
        // Part 5 (30 items): 10 wrong, 10 right, 10 blank — then Practice Again: 5 still wrong, everything else right
        UUID a1 = practise("ETS26_T1", "TOEIC_PART_5", LEARNER, "I".repeat(10) + "C".repeat(10) + "U".repeat(10));
        UUID a2 = practice.practiceAgain(LEARNER, a1, null).attemptId();
        start(a2, LEARNER);
        answer(a2, LEARNER, "I".repeat(5) + "C".repeat(25));
        submit(a2, LEARNER);
        UUID p2 = practise("ETS26_T1", "TOEIC_PART_2", LEARNER, "C".repeat(25));
        UUID other = practise("ETS26_T1", "TOEIC_PART_6", OTHER, "I".repeat(16));
        ATTEMPTS.putAll(Map.of("A1", a1, "A2", a2, "P2", p2, "OTHER_P6", other));

        FamilyAnalyticsDto f = family(LEARNER, ExamFamily.TOEIC);
        assertEquals(List.of("TOEIC_PART_2", "TOEIC_PART_5"), f.scopes().stream().map(ScopeStatsDto::scopeCode).toList(),
                "only the learner's own practised scopes");
        ScopeStatsDto s5 = scope(f, "TOEIC_PART_5");
        PracticeResultDto r1 = practice.getResult(LEARNER, a1), r2 = practice.getResult(LEARNER, a2);
        assertEquals(2, s5.attempts());
        assertEquals(r1.correct() + r2.correct(), s5.correct(), "same scorer as the practice result");
        assertEquals(r1.incorrect() + r2.incorrect(), s5.incorrect());
        assertEquals(r1.unanswered() + r2.unanswered(), s5.unanswered());
        assertEquals(r1.total() + r2.total(), s5.questions());
        assertEquals(35, s5.correct());
        assertEquals(15, s5.incorrect());
        assertEquals(10, s5.unanswered());
        assertEquals("ESTABLISHED_SIGNAL", s5.signal());
        assertEquals(100.0, scope(f, "TOEIC_PART_2").rawAccuracyPercent());

        MistakeSummaryDto m = f.mistakes();
        assertEquals(5, m.repeated(), "wrong in both attempts");
        assertEquals(15, m.improved(), "5 wrong + 10 blank, then correct");
        assertEquals(0, m.single());
        MistakeItemDto rep = m.items().get(0);
        assertEquals("REPEATED", rep.state());
        assertEquals(a2, rep.reviewAttemptId(), "review link = the latest attempt where it was missed");
        Set<String> snapshotKeys = new HashSet<>();
        for (ExamAttemptSnapshotContent.SnapshotItem it : items(a1)) snapshotKeys.add(it.logicalItemKey() + "#" + it.version());
        assertTrue(snapshotKeys.contains(rep.logicalItemKey() + "#" + rep.itemVersion()), "identity = snapshot logical key + version");
        assertNotNull(practice.getReview(LEARNER, rep.reviewAttemptId()), "21: the linked attempt-scoped review is reachable");
        assertThrows(ExamNotFoundException.class, () -> practice.getReview(OTHER, rep.reviewAttemptId()));
        REPORT.put("toeicPart5", Map.of("attempts", s5.attempts(), "questions", s5.questions(), "correct", s5.correct(),
                "incorrect", s5.incorrect(), "unanswered", s5.unanswered(), "signal", s5.signal()));
        REPORT.put("mistakes", Map.of("repeated", m.repeated(), "improved", m.improved(), "single", m.single()));
    }

    @Test
    @Order(2)
    @DisplayName("16/47: user A analytics never contain user B data (and vice versa)")
    void isolation() throws Exception {
        FamilyAnalyticsDto mine = family(LEARNER, ExamFamily.TOEIC);
        FamilyAnalyticsDto theirs = family(OTHER, ExamFamily.TOEIC);
        assertEquals(List.of("TOEIC_PART_6"), theirs.scopes().stream().map(ScopeStatsDto::scopeCode).toList());
        assertEquals(1, theirs.practice().attempts());
        String mineJson = MAPPER.writeValueAsString(mine), theirsJson = MAPPER.writeValueAsString(theirs);
        assertFalse(mineJson.contains(ATTEMPTS.get("OTHER_P6").toString()));
        for (String k : List.of("A1", "A2", "P2")) assertFalse(theirsJson.contains(ATTEMPTS.get(k).toString()));
        assertFalse(mineJson.contains("\"userId\"") || mineJson.contains("learner@example.test"), "no user identifiers");
        assertTrue(mine.scopes().stream().noneMatch(s -> s.scopeCode().equals("TOEIC_PART_6")),
                "another learner's Part 6 never counts as 'practised' for this learner");
    }

    @Test
    @Order(3)
    @DisplayName("24-36: recommendations = AVAILABLE scopes only, weak scope first, reasons from data, CTA starts canonical Practice")
    void recommendations() throws Exception {
        FamilyAnalyticsDto f = family(LEARNER, ExamFamily.TOEIC);
        RecommendationBlockDto r = f.recommendations();
        assertEquals("PERSONALIZED", r.status());
        List<String> codes = r.items().stream().map(RecommendationDto::scopeCode).toList();
        assertEquals("TOEIC_PART_5", codes.get(0));
        assertEquals("FOCUS", r.items().get(0).kind());
        assertEquals("REPEATED_MISTAKES", r.items().get(0).reasons().get(0).code());
        assertEquals(5, r.items().get(0).reasons().get(0).facts().get("count"));
        for (String blocked : List.of("TOEIC_PART_1", "TOEIC_PART_3", "TOEIC_PART_4")) {
            assertFalse(codes.contains(blocked), blocked + " is CONTENT_IN_PROGRESS on the real corpus (crops pending)");
        }
        assertFalse(codes.contains("TOEIC_PART_2"), "a 100 % scope is not a focus");
        assertTrue(r.items().stream().skip(1).allMatch(i -> "COVERAGE".equals(i.kind())));
        Set<String> availableNow = new HashSet<>();
        for (PracticeScopeDto s : practice.getCatalog(FORMS.get("ETS26_T1")).scopes()) {
            if ("AVAILABLE".equals(s.availability())) availableNow.add(s.scopeCode());
        }
        assertTrue(availableNow.containsAll(codes), "every recommendation is AVAILABLE by server readiness: " + codes);

        // deterministic (same data ⇒ same ranking)
        String once = MAPPER.writeValueAsString(f.recommendations());
        assertEquals(once, MAPPER.writeValueAsString(family(LEARNER, ExamFamily.TOEIC).recommendations()));

        // CTA = the canonical Practice creation for (form, scope); the learner may equally start any other AVAILABLE scope
        int before = count("SELECT COUNT(*) FROM exams.attempts");
        RecommendationDto top = r.items().get(0);
        PracticeAttemptDto created = practice.createPracticeAttempt(LEARNER, new CreatePracticeAttemptRequest(top.formId(), top.scopeCode(), null));
        assertEquals(top.scopeCode(), ExamPracticeScope.pinned(attempt(created.attemptId()).manifestSnapshot()).orElseThrow().get("scopeCode"));
        PracticeAttemptDto chosen = practice.createPracticeAttempt(LEARNER, new CreatePracticeAttemptRequest(FORMS.get("ETS26_T1"), "TOEIC_PART_6", null));
        assertNotNull(chosen.attemptId(), "35: a non-recommended AVAILABLE scope is still startable");
        assertEquals(before + 2, count("SELECT COUNT(*) FROM exams.attempts"), "only explicit CTA calls create attempts");
        REPORT.put("recommendations", r.items().stream().map(i -> Map.of("rank", i.rank(), "kind", i.kind(), "scope", i.scopeCode(),
                "reasons", i.reasons().stream().map(ReasonDto::code).toList())).toList());
    }

    @Test
    @Order(4)
    @DisplayName("10/24: IELTS writing practice counted but never scored; no objective data ⇒ no weakness claimed, neutral starters")
    void ieltsWriting() {
        UUID w = practice.createPracticeAttempt(LEARNER, new CreatePracticeAttemptRequest(FORMS.get("CAM17_T1"), "IELTS_WRITING_TASK_2", null)).attemptId();
        start(w, LEARNER);
        String essay = String.join(" ", Collections.nCopies(120, "word"));
        String pid = placements(w, LEARNER).values().iterator().next();
        responses.saveResponseBatch(LEARNER, w, new SaveResponseBatchRequest(null, attempt(w).revision(),
                List.of(new ResponseItemCommand(pid, null, Map.of("value", essay), essay, null, false, null))));
        submit(w, LEARNER);
        ATTEMPTS.put("W2", w);

        FamilyAnalyticsDto f = family(LEARNER, ExamFamily.IELTS);
        assertFalse(f.scopes().isEmpty(), () -> "IELTS analytics: " + f + " / row: " + jdbc.queryForList(
                "SELECT status, family, attempt_mode, snapshot_state, submitted_at, jsonb_typeof(manifest_snapshot->'practiceScope') t "
                        + "FROM exams.attempts WHERE id = ?", w));
        ScopeStatsDto ws = scope(f, "IELTS_WRITING_TASK_2");
        assertFalse(ws.objective());
        assertEquals("NOT_APPLICABLE", ws.signal());
        assertNull(ws.rawAccuracyPercent());
        assertEquals(120, ws.writing().lastWordCount());
        assertEquals("NOT_SCORED", ws.writing().assessment());
        assertEquals(List.of("IELTS_WRITING_TASK_2"), f.scopes().stream().map(ScopeStatsDto::scopeCode).toList());
        assertEquals("INSUFFICIENT_DATA", f.recommendations().status());
        assertTrue(f.recommendations().items().stream().allMatch(i -> "START".equals(i.kind())));
        assertTrue(f.recommendations().items().stream().noneMatch(i -> i.scopeCode().equals("IELTS_WRITING_TASK_1")),
                "Task 1 visual awaits crop approval ⇒ never suggested");
        REPORT.put("ieltsWriting", Map.of("wordCount", ws.writing().lastWordCount(), "assessment", ws.writing().assessment()));
    }

    @Test
    @Order(5)
    @DisplayName("02/06/07: a scored simulation is reported separately with the scorer's own component; practice totals unchanged")
    void simulationSeparate() {
        int practiceBefore = family(LEARNER, ExamFamily.TOEIC).practice().attempts();
        FormVersionRecord form = contentRepository.findFormById(FORMS.get("ETS26_T1")).orElseThrow();
        ExamManifestService.FormSnapshotResult snap = manifests.serializeFormSnapshot(form);
        Map<String, Object> pinned = ExamAttemptService.pinEvidenceBasis(snap, validation.evaluate(form.id()), form,
                ExamAttemptMode.EXAM_SIMULATION, EnumSet.of(SkillType.LISTENING, SkillType.READING));
        UUID id = UUID.randomUUID();
        Instant end = Instant.now();
        attemptRepository.insertAttempt(new AttemptRecord(id, LEARNER, form.id(), form.family(), form.variant(), form.scope(),
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.SUBMITTED, 1, 1, null, null, snap.hash(),
                Map.of("selectedSkills", List.of("LISTENING", "READING")), end.minusSeconds(7200), end.minusSeconds(7200), null,
                end, null, List.of(), end, end, pinned, snap.version(), ExamSnapshotState.SNAPSHOTTED));
        for (SectionRecord s : contentRepository.findSectionsByFormId(form.id())) {
            if (s.skill() == SkillType.LISTENING || s.skill() == SkillType.READING) {
                attemptRepository.insertAttemptSection(new AttemptSectionRecord(null, id, s.id(), ExamSectionState.COMPLETED,
                        "MAIN", end, null, end, Map.of(), end));
            }
        }
        SubmissionRecord sub = new SubmissionRecord(UUID.randomUUID(), id, SubmissionReason.MANUAL, end, Map.of(),
                snap.hash(), Map.of(), "phase8-sim-" + id, end);
        attemptRepository.insertSubmission(sub);
        worker.scoreObjectiveSubmissionDirectly(sub, attempt(id));

        FamilyAnalyticsDto f = family(LEARNER, ExamFamily.TOEIC);
        assertEquals(practiceBefore, f.practice().attempts(), "a simulation is never a practice attempt");
        assertEquals(1, f.simulation().submitted());
        SimulationAttemptDto s = f.simulation().attempts().get(0);
        List<String> metrics = s.components().stream().map(ComponentDto::metric).toList();
        assertTrue(metrics.isEmpty(), "this staged edition has no form-specific scaled conversion");
        assertEquals(0, f.simulation().withStandardizedScore());
        assertEquals(2, s.rawSections().size());
        int actualItems = contentRepository.findItemsByFormId(form.id()).size();
        assertEquals(actualItems, s.rawSections().stream().mapToInt(RawSectionDto::maxRaw).sum());
        assertTrue(s.rawSections().stream().allMatch(section -> section.correct() == 0));
        REPORT.put("simulation", Map.of("submitted", 1, "components", metrics));
    }

    @Test
    @Order(6)
    @DisplayName("11/12: a later answer-key edit of the live form does not rewrite historical analytics (snapshot truth)")
    void snapshotSafe() {
        ScopeStatsDto before = scope(family(LEARNER, ExamFamily.TOEIC), "TOEIC_PART_5");
        // TEST-ONLY mutation inside the disposable container: flip every Part 5 key of the live form
        UUID item = items(ATTEMPTS.get("A1")).get(0).itemId();
        int changed = jdbc.update("UPDATE exams.answer_specs SET accepted_answers = '{\"values\":[\"Z\"]}'::jsonb WHERE item_id = ?", item);
        assertEquals(1, changed);
        validation.invalidate(FORMS.get("ETS26_T1"));
        ScopeStatsDto after = scope(family(LEARNER, ExamFamily.TOEIC), "TOEIC_PART_5");
        assertEquals(before.correct(), after.correct());
        assertEquals(before.incorrect(), after.incorrect());
        assertEquals(before.unanswered(), after.unanswered());
        assertEquals(before.rawAccuracyPercent(), after.rawAccuracyPercent());
    }

    @Test
    @Order(7)
    @DisplayName("28/36/58: analytics are read-only — no row written anywhere; practice evidence stays 0")
    void readOnlyNoEvidence() {
        Map<String, Integer> before = tableCounts();
        for (int i = 0; i < 3; i++) {
            analytics.getAnalytics(LEARNER, null);
            analytics.getAnalytics(OTHER, ExamFamily.TOEIC);
        }
        assertEquals(before, tableCounts(), "analytics wrote nothing");
        assertEquals(0, count("SELECT COUNT(*) FROM exams.profile_evidence pe JOIN exams.attempts a ON a.id = pe.attempt_id "
                + "WHERE a.attempt_mode = 'PRACTICE'"), "practice never becomes official evidence");
        REPORT.put("tableCountsUnchanged", before);
    }
}
