package com.englishcoach.exams.hardening;

import com.englishcoach.exams.analytics.*;
import com.englishcoach.exams.analytics.ExamAnalyticsRecords.*;
import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageImporter.ImportRightsBasis;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.exception.ExamConcurrencyException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamNotFoundException;
import com.englishcoach.exams.exception.ExamWriteClosedException;
import com.englishcoach.exams.job.ExamJobWorker;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.media.LocalExamObjectStorage;
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
import com.fasterxml.jackson.databind.JsonNode;
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

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Exams Phase 9 — security + reliability matrix against an isolated PostgreSQL 17 Testcontainer (never the dev / production
 * database), real imported content (ETS 2026 T1 + Cambridge IELTS 17 T1, owner-authorized LOCAL dry-run basis — the same
 * wiring as ExamPracticePostgresTest / ExamAnalyticsPostgresTest) and the canonical services:
 * live Practice + Simulation manifests / reviews / analytics / history scanned for leaks; cross-user GET + mutation;
 * server deadline (late autosave / late submit / reconnect); duplicate submit (no second submission / scoring / evidence);
 * two-tab ordering; Practice Again rapid duplicates; media grant ownership + scope; analytics performance (attempt counts,
 * query counts, timings). Writes imports/exams/staging/reports/phase9_security_reliability.json (counts / codes / timings
 * only). Skips without Docker or without the staged packages. Needs -Dapi.version=1.44 on this machine.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
@org.junit.jupiter.api.extension.ExtendWith(com.englishcoach.exams.CorpusFixturesUnchangedExtension.class)
class ExamPhase9SecurityReliabilityPostgresTest {

    private static final Path MIGRATIONS = Path.of("src/main/resources/db/migration/exams");
    private static final Path STAGING = Path.of("..", "imports", "exams", "staging");
    private static final Map<String, String> TARGETS = new LinkedHashMap<>();
    static {
        TARGETS.put("ETS26_T1", "extracted/toeic/ets/ets-2026/ets-2026__test-1.json");
        TARGETS.put("CAM17_T1", "extracted/ielts/cambridge/cambridge-ielts-17/cambridge-ielts-17__test-1.json");
    }
    static final long A = 101L, B = 102L, PERF = 201L;
    static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();

    static PostgreSQLContainer<?> pg;
    static com.zaxxer.hikari.HikariDataSource POOL;
    static JdbcTemplate jdbc;
    static NamedParameterJdbcTemplate named;
    static ExamAttemptRepository attemptRepository;
    static ExamContentRepository contentRepository;
    static ExamMediaRepository mediaRepository;
    static ExamPracticeService practice;
    static ExamAttemptService attempts;
    static ExamResponseService responses;
    static ExamResultService results;
    static ExamMediaService media;
    static ExamLearnerAnalyticsService analytics;
    static ExamPracticeAvailabilityIndex availability;
    static ExamObjectiveScorer scorer;
    static final AtomicInteger STATEMENTS = new AtomicInteger();
    static final Map<String, UUID> FORMS = new LinkedHashMap<>();
    static final Map<String, UUID> ATT = new LinkedHashMap<>();
    static final Map<String, Object> REPORT = new LinkedHashMap<>();

    /** Key names that must never appear in a learner payload before submission (any depth). */
    static final Set<String> LIVE_FORBIDDEN = Set.of("acceptedAnswers", "answerSpec", "correctAnswers", "correctAnswer", "keySource",
            "rejectedAnswers", "distractorLogic", "evidence", "policy", "transcript", "transcriptAvailable", "transcriptEmbedded",
            "segments", "scriptSegments", "spokenResponses", "mappingConfidence", "rendering", "sourcePage", "sourcePages",
            "sourceRole", "sourceProvenance", "provenance", "provenanceId", "runtimeUse", "questionRange", "playback", "fingerprint",
            "reasonCodes", "readinessVersion", "evidenceBasis", "objectKey", "storageKey", "sha256Hash");
    /** After submission the review may show the canonical answer (correctAnswers / values) — never the scoring internals. */
    static final Set<String> REVIEW_FORBIDDEN = Set.of("keySource", "rejectedAnswers", "distractorLogic", "evidence", "policy",
            "transcriptAvailable", "transcriptEmbedded", "segments", "mappingConfidence", "rendering", "sourcePage", "sourcePages",
            "sourceRole", "sourceProvenance", "provenance", "runtimeUse", "questionRange", "fingerprint", "objectKey");

    @BeforeAll
    static void setUp() throws Exception {
        assumeTrue(Files.isDirectory(STAGING.resolve("extracted")), "staged packages not present (local data)");
        Map<String, ExamContentPackage> pkgs = new LinkedHashMap<>();
        for (Map.Entry<String, String> t : TARGETS.entrySet()) {
            assumeTrue(Files.isRegularFile(STAGING.resolve(t.getValue())), "missing " + t.getValue());
            pkgs.put(t.getKey(), MAPPER.readValue(STAGING.resolve(t.getValue()).toFile(), ExamContentPackage.class));
        }
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker not available — Phase 9 matrix skipped");
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
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
                + "INSERT INTO public.users VALUES (1, 'operator@example.test'), (101, 'a@example.test'), (102, 'b@example.test'), "
                + "(201, 'perf@example.test');");
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
        mediaRepository = new ExamMediaRepository(named, MAPPER);
        StaticListableBeanFactory beans = new StaticListableBeanFactory(Map.of("tm", new DataSourceTransactionManager(ds)));
        ExamContentValidationRepository treeRepository = new ExamContentValidationRepository(named, MAPPER);
        ExamContentValidationService validation = new ExamContentValidationService(treeRepository, MAPPER,
                beans.getBeanProvider(PlatformTransactionManager.class));
        ExamContentPackageImporter importer = new ExamContentPackageImporter(contentRepository, new ExamContentPackageValidator(MAPPER));
        importer.setValidationService(validation);
        importer.setOwnerAuthorizedDryRunEnabled(true);
        for (Map.Entry<String, ExamContentPackage> e : pkgs.entrySet()) {
            ExamContentPackage.ImportResult r = importer.importPackage(e.getValue(), 1L, ImportRightsBasis.OWNER_PROJECT_AUTHORIZATION_LOCAL_DRY_RUN);
            FORMS.put(e.getKey(), r.formId());
            jdbc.update("UPDATE exams.form_versions SET lifecycle_state = 'PILOT' WHERE id = ?", r.formId());
            validation.invalidate(r.formId());
        }
        ExamManifestService manifests = new ExamManifestService(contentRepository, attemptRepository);
        ExamsProperties props = new ExamsProperties();
        props.getStorage().getLocal().setBaseDir(Files.createTempDirectory("p9-media").toString());
        ExamRightsService rights = ExamRightsService.ownerAuthorizedLocalRuntime(contentRepository, mediaRepository, props);
        scorer = new ExamObjectiveScorer(new ExamAnswerNormalizer());
        practice = new ExamPracticeService(contentRepository, attemptRepository, validation, treeRepository, rights, manifests,
                scorer, MAPPER);
        ExamTimingService timing = new ExamTimingService(attemptRepository, contentRepository);
        attempts = new ExamAttemptService(attemptRepository, contentRepository, rights, timing, manifests, null, null, validation);
        ExamJobWorker worker = new ExamJobWorker(scoringRepository, attemptRepository, contentRepository,
                new ExamProfileRepository(named, MAPPER), scorer, new ExamScoreAggregator(), null, null, props);
        responses = new ExamResponseService(attemptRepository, scoringRepository, contentRepository, worker);
        results = new ExamResultService(attemptRepository, scoringRepository, contentRepository, mediaRepository, scorer);
        media = new ExamMediaService(mediaRepository, attemptRepository, rights, new LocalExamObjectStorage(props));
        availability = new ExamPracticeAvailabilityIndex(new ExamContentService(contentRepository, props, validation), practice);
        // analytics reads through a statement-counting data source (query-count measurement, no N+1)
        analytics = new ExamLearnerAnalyticsService(new ExamLearnerAnalyticsRepository(new NamedParameterJdbcTemplate(counting(ds)), MAPPER),
                scorer, availability);
    }

    @AfterAll
    static void tearDown() throws Exception {
        if (POOL != null) POOL.close();
        if (pg != null) {
            pg.stop();
            REPORT.put("generatedBy", "ExamPhase9SecurityReliabilityPostgresTest (Exams Recovery Phase 9, isolated PostgreSQL 17)");
            MAPPER.copy().enable(SerializationFeature.INDENT_OUTPUT)
                    .writeValue(STAGING.resolve("reports").resolve("phase9_security_reliability.json").toFile(), REPORT);
        }
    }

    // ─── helpers ───────────────────────────────────────────────────────────────────────────

    static javax.sql.DataSource counting(javax.sql.DataSource target) {
        return (javax.sql.DataSource) Proxy.newProxyInstance(ExamPhase9SecurityReliabilityPostgresTest.class.getClassLoader(),
                new Class<?>[]{javax.sql.DataSource.class}, (p, m, args) -> {
                    Object r = m.invoke(target, args);
                    if (r instanceof Connection c) {
                        return Proxy.newProxyInstance(ExamPhase9SecurityReliabilityPostgresTest.class.getClassLoader(),
                                new Class<?>[]{Connection.class}, (p2, m2, a2) -> {
                                    if (m2.getName().startsWith("prepare") || m2.getName().equals("createStatement")) STATEMENTS.incrementAndGet();
                                    return m2.invoke(c, a2);
                                });
                    }
                    return r;
                });
    }

    static AttemptRecord attempt(UUID id) {
        return attemptRepository.findAttemptById(id).orElseThrow();
    }

    static void start(UUID id, long user) {
        attempts.markReady(user, id);
        attempts.startAttempt(user, id, "s");
    }

    static List<ExamAttemptSnapshotContent.SnapshotItem> items(UUID id) {
        List<ExamAttemptSnapshotContent.SnapshotItem> l = new ArrayList<>(
                ExamAttemptSnapshotContent.parse(attempt(id).manifestSnapshot()).orElseThrow().allItems());
        l.sort(Comparator.comparing(ExamAttemptSnapshotContent.SnapshotItem::questionNumber));
        return l;
    }

    static Map<UUID, String> placements(UUID id, long user) {
        Map<UUID, String> out = new LinkedHashMap<>();
        PublicAttemptManifestDto m = attempts.getAttemptManifest(user, id);
        for (PublicSectionDto s : m.sections()) for (PublicPartDto p : s.parts()) for (PublicGroupDto g : p.groups())
            for (PublicItemDto it : g.items()) out.put(it.id(), it.placementId());
        return out;
    }

    static String key(ExamAttemptSnapshotContent.SnapshotItem it) {
        List<String> k = ExamObjectiveScorer.nonBlankAccepted(it.answerSpec().acceptedAnswers());
        return k.isEmpty() ? "A" : k.get(0);
    }

    static ResponseItemCommand cmd(String placement, String v) {
        return new ResponseItemCommand(placement, null, Map.of("value", v), v, null, false, null);
    }

    static void answerAll(UUID id, long user, boolean correct) {
        Map<UUID, String> pl = placements(id, user);
        List<ResponseItemCommand> cmds = new ArrayList<>();
        for (ExamAttemptSnapshotContent.SnapshotItem it : items(id)) {
            String placement = pl.get(it.itemId());
            if (placement == null) continue;
            cmds.add(cmd(placement, correct ? key(it) : "Z"));
        }
        for (int i = 0; i < cmds.size(); i += 40) {
            responses.saveResponseBatch(user, id, new SaveResponseBatchRequest(null, attempt(id).revision(),
                    cmds.subList(i, Math.min(cmds.size(), i + 40))));
        }
    }

    static UUID submit(UUID id, long user) {
        return responses.submitAttempt(user, id, new SubmitAttemptRequest("submit-" + id, attempt(id).revision(), SubmissionReason.MANUAL, List.of()));
    }

    static UUID practise(String form, String scope, long user, boolean correct) {
        UUID id = practice.createPracticeAttempt(user, new CreatePracticeAttemptRequest(FORMS.get(form), scope, null)).attemptId();
        start(id, user);
        answerAll(id, user, correct);
        submit(id, user);
        return id;
    }

    static int count(String sql, Object... args) {
        return jdbc.queryForObject(sql, Integer.class, args);
    }

    static Set<String> keysOf(Object payload) {
        Set<String> keys = new HashSet<>();
        collect(MAPPER.valueToTree(payload), keys);
        return keys;
    }

    static void collect(JsonNode n, Set<String> keys) {
        if (n.isObject()) n.fields().forEachRemaining(e -> {
            keys.add(e.getKey());
            collect(e.getValue(), keys);
        });
        else if (n.isArray()) n.forEach(c -> collect(c, keys));
    }

    static void assertNoKeys(Object payload, Set<String> forbidden, String where) {
        Set<String> found = new TreeSet<>(keysOf(payload));
        found.retainAll(forbidden);
        assertTrue(found.isEmpty(), where + " leaks " + found);
        String json;
        try {
            json = MAPPER.writeValueAsString(payload);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
        for (String path : List.of("C:\\\\", "/home/", "/mnt/", "file:", "imports/source-files", "localhost")) {
            assertFalse(json.contains(path), where + " contains machine path " + path);
        }
    }

    static void expectDenied(Runnable call, String what) {
        RuntimeException e = assertThrows(RuntimeException.class, call::run, what);
        assertTrue(e instanceof ExamNotFoundException || e instanceof ExamForbiddenException || e instanceof IllegalArgumentException
                || e instanceof SecurityException, what + " → " + e);
    }

    // ─── tests ─────────────────────────────────────────────────────────────────────────────

    @Test
    @Order(1)
    @DisplayName("11/13/18/20: live PRACTICE manifest (TOEIC Part 5 + IELTS Listening 1) — no key / QA / transcript / path; "
            + "review before submission refused")
    void practiceLivePayload() {
        UUID p5 = practice.createPracticeAttempt(A, new CreatePracticeAttemptRequest(FORMS.get("ETS26_T1"), "TOEIC_PART_5", null)).attemptId();
        start(p5, A);
        UUID l1 = practice.createPracticeAttempt(A, new CreatePracticeAttemptRequest(FORMS.get("CAM17_T1"), "IELTS_LISTENING_SECTION_1", null)).attemptId();
        start(l1, A);
        ATT.put("P5", p5);
        ATT.put("L1", l1);
        for (UUID id : List.of(p5, l1)) {
            PublicAttemptManifestDto m = attempts.getAttemptManifest(A, id);
            assertEquals("PRACTICE_SCOPE", m.manifestScope());
            assertNoKeys(m, LIVE_FORBIDDEN, "practice manifest " + id);
            assertNoKeys(attempts.getAttemptState(A, id), LIVE_FORBIDDEN, "attempt state " + id);
        }
        // listening audio stimuli carry no body at all (no hidden transcript)
        for (PublicSectionDto s : attempts.getAttemptManifest(A, l1).sections()) for (PublicPartDto p : s.parts())
            for (PublicGroupDto g : p.groups()) for (PublicStimulusDto st : g.stimuli())
                if ("AUDIO".equalsIgnoreCase(st.kind())) assertTrue(st.bodyPayload() == null || st.bodyPayload().isEmpty());
        IllegalStateException early = assertThrows(IllegalStateException.class, () -> practice.getReview(A, p5));
        assertTrue(early.getMessage().startsWith("REVIEW_NOT_AVAILABLE"));
        REPORT.put("practiceLiveManifestLeaks", 0);
    }

    @Test
    @Order(2)
    @DisplayName("12/14: live SIMULATION manifest (IELTS Reading, full-simulation-valid form) — extractor / OCR / key metadata stripped")
    void simulationLivePayload() {
        AttemptStateDto sim = attempts.createAttempt(A, new CreateAttemptRequest(FORMS.get("CAM17_T1"), ExamAttemptMode.EXAM_SIMULATION,
                null, null, "p9-sim-a", List.of("READING")));
        ATT.put("SIM", sim.attemptId());
        start(sim.attemptId(), A);
        PublicAttemptManifestDto m = attempts.getAttemptManifest(A, sim.attemptId());
        assertNoKeys(m, LIVE_FORBIDDEN, "simulation manifest");
        // the raw stored snapshot DOES hold extractor metadata — the learner payload no longer does
        Set<String> raw = keysOf(attempt(sim.attemptId()).manifestSnapshot());
        assertTrue(raw.contains("sourcePages") || raw.contains("acceptedAnswers"), "stored content unchanged (only the DTO is sanitized)");
        int passages = 0;
        for (PublicSectionDto s : m.sections()) for (PublicPartDto p : s.parts()) for (PublicGroupDto g : p.groups())
            for (PublicStimulusDto st : g.stimuli()) if (st.bodyPayload() != null && st.bodyPayload().get("text") != null) passages++;
        assertTrue(passages >= 3, "the learner passages are still delivered (" + passages + ")");
        // idempotent create retry (same client mutation id) returns the same attempt, no second row
        AttemptStateDto again = attempts.createAttempt(A, new CreateAttemptRequest(FORMS.get("CAM17_T1"), ExamAttemptMode.EXAM_SIMULATION,
                null, null, "p9-sim-a", List.of("READING")));
        assertEquals(sim.attemptId(), again.attemptId());
        assertEquals(1, count("SELECT COUNT(*) FROM exams.attempts WHERE user_id = ? AND attempt_mode = 'EXAM_SIMULATION'", A));
        REPORT.put("simulationLiveManifest", Map.of("leaks", 0, "passages", passages));
    }

    @Test
    @Order(3)
    @DisplayName("21-28: user B can neither read nor mutate user A's attempt / manifest / responses / submit / result / review / "
            + "Practice Again / media grant; B's analytics never contain A's data")
    void crossUser() {
        UUID p5 = ATT.get("P5"), sim = ATT.get("SIM"), l1 = ATT.get("L1");
        long before = attempt(p5).revision();
        expectDenied(() -> attempts.getAttemptState(B, p5), "21 read attempt");
        expectDenied(() -> attempts.getAttemptManifest(B, sim), "21 read manifest");
        expectDenied(() -> responses.saveResponseBatch(B, p5, new SaveResponseBatchRequest(null, before,
                List.of(cmd(placements(p5, A).values().iterator().next(), "A")))), "22 mutate responses");
        expectDenied(() -> responses.submitAttempt(B, p5, new SubmitAttemptRequest("x", before, SubmissionReason.MANUAL, List.of())), "23 submit");
        expectDenied(() -> attempts.abandonAttempt(B, sim), "abandon");
        expectDenied(() -> attempts.completeSectionAndAdvance(B, sim, UUID.randomUUID(), null), "complete section");
        expectDenied(() -> attempts.takeoverSession(B, sim), "takeover");
        assertEquals(before, attempt(p5).revision(), "nothing written by B");
        assertEquals(ExamAttemptStatus.IN_PROGRESS, attempt(p5).status());
        // results / review / Practice Again (A finishes first)
        answerAll(p5, A, true);
        submit(p5, A);
        expectDenied(() -> practice.getResult(B, p5), "24 result");
        expectDenied(() -> practice.getReview(B, p5), "25 review");
        expectDenied(() -> results.getAttemptResult(p5, B, false), "24 generic result");
        expectDenied(() -> results.getAttemptReview(p5, B, false), "25 generic review");
        expectDenied(() -> practice.practiceAgain(B, p5, null), "27 practice again");
        // 28: media grant of A's listening attempt
        UUID asset = ExamPracticeScope.pinnedAssetIds(attempt(l1).manifestSnapshot()).iterator().next();
        expectDenied(() -> media.createPlaybackGrant(B, l1, asset, MediaPurpose.PRACTICE_AUDIO), "28 media grant");
        assertNotNull(media.createPlaybackGrant(A, l1, asset, MediaPurpose.PRACTICE_AUDIO).grantToken(), "the owner gets the grant");
        // 26: analytics
        practise("ETS26_T1", "TOEIC_PART_6", B, false);
        ExamAnalyticsDto bDto = analytics.getAnalytics(B, ExamFamily.TOEIC);
        String bJson = MAPPER.valueToTree(bDto).toString();
        for (UUID a : List.of(p5, sim, l1)) assertFalse(bJson.contains(a.toString()), "B's analytics never mention A's attempts");
        assertEquals(List.of("TOEIC_PART_6"), bDto.families().get(0).scopes().stream().map(ScopeStatsDto::scopeCode).toList(),
                "only B's own practised scope counts for B");
        assertEquals(1, bDto.families().get(0).practice().attempts());
        REPORT.put("crossUser", "DENIED_ALL");
    }

    @Test
    @Order(4)
    @DisplayName("15/16/19/72: post-submit review = canonical answer only; analytics + recommendations + history carry no answers / keys")
    void postSubmitPayloads() {
        UUID p5 = ATT.get("P5");
        PracticeReviewDto review = practice.getReview(A, p5);
        assertNoKeys(review, REVIEW_FORBIDDEN, "practice review");
        assertTrue(review.toString().contains("correctAnswers"), "the canonical answer is shown after submission");
        assertNoKeys(results.getAttemptReview(p5, A, false), REVIEW_FORBIDDEN, "generic review");
        ExamAnalyticsDto a = analytics.getAnalytics(A, null);
        assertNoKeys(a, LIVE_FORBIDDEN, "analytics");
        Set<String> k = keysOf(a);
        assertFalse(k.contains("prompt") || k.contains("answerPayload") || k.contains("textResponse") || k.contains("userId"),
                "analytics carry no prompt / answer / user id");
        assertNoKeys(attempts.getHistory(A, null, null, null, 20, 0), LIVE_FORBIDDEN, "history");
        assertNoKeys(practice.getCatalog(FORMS.get("ETS26_T1")), LIVE_FORBIDDEN, "practice scopes");
        String first = MAPPER.valueToTree(analytics.getAnalytics(A, ExamFamily.TOEIC).families().get(0).recommendations()).toString();
        String second = MAPPER.valueToTree(analytics.getAnalytics(A, ExamFamily.TOEIC).families().get(0).recommendations()).toString();
        assertEquals(first, second, "71: recommendations stay deterministic");
    }

    @Test
    @Order(5)
    @DisplayName("29-37/63/65/67: server deadline — on-time autosave OK; late autosave refused; late submit = TIME_LIMIT without late "
            + "answers; duplicate submit = same submission, no second scoring / evidence; stale autosave after submit refused")
    void deadlineAndDuplicateSubmit() {
        UUID sim = ATT.get("SIM");
        Map<UUID, String> pl = placements(sim, A);
        // the snapshot pins the whole form; the READING simulation exposes (and accepts) only its Reading placements
        List<ExamAttemptSnapshotContent.SnapshotItem> its = items(sim).stream().filter(i -> pl.containsKey(i.itemId())).toList();
        assertTrue(its.size() >= 2);
        String p1 = pl.get(its.get(0).itemId()), p2 = pl.get(its.get(1).itemId());
        long rev = attempt(sim).revision();
        responses.saveResponseBatch(A, sim, new SaveResponseBatchRequest(null, rev, List.of(cmd(p1, key(its.get(0))))));
        // 63: resume — a reconnecting client reads its saved answer back from the server
        assertTrue(attempts.getAttemptState(A, sim).responses().containsKey(p1));
        // time passes on the SERVER (the stored deadlines move into the past; no client clock involved)
        jdbc.update("UPDATE exams.attempts SET scheduled_end_at = now() - interval '5 minutes' WHERE id = ?", sim);
        jdbc.update("UPDATE exams.attempt_sections SET deadline_at = now() - interval '5 minutes' WHERE attempt_id = ?", sim);
        long rev2 = attempt(sim).revision();
        ExamWriteClosedException late = assertThrows(ExamWriteClosedException.class, () -> responses.saveResponseBatch(A, sim,
                new SaveResponseBatchRequest(null, rev2, List.of(cmd(p2, key(its.get(1)))))));
        assertEquals(ExamDeadlinePolicy.ATTEMPT_DEADLINE_PASSED, late.getCode());
        assertEquals(0, count("SELECT COUNT(*) FROM exams.responses WHERE attempt_id = ? AND placement_id = ?", sim, p2));
        // 36: reconnect after the deadline — state is readable, remaining time 0, no write possible
        AttemptStateDto state = attempts.getAttemptState(A, sim);
        assertTrue(state.sections().stream().allMatch(s -> s.remainingSeconds() == null || s.remainingSeconds() == 0));
        // 30: late submit — finalized with the saved answer only, reason TIME_LIMIT
        ExamResponseService.SubmitOutcome o = responses.submitAttemptWithOutcome(A, sim, new SubmitAttemptRequest("p9-late", rev2,
                SubmissionReason.MANUAL, List.of(cmd(p2, key(its.get(1))))));
        assertEquals(1, o.finalResponsesNotApplied());
        assertEquals(ExamDeadlinePolicy.ATTEMPT_DEADLINE_PASSED, o.closure());
        assertEquals("TIME_LIMIT", jdbc.queryForObject("SELECT reason FROM exams.submissions WHERE attempt_id = ?", String.class, sim));
        assertEquals(0, count("SELECT COUNT(*) FROM exams.responses WHERE attempt_id = ? AND placement_id = ?", sim, p2));
        assertEquals(1, count("SELECT COUNT(*) FROM exams.responses WHERE attempt_id = ? AND placement_id = ?", sim, p1));
        int artifacts = count("SELECT COUNT(*) FROM exams.score_artifacts sa JOIN exams.submissions s ON s.id = sa.submission_id WHERE s.attempt_id = ?", sim);
        int jobs = count("SELECT COUNT(*) FROM exams.jobs j JOIN exams.submissions s ON s.id = j.submission_id WHERE s.attempt_id = ?", sim);
        int evidence = count("SELECT COUNT(*) FROM exams.profile_evidence");
        // 33/34/35/39: duplicate submits (stale revision, a different mutation id, a new final answer) → the same submission
        for (int i = 0; i < 3; i++) {
            ExamResponseService.SubmitOutcome dup = responses.submitAttemptWithOutcome(A, sim, new SubmitAttemptRequest("p9-dup-" + i,
                    rev2 - 1, SubmissionReason.MANUAL, List.of(cmd(p2, "B"))));
            assertTrue(dup.replayed());
            assertEquals(o.submissionId(), dup.submissionId());
        }
        assertEquals(1, count("SELECT COUNT(*) FROM exams.submissions WHERE attempt_id = ?", sim));
        assertEquals(artifacts, count("SELECT COUNT(*) FROM exams.score_artifacts sa JOIN exams.submissions s ON s.id = sa.submission_id WHERE s.attempt_id = ?", sim));
        assertEquals(jobs, count("SELECT COUNT(*) FROM exams.jobs j JOIN exams.submissions s ON s.id = j.submission_id WHERE s.attempt_id = ?", sim));
        assertEquals(evidence, count("SELECT COUNT(*) FROM exams.profile_evidence"));
        // 31/32: stale autosave after submission refused, nothing mutated
        long finalRev = attempt(sim).revision();
        ExamWriteClosedException closed = assertThrows(ExamWriteClosedException.class, () -> responses.saveResponseBatch(A, sim,
                new SaveResponseBatchRequest(null, finalRev, List.of(cmd(p1, "Z")))));
        assertEquals(ExamDeadlinePolicy.ATTEMPT_NOT_WRITABLE, closed.getCode());
        assertEquals(1, count("SELECT COUNT(*) FROM exams.responses WHERE attempt_id = ? AND placement_id = ? AND text_response = ?",
                sim, p1, key(its.get(0))));
        REPORT.put("deadline", Map.of("lateAutosave", late.getCode(), "lateSubmitReason", "TIME_LIMIT", "finalResponsesNotApplied", 1,
                "duplicateSubmits", 3, "submissions", 1, "newArtifactsOnDuplicate", 0, "newJobsOnDuplicate", 0));
    }

    @Test
    @Order(6)
    @DisplayName("38/24/41: PRACTICE stays untimed (no deadline); two tabs: a stale tab request is never applied, last acknowledged wins")
    void practiceUntimedAndTwoTabs() {
        UUID id = practice.createPracticeAttempt(A, new CreatePracticeAttemptRequest(FORMS.get("ETS26_T1"), "TOEIC_PART_6", null)).attemptId();
        start(id, A);
        AttemptRecord a = attempt(id);
        assertNull(a.scheduledEndAt(), "practice has no scheduled end");
        assertEquals(0, count("SELECT COUNT(*) FROM exams.attempt_sections WHERE attempt_id = ? AND deadline_at IS NOT NULL", id));
        String q1 = placements(id, A).get(items(id).get(0).itemId());
        long r0 = a.revision();
        responses.saveResponseBatch(A, id, new SaveResponseBatchRequest("tabA-1", r0, List.of(cmd(q1, "A"))));       // tab A
        ExamConcurrencyException stale = assertThrows(ExamConcurrencyException.class, () ->                          // tab B (stale)
                responses.saveResponseBatch(A, id, new SaveResponseBatchRequest("tabB-1", r0, List.of(cmd(q1, "B")))));
        assertEquals("ATTEMPT_REVISION_CONFLICT", stale.getCode());
        assertEquals("A", jdbc.queryForObject("SELECT text_response FROM exams.responses WHERE attempt_id = ? AND placement_id = ?", String.class, id, q1));
        long r1 = attempt(id).revision();
        responses.saveResponseBatch(A, id, new SaveResponseBatchRequest("tabB-2", r1, List.of(cmd(q1, "B"))));        // B after refresh
        assertThrows(ExamConcurrencyException.class, () ->                                                           // A's delayed request
                responses.saveResponseBatch(A, id, new SaveResponseBatchRequest("tabA-late", r0, List.of(cmd(q1, "C")))));
        // 64: an autosave retry with the same mutation id is a replay, never a second write
        responses.saveResponseBatch(A, id, new SaveResponseBatchRequest("tabB-2", r1, List.of(cmd(q1, "B"))));
        assertEquals("B", jdbc.queryForObject("SELECT text_response FROM exams.responses WHERE attempt_id = ? AND placement_id = ?", String.class, id, q1));
        assertEquals(r1 + 1, attempt(id).revision(), "the replay did not bump the revision");
        submit(id, A);
        assertThrows(ExamWriteClosedException.class, () -> responses.saveResponseBatch(A, id,
                new SaveResponseBatchRequest("tabA-post", attempt(id).revision(), List.of(cmd(q1, "D")))));
        ATT.put("TWO_TAB_PRACTICE", id);
    }

    @Test
    @Order(7)
    @DisplayName("42/25/77: Practice Again rapid duplicates (fresh mutation ids) ⇒ ONE new attempt on the same pinned form; old attempt intact")
    void practiceAgainRapidDuplicates() {
        UUID p7 = ATT.get("TWO_TAB_PRACTICE");
        String hashBefore = attempt(p7).pinnedManifestHash();
        PracticeAttemptDto first = practice.practiceAgain(A, p7, "again-" + UUID.randomUUID());
        PracticeAttemptDto second = practice.practiceAgain(A, p7, "again-" + UUID.randomUUID());
        PracticeAttemptDto third = practice.practiceAgain(A, p7, null);
        assertFalse(first.resumedExisting());
        assertEquals(first.attemptId(), second.attemptId());
        assertEquals(first.attemptId(), third.attemptId());
        assertTrue(second.resumedExisting());
        assertEquals(1, count("SELECT COUNT(*) FROM exams.attempts WHERE manifest_snapshot -> 'practiceScope' ->> 'practiceAgainOf' = ?", p7.toString()));
        assertEquals(attempt(p7).formId(), attempt(first.attemptId()).formId(), "same pinned form version");
        assertEquals(ExamAttemptStatus.SUBMITTED, attempt(p7).status());
        assertEquals(hashBefore, attempt(p7).pinnedManifestHash(), "the old attempt is never touched");
        // after the retry is submitted a NEW retry is allowed again
        start(first.attemptId(), A);
        submit(first.attemptId(), A);
        assertNotEquals(first.attemptId(), practice.practiceAgain(A, p7, null).attemptId());
    }

    @Test
    @Order(8)
    @DisplayName("47: a grant for an asset outside the practice scope is refused (ASSET_NOT_IN_ATTEMPT_SCOPE)")
    void outOfScopeAsset() {
        UUID l2 = practice.createPracticeAttempt(A, new CreatePracticeAttemptRequest(FORMS.get("CAM17_T1"), "IELTS_LISTENING_SECTION_2", null)).attemptId();
        start(l2, A);
        UUID foreignAsset = ExamPracticeScope.pinnedAssetIds(attempt(ATT.get("L1")).manifestSnapshot()).iterator().next();
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> media.createPlaybackGrant(A, l2, foreignAsset, MediaPurpose.PRACTICE_AUDIO));
        assertTrue(e.getMessage().startsWith("ASSET_NOT_IN_ATTEMPT_SCOPE"));
    }

    @Test
    @Order(9)
    @DisplayName("61/43: Practice never creates official evidence (exams.profile_evidence from PRACTICE attempts = 0)")
    void practiceEvidenceZero() {
        assertEquals(0, count("SELECT COUNT(*) FROM exams.profile_evidence pe JOIN exams.attempts a ON a.id = pe.attempt_id "
                + "WHERE a.attempt_mode = 'PRACTICE'"));
        assertEquals(0, count("SELECT COUNT(*) FROM exams.attempts WHERE attempt_mode = 'PRACTICE' "
                + "AND jsonb_array_length(COALESCE(manifest_snapshot -> 'evidenceBasis' -> 'evidenceSkills', '[]'::jsonb)) > 0"));
        REPORT.put("practiceOfficialEvidence", 0);
    }

    @Test
    @Order(10)
    @DisplayName("34/69/70: analytics performance — bounded window (≤ 150 practice attempts), constant query count, measured timings")
    void analyticsPerformance() {
        UUID seed = practise("ETS26_T1", "TOEIC_PART_5", PERF, true);
        int items = count("SELECT COUNT(*) FROM exams.responses WHERE attempt_id = ?", seed);
        Map<String, Object> perf = new LinkedHashMap<>();
        analytics.getAnalytics(PERF, ExamFamily.TOEIC); // warm the availability index (5-minute cache) + JIT
        int total = 1;
        for (int target : List.of(5, 50, 150, 200)) {
            while (total < target) {
                clonePracticeAttempt(seed, total);
                total++;
            }
            long[] ms = new long[5];
            int statements = 0;
            ExamAnalyticsDto last = null;
            for (int i = 0; i < ms.length; i++) {
                STATEMENTS.set(0);
                long t0 = System.nanoTime();
                last = analytics.getAnalytics(PERF, ExamFamily.TOEIC);
                ms[i] = (System.nanoTime() - t0) / 1_000_000;
                statements = STATEMENTS.get();
            }
            Arrays.sort(ms);
            int practised = last.families().get(0).practice().attempts();
            assertTrue(practised <= 150, "server-defined cap holds: " + practised);
            assertTrue(statements <= 6, "constant query count (no N+1): " + statements);
            perf.put("history_" + target, Map.of("attemptsInDb", total, "attemptsAnalysed", practised,
                    "responsesPerAttempt", items, "statements", statements, "medianMs", ms[2], "maxMs", ms[4]));
        }
        Runtime rt = Runtime.getRuntime();
        perf.put("heapUsedMbAfter", (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024));
        REPORT.put("analyticsPerformance", perf);
        @SuppressWarnings("unchecked") Map<String, Object> cap = (Map<String, Object>) perf.get("history_200");
        assertTrue(((Number) cap.get("maxMs")).longValue() < 10_000, "bounded worst case: " + cap);
    }

    /** Synthetic history: a copy of a real submitted practice attempt (same pinned snapshot + responses), older timestamps. */
    static void clonePracticeAttempt(UUID source, int n) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO exams.attempts
                SELECT (jsonb_populate_record(NULL::exams.attempts, to_jsonb(a) || jsonb_build_object(
                    'id', ?::text,
                    'started_at', to_jsonb(a.started_at - make_interval(mins => ?)),
                    'submitted_at', to_jsonb(a.submitted_at - make_interval(mins => ?)),
                    'created_at', to_jsonb(a.created_at - make_interval(mins => ?))))).*
                FROM exams.attempts a WHERE a.id = ?""", id.toString(), n * 30, n * 30, n * 30, source);
        jdbc.update("""
                INSERT INTO exams.responses
                SELECT (jsonb_populate_record(NULL::exams.responses, to_jsonb(r) || jsonb_build_object(
                    'id', gen_random_uuid()::text, 'attempt_id', ?::text))).*
                FROM exams.responses r WHERE r.attempt_id = ?""", id.toString(), source);
    }
}
