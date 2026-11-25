package com.englishcoach.learningpath;

import com.englishcoach.common.contract.LearnerDnaSnapshot;
import com.englishcoach.common.contract.LearnerDnaSnapshotProvider;
import com.englishcoach.learningpath.LearningPathDtos.*;
import com.englishcoach.progress.config.LearningProgressProperties;
import com.englishcoach.reading.service.ReadingCompletionService;
import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.exception.WritingValidationException;
import com.englishcoach.writing.service.WritingPracticeSubmissionService;
import org.springframework.web.server.ResponseStatusException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/**
 * The real V96 schema on PostgreSQL 17 (after V94 / V95), used as production does: through the least-privilege
 * application role. Minimal copies of the source-module tables the evidence reader touches are created with their real
 * column names. Covers: AI-free plan creation, idempotent days (also with concurrent tabs), completion only from real
 * server rows of the right learner and content, day change without false completion, honest provisional level, the
 * explicit DNA proposal → confirm flow (never automatic), staleness, rate limit and account isolation.
 */
class LearningPathPostgresTest {

    private static DriverManagerDataSource admin;
    private static JdbcTemplate sql;
    private static LearningPathService service;
    private static LearningPathRepository repo;
    private static TransactionTemplate tx;
    private static LearnerDnaSnapshotProvider dna;
    private static ReadingCompletionService reading;
    private static WritingPracticeSubmissionService writing;
    /** Exams module stand-in: the practice-ready parts its catalog would list and the raw outcome of a scored attempt. */
    private static final ExamStub EXAMS = new ExamStub();

    static final class ExamStub implements LearningExamPractice {
        final List<Scope> scopes = new CopyOnWriteArrayList<>();
        final Map<UUID, Outcome> outcomes = new ConcurrentHashMap<>();
        @Override public List<Scope> practiceScopes(String family) { return scopes.stream().filter(s -> s.family().equals(family)).toList(); }
        @Override public Optional<Outcome> outcome(long userId, UUID attemptId) { return Optional.ofNullable(outcomes.get(attemptId)); }
    }
    private static final ZoneId ZONE = ZoneId.of("Asia/Ho_Chi_Minh");
    private static long nextUser = 100;

    @BeforeAll
    static void start() throws Exception {
        PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        admin = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Connection c = admin.getConnection(); Statement st = c.createStatement()) {
            st.execute("""
                    CREATE SCHEMA exams;
                    CREATE TABLE public.users (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL);
                    INSERT INTO public.users SELECT g, 'Learner ' || g FROM generate_series(1, 400) g;
                    CREATE TABLE public.user_proficiency (user_id BIGINT PRIMARY KEY, current_cefr VARCHAR(2),
                        overall_status VARCHAR(15) NOT NULL DEFAULT 'UNDETERMINED');
                    CREATE TABLE public.skill_proficiency (user_id BIGINT NOT NULL, skill VARCHAR(16) NOT NULL, rating INT,
                        status VARCHAR(15) NOT NULL, confidence NUMERIC, PRIMARY KEY (user_id, skill));
                    CREATE TABLE public.proficiency_placement_attempt (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL,
                        result_cefr VARCHAR(2), status VARCHAR(10) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
                    CREATE TABLE public.flashcards (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, status VARCHAR(255) NOT NULL,
                        state INT NOT NULL DEFAULT 0, review_count INT NOT NULL DEFAULT 0, next_review_date TIMESTAMP, updated_at TIMESTAMP);
                    CREATE TABLE exams.form_versions (id UUID PRIMARY KEY);
                    CREATE TABLE exams.attempts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id BIGINT NOT NULL,
                        form_id UUID, family VARCHAR(32) NOT NULL, attempt_mode VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL,
                        client_session_meta JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), submitted_at TIMESTAMPTZ);
                    CREATE TABLE public.writing_sessions (id VARCHAR(64) PRIMARY KEY, user_id BIGINT NOT NULL, task_id VARCHAR(64) NOT NULL,
                        task_snapshot JSONB NOT NULL, stage VARCHAR(32) NOT NULL DEFAULT 'DRAFTING', working_text TEXT NOT NULL DEFAULT '',
                        current_revision BIGINT NOT NULL DEFAULT 1);
                    CREATE TABLE exams.responses (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id UUID NOT NULL,
                        answer_payload JSONB, text_response TEXT, recording_id UUID);
                    CREATE TABLE public.listening_materials (id BIGSERIAL PRIMARY KEY, title VARCHAR(255), cefr_level VARCHAR(255),
                        owner_user_id BIGINT, is_system BOOLEAN NOT NULL DEFAULT false);
                    CREATE TABLE public.listening_exercises (id BIGSERIAL PRIMARY KEY, listening_material_id BIGINT NOT NULL,
                        exercise_type VARCHAR(255) NOT NULL);
                    CREATE TABLE public.listening_sessions (id BIGSERIAL PRIMARY KEY, user_id BIGINT, listening_material_id BIGINT NOT NULL,
                        started_at TIMESTAMP, ended_at TIMESTAMP);
                    CREATE TABLE public.exercise_attempts (id BIGSERIAL PRIMARY KEY, listening_session_id BIGINT NOT NULL,
                        listening_exercise_id BIGINT NOT NULL, is_correct BOOLEAN, accuracy_percentage DOUBLE PRECISION);
                    CREATE TABLE public.reading_materials (id BIGSERIAL PRIMARY KEY, title VARCHAR(255) NOT NULL,
                        difficulty_level VARCHAR(255), word_count INT, owner_user_id BIGINT, is_system BOOLEAN NOT NULL DEFAULT false);
                    CREATE TABLE public.user_reading_progress (id BIGSERIAL PRIMARY KEY, user_id BIGINT, reading_material_id BIGINT,
                        scroll_percentage INT, last_read_at TIMESTAMP);
                    CREATE TABLE public.writing_submissions (id VARCHAR(64) PRIMARY KEY, user_id BIGINT NOT NULL, session_id VARCHAR(64),
                        practice_id VARCHAR(64), kind VARCHAR(32) NOT NULL, word_count INT NOT NULL DEFAULT 0,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
                    CREATE TABLE public.writing_assessments (id VARCHAR(64) PRIMARY KEY, submission_id VARCHAR(64) NOT NULL,
                        status VARCHAR(32) NOT NULL, overall_score INT, completed_at TIMESTAMPTZ);
                    CREATE TABLE public.learning_activity_events (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL,
                        activity_type VARCHAR(64) NOT NULL, source_ref VARCHAR(128) NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
                    -- SYSTEM content: two B1 dictation materials with 20 segments, one private material, B1 readings
                    INSERT INTO public.listening_materials (title, cefr_level, is_system) VALUES ('Morning routines', 'B1', true),
                        ('City transport', 'B1', true);
                    INSERT INTO public.listening_materials (title, cefr_level, owner_user_id, is_system) VALUES ('Private', 'B1', 1, false);
                    INSERT INTO public.listening_exercises (listening_material_id, exercise_type)
                        SELECT m, 'DICTATION' FROM generate_series(1, 3) m, generate_series(1, 20);
                    INSERT INTO public.reading_materials (title, difficulty_level, word_count, is_system)
                        SELECT 'Reading ' || g, CASE WHEN g % 2 = 0 THEN 'A2' ELSE 'B1' END, 300 + g, true FROM generate_series(1, 12) g;
                    """);
            for (String v : List.of("V94__database_runtime_least_privilege.sql", "V95__speaking_topic_practice.sql", "V96__learning_path.sql",
                    "V97__reading_completion.sql", "V98__learning_path_writing_exam_completion.sql"))
                st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            st.execute("ALTER ROLE english_coach_app PASSWORD 'path-test-only'");
        }
        sql = new JdbcTemplate(admin);
        var app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "path-test-only");
        NamedParameterJdbcTemplate named = new NamedParameterJdbcTemplate(app);
        ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule());
        repo = new LearningPathRepository(named, mapper);
        dna = mock(LearnerDnaSnapshotProvider.class);
        StaticListableBeanFactory beans = new StaticListableBeanFactory(Map.of("dna", dna, "exams", EXAMS));
        service = new LearningPathService(repo, new LearningEvidenceReader(named), new LearningProgressProperties(),
                beans.getBeanProvider(LearnerDnaSnapshotProvider.class), beans.getBeanProvider(LearningExamPractice.class), mapper);
        writing = new WritingPracticeSubmissionService(named, new WritingProperties(), mapper);
        reading = new ReadingCompletionService(named);
        tx = new TransactionTemplate(new DataSourceTransactionManager(app));
    }

    @BeforeEach
    void realClock() {
        service.useClock(Clock.systemUTC());
        reset(dna);
    }

    private static synchronized long newUser() { return nextUser++; }

    private static TodayView goal(long user, String goal, int minutes, String target) {
        return tx.execute(s -> service.setGoal(user, new GoalRequest(goal, minutes, target)));
    }

    private static TodayView today(long user) {
        return tx.execute(s -> service.today(user));
    }

    @Test
    void firstPlanIsCreatedWithoutAiAndPointsToRealContent() {
        long user = newUser();
        assertThat(today(user).plan()).isNull();
        TodayView v = goal(user, "GENERAL", 15, null);
        assertThat(v.plan().levelBasis()).isEqualTo("PROVISIONAL");
        assertThat(v.tasks()).isNotEmpty().hasSizeLessThanOrEqualTo(4);
        assertThat(v.tasks().get(0).kind()).isEqualTo("PLACEMENT"); // nonblocking: the other tasks are there too
        assertThat(v.minutes() - v.tasks().get(0).minutes()).isLessThanOrEqualTo((int) (15 * 1.15));
        for (TaskView t : v.tasks()) {
            assertThat(t.status()).isEqualTo("OPEN");
            if (t.kind().equals("DICTATION"))
                assertThat(sql.queryForObject("SELECT is_system AND owner_user_id IS NULL FROM listening_materials WHERE id = ?",
                        Boolean.class, t.targetId())).isTrue();
            if (t.kind().equals("READING"))
                assertThat(sql.queryForObject("SELECT is_system FROM reading_materials WHERE id = ?", Boolean.class, t.targetId())).isTrue();
        }
        verifyNoInteractions(dna);
    }

    @Test
    void refreshesAndConcurrentTabsNeverDuplicateTheDay() throws Exception {
        long user = newUser();
        goal(user, "IELTS", 30, "6.5");
        service.useClock(Clock.offset(Clock.systemUTC(), Duration.ofDays(1))); // the first visit of a new day, in 10 tabs
        ExecutorService pool = Executors.newFixedThreadPool(5);
        List<Future<TodayView>> f = new ArrayList<>();
        for (int i = 0; i < 10; i++) f.add(pool.submit(() -> today(user)));
        Set<List<Long>> ids = new HashSet<>();
        for (Future<TodayView> x : f) ids.add(x.get(60, TimeUnit.SECONDS).tasks().stream().map(TaskView::id).toList());
        pool.shutdown();
        assertThat(ids).hasSize(1);
        assertThat(sql.queryForObject("SELECT count(*) FROM learning_path_task WHERE user_id = ? AND plan_day = ?", Integer.class,
                user, java.sql.Date.valueOf(LocalDate.now(ZONE).plusDays(1)))).isEqualTo(ids.iterator().next().size());
    }

    @Test
    void onlyTheLearnersOwnServerRowsOnTheRightContentCompleteATask() {
        long user = newUser(), other = newUser();
        TodayView v = goal(user, "COMMUNICATION", 45, null);
        TaskView dict = v.tasks().stream().filter(t -> t.kind().equals("DICTATION")).findFirst().orElseThrow();
        long otherMaterial = dict.targetId() == 1 ? 2 : 1;
        // another learner's attempts on the same material, and this learner's attempts on another material: nothing
        attempts(other, dict.targetId(), dict.goalCount(), 90);
        attempts(user, otherMaterial, dict.goalCount(), 90);
        TaskView still = find(today(user), dict.id());
        assertThat(still.status()).isEqualTo("OPEN");
        assertThat(still.progress()).isZero();
        // partial work shows progress; a poor score still completes the task (completion ≠ performance)
        attempts(user, dict.targetId(), dict.goalCount() - 1, 20);
        assertThat(find(today(user), dict.id()).progress()).isEqualTo(dict.goalCount() - 1);
        attempts(user, dict.targetId(), dict.goalCount(), 20);
        TaskView done = find(today(user), dict.id());
        assertThat(done.status()).isEqualTo("DONE");
        assertThat(done.resultPct()).isEqualTo(20);
        // the speaking task completes only from a finished, long-enough round
        TaskView talk = v.tasks().stream().filter(t -> t.kind().equals("TOPIC_SPEAKING")).findFirst().orElseThrow();
        for (int i = 0; i < talk.goalCount(); i++) round(user, i, 10);
        assertThat(find(today(user), talk.id()).status()).isEqualTo("OPEN");
        for (int i = 0; i < talk.goalCount(); i++) round(user, 100 + i, 75);
        assertThat(find(today(user), talk.id()).status()).isEqualTo("DONE");
    }

    @Test
    void oneEvidenceRowNeverCompletesTwoTasks() {
        long user = newUser();
        goal(user, "GENERAL", 30, null);
        LocalDate day = LocalDate.now(ZONE);
        tx.executeWithoutResult(s -> repo.insert(user, List.of(
                new LearningPathRepository.NewTask(day, 30, 1, "VOCAB_REVIEW", "VOCABULARY", null, null, "", 3, 1, "REVIEW_DUE", null, Instant.now(), null),
                new LearningPathRepository.NewTask(day, 31, 1, "VOCAB_REVIEW", "VOCABULARY", null, null, "", 3, 1, "REVIEW_DUE", null, Instant.now(), null))));
        sql.update("INSERT INTO learning_activity_events (user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', 'c1:1', now())", user);
        today(user);
        today(user); // a replayed read links nothing again
        assertThat(sql.queryForObject("SELECT count(*) FROM learning_path_task WHERE user_id = ? AND kind = 'VOCAB_REVIEW' AND status = 'DONE'",
                Integer.class, user)).isEqualTo(1);
        // another learner's review never counts
        sql.update("INSERT INTO learning_activity_events (user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', 'c2:1', now())", newUser());
        today(user);
        assertThat(sql.queryForObject("SELECT count(*) FROM learning_path_task WHERE user_id = ? AND kind = 'VOCAB_REVIEW' AND status = 'DONE'",
                Integer.class, user)).isEqualTo(1);
    }

    @Test
    void aNewDayCarriesUnfinishedWorkAndCompletesNothingByItself() {
        long user = newUser();
        TodayView d1 = goal(user, "GENERAL", 30, null);
        List<Long> firstIds = d1.tasks().stream().map(TaskView::id).toList();
        service.useClock(Clock.offset(Clock.systemUTC(), Duration.ofDays(1)));
        TodayView d2 = today(user);
        assertThat(d2.day()).isEqualTo(d1.day().plusDays(1));
        assertThat(d2.tasks()).allMatch(t -> t.status().equals("OPEN"));
        assertThat(d2.tasks()).anyMatch(TaskView::carried);
        List<String> old = sql.queryForList("SELECT status FROM learning_path_task WHERE id IN (" +
                String.join(",", firstIds.stream().map(String::valueOf).toList()) + ")", String.class);
        assertThat(old).doesNotContain("DONE", "OPEN").allMatch(s -> s.equals("CARRIED") || s.equals("DROPPED"));
        // the placement offer is not repeated every day
        assertThat(d2.tasks()).noneMatch(t -> t.kind().equals("PLACEMENT"));
        // the same day stays stable
        assertThat(today(user).tasks()).extracting(TaskView::id).isEqualTo(d2.tasks().stream().map(TaskView::id).toList());
    }

    @Test
    void levelIsProvisionalUntilThereIsEvidence() {
        long user = newUser();
        assertThat(goal(user, "TOEIC", 30, "650").plan().levelBasis()).isEqualTo("PROVISIONAL");
        sql.update("INSERT INTO user_proficiency (user_id, current_cefr, overall_status) VALUES (?, 'B2', 'VERIFIED')", user);
        TodayView v = goal(user, "TOEIC", 45, "650");
        assertThat(v.plan().level()).isEqualTo("B2");
        assertThat(v.plan().levelBasis()).isEqualTo("PROFICIENCY");
        // today's assignments stay; from the next day the quiz is not offered while a level is known
        service.useClock(Clock.offset(Clock.systemUTC(), Duration.ofDays(1)));
        assertThat(today(user).tasks()).noneMatch(t -> t.kind().equals("PLACEMENT"));
        service.useClock(Clock.systemUTC());
        assertThatThrownBy(() -> goal(user, "TOEIC", 45, "999")).hasMessage("INVALID_TARGET");
        assertThatThrownBy(() -> goal(user, "GENERAL", 20, null)).hasMessage("INVALID_MINUTES");
    }

    @Test
    void learnerDnaOnlyProposesAndChangesThePlanAfterConfirmation() {
        long user = newUser();
        TodayView before = goal(user, "GENERAL", 30, null);
        today(user);
        verifyNoInteractions(dna);
        when(dna.getSnapshot(anyLong(), anyBoolean())).thenReturn(profile(user));
        ProposalView p = tx.execute(s -> service.propose(user));
        verify(dna).getSnapshot(user, true);
        assertThat(p.changes()).isNotEmpty();
        assertThat(p.facts().sounds()).containsExactly("/θ/", "/s/");
        // nothing changed yet
        assertThat(today(user).plan().version()).isEqualTo(before.plan().version());
        assertThat(today(user).plan().focus()).isEmpty();
        // a double click returns the same proposal; another learner cannot see or apply it
        assertThat(tx.execute(s -> service.propose(user)).id()).isEqualTo(p.id());
        assertThatThrownBy(() -> tx.execute(s -> service.apply(newUser(), p.id()))).hasMessage("NO_PLAN");
        long stranger = newUser();
        goal(stranger, "GENERAL", 15, null);
        assertThatThrownBy(() -> tx.execute(s -> service.apply(stranger, p.id()))).hasMessage("NOT_FOUND");
        // confirm
        List<Long> doneBefore = today(user).tasks().stream().filter(t -> t.status().equals("DONE")).map(TaskView::id).toList();
        TodayView after = tx.execute(s -> service.apply(user, p.id()));
        assertThat(after.plan().version()).isEqualTo(before.plan().version() + 1);
        assertThat(after.plan().focus()).containsEntry("VOCABULARY", 0.10);
        assertThat(after.tasks().stream().filter(t -> t.status().equals("DONE")).map(TaskView::id).toList()).containsAll(doneBefore);
        assertThatThrownBy(() -> tx.execute(s -> service.apply(user, p.id()))).hasMessage("ALREADY_DECIDED");
    }

    @Test
    void cancelledOrStaleProposalsKeepTheActivePlan() {
        long user = newUser();
        goal(user, "GENERAL", 30, null);
        when(dna.getSnapshot(anyLong(), anyBoolean())).thenReturn(profile(user));
        ProposalView p = tx.execute(s -> service.propose(user));
        tx.executeWithoutResult(s -> service.cancel(user, p.id()));
        assertThat(today(user).plan().focus()).isEmpty();
        sql.update("UPDATE learning_path_revision SET created_at = created_at - interval '1 minute' WHERE user_id = ?", user);
        ProposalView q = tx.execute(s -> service.propose(user));
        goal(user, "GENERAL", 45, null); // the plan moved on
        assertThatThrownBy(() -> tx.execute(s -> service.apply(user, q.id()))).hasMessage("STALE");
        assertThat(today(user).plan().focus()).isEmpty();
        // rate limit: at most 10 analyses a day
        for (int i = 0; i < 10; i++) {
            sql.update("UPDATE learning_path_revision SET created_at = created_at - interval '1 minute' WHERE user_id = ?", user);
            try { tx.execute(s -> service.propose(user)); } catch (LearningPathException e) { assertThat(e.code).isEqualTo("RATE_LIMITED"); }
        }
        sql.update("UPDATE learning_path_revision SET created_at = created_at - interval '1 minute' WHERE user_id = ?", user);
        assertThatThrownBy(() -> tx.execute(s -> service.propose(user))).hasMessage("RATE_LIMITED");
    }

    @Test
    void readOnlySummaryKeepsReadingUnmeasuredAndWritesNothing() {
        long user = newUser();
        goal(user, "GENERAL", 15, null);
        Integer rows = sql.queryForObject("SELECT count(*) FROM learning_path_task WHERE user_id = ?", Integer.class, user);
        ProgressSummary s = tx.execute(x -> service.summary(user));
        // Reading and Writing have no free scored source here: "not measured", never a low band
        assertThat(s.skills()).filteredOn(k -> k.skill().equals("READING") || k.skill().equals("WRITING"))
                .hasSize(2).allMatch(k -> k.band().equals("NOT_MEASURED"));
        assertThat(s.skills()).filteredOn(k -> !k.skill().equals("READING") && !k.skill().equals("WRITING"))
                .allMatch(k -> k.band().equals("UNKNOWN"));
        assertThat(sql.queryForObject("SELECT count(*) FROM learning_path_task WHERE user_id = ?", Integer.class, user)).isEqualTo(rows);
        assertThat(service.planSummary(user)).containsEntry("goal", "GENERAL").containsKey("todayRemainingSkills");
        assertThat(service.planSummary(newUser())).isEmpty();
    }

    // ── Reading completion, stable assignments, proficiency-aware levels, assignable kinds (2026-10-17 repair) ────

    @Test
    void finishingTheAssignedReadingOnTheServerCompletesExactlyThatTask() {
        long user = newUser(), other = newUser();
        TodayView v = goal(user, "GENERAL", 30, null);
        TaskView read = v.tasks().stream().filter(t -> t.kind().equals("READING")).findFirst().orElseThrow();
        List<String> before = identity(v);
        long material = read.targetId();
        // the reader opens the material; "Hoàn thành" at once is refused and writes nothing
        assertThat(tx.execute(s -> reading.open(user, material)).completed()).isFalse();
        ReadingCompletionService.Completion early = tx.execute(s -> reading.complete(user, material));
        assertThat(early.accepted()).isFalse();
        assertThat(early.retryAfterSeconds()).isPositive();
        assertThat(sql.queryForObject("SELECT count(*) FROM user_reading_progress WHERE user_id = ? AND completed_at IS NOT NULL",
                Integer.class, user)).isZero();
        assertThat(find(today(user), read.id()).status()).isEqualTo("OPEN");
        // another learner finishing the same text, or this learner finishing another text, completes nothing
        long otherText = sql.queryForObject("SELECT id FROM reading_materials WHERE id <> ? AND is_system ORDER BY id LIMIT 1",
                Long.class, material);
        readFor(other, material);
        readFor(user, otherText);
        assertThat(find(today(user), read.id()).status()).isEqualTo("OPEN");
        // after the server-measured reading time the completion is accepted and the task is DONE on the next read
        readFor(user, material);
        TodayView after = today(user);
        assertThat(find(after, read.id()).status()).isEqualTo("DONE");
        assertThat(after.done()).isEqualTo(1);
        Long row = sql.queryForObject("SELECT id FROM user_reading_progress WHERE user_id = ? AND reading_material_id = ?",
                Long.class, user, material);
        assertThat(sql.queryForObject("SELECT evidence_ref FROM learning_path_task WHERE id = ?", String.class, read.id()))
                .isEqualTo("rc:" + row);
        // repeating / replaying the completion changes nothing; refresh keeps the same tasks and contents
        java.sql.Timestamp at = sql.queryForObject("SELECT completed_at FROM user_reading_progress WHERE id = ?", java.sql.Timestamp.class, row);
        assertThat(tx.execute(s -> reading.complete(user, material)).accepted()).isTrue();
        assertThat(tx.execute(s -> reading.open(user, material)).completed()).isTrue();
        assertThat(sql.queryForObject("SELECT completed_at FROM user_reading_progress WHERE id = ?", java.sql.Timestamp.class, row)).isEqualTo(at);
        assertThat(identity(today(user))).isEqualTo(before);
        assertThat(today(user).done()).isEqualTo(1);
    }

    @Test
    void readingCompletionIsAccountScopedAndConcurrentRequestsWriteOnce() throws Exception {
        long owner = newUser(), stranger = newUser();
        Long priv = sql.queryForObject("INSERT INTO reading_materials (title, difficulty_level, word_count, owner_user_id, is_system) "
                + "VALUES ('Private notes', 'B1', 200, ?, false) RETURNING id", Long.class, owner);
        Long quarantined = sql.queryForObject("INSERT INTO reading_materials (title, difficulty_level, word_count, is_system) "
                + "VALUES ('Legacy', 'B1', 200, false) RETURNING id", Long.class);
        assertThatThrownBy(() -> tx.execute(s -> reading.open(stranger, priv))).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> tx.execute(s -> reading.complete(stranger, priv))).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> tx.execute(s -> reading.open(owner, quarantined))).isInstanceOf(ResponseStatusException.class);
        tx.execute(s -> reading.open(owner, priv));
        sql.update("UPDATE user_reading_progress SET opened_at = now() - interval '10 minutes' WHERE user_id = ?", owner);
        ExecutorService pool = Executors.newFixedThreadPool(4);
        List<Future<Boolean>> f = new ArrayList<>();
        for (int i = 0; i < 8; i++) f.add(pool.submit(() -> tx.execute(s -> reading.complete(owner, priv)).accepted()));
        for (Future<Boolean> x : f) assertThat(x.get(60, TimeUnit.SECONDS)).isTrue();
        pool.shutdown();
        assertThat(sql.queryForObject("SELECT count(*) FROM user_reading_progress WHERE user_id = ?", Integer.class, owner)).isEqualTo(1);
        assertThat(sql.queryForObject("SELECT count(*) FROM user_reading_progress WHERE user_id = ?", Integer.class, stranger)).isZero();
    }

    @Test
    void learnerDnaOrAGoalChangeNeverReplacesTodaysAssignments() {
        long user = newUser();
        TodayView v = goal(user, "IELTS", 30, "7.5");
        List<String> before = identity(v);
        when(dna.getSnapshot(anyLong(), anyBoolean())).thenReturn(profile(user));
        ProposalView p = tx.execute(s -> service.propose(user));
        assertThat(identity(today(user))).isEqualTo(before); // a proposal changes nothing
        TodayView applied = tx.execute(s -> service.apply(user, p.id()));
        assertThat(applied.plan().focus()).isNotEmpty();
        assertThat(identity(applied)).isEqualTo(before);
        // a goal change keeps today's tasks; a larger budget only adds new ones after them
        TodayView changed = goal(user, "TOEIC", 60, "650");
        assertThat(identity(changed).subList(0, before.size())).isEqualTo(before);
        assertThat(sql.queryForObject("SELECT count(*) FROM learning_path_task WHERE user_id = ? AND status = 'REPLACED'",
                Integer.class, user)).isZero();
        assertThat(today(user).plan().goal()).isEqualTo("TOEIC");
    }

    @Test
    void unknownLevelIsProvisionalA2EvenForAnAmbitiousGoalAndPlacementIsNotRepeatedOncePlaced() {
        long user = newUser();
        TodayView v = goal(user, "IELTS", 45, "7.5");
        assertThat(v.plan().level()).isEqualTo("A2");
        assertThat(v.plan().levelBasis()).isEqualTo("PROVISIONAL");
        assertThat(v.tasks().get(0).kind()).isEqualTo("PLACEMENT");
        // a writing task, if given, is a short A2-appropriate prompt (never the goal's IELTS Task 2)
        assertThat(v.tasks()).filteredOn(t -> t.kind().equals("WRITING")).allMatch(t -> "GENPARA".equals(t.targetKey()));
        // content never more than one step from A2 (test catalog: A2 / B1 readings, B1 dictation)
        assertThat(v.tasks()).filteredOn(t -> t.kind().equals("READING")).isNotEmpty().allMatch(t -> "A2".equals(t.targetKey()));
        assertThat(v.tasks()).filteredOn(t -> t.kind().equals("DICTATION")).allMatch(t -> "B1".equals(t.targetKey()));
        // the placement quiz completes its task; the next day uses the placement level and does not offer the quiz again
        sql.update("INSERT INTO proficiency_placement_attempt (user_id, result_cefr, status) VALUES (?, 'B1', 'VALID')", user);
        assertThat(today(user).tasks().get(0).status()).isEqualTo("DONE");
        service.useClock(Clock.offset(Clock.systemUTC(), Duration.ofDays(1)));
        TodayView next = today(user);
        assertThat(next.plan().level()).isEqualTo("B1");
        assertThat(next.plan().levelBasis()).isEqualTo("PLACEMENT");
        assertThat(next.tasks()).noneMatch(t -> t.kind().equals("PLACEMENT"));
        assertThat(identity(today(user))).isEqualTo(identity(next)); // the next day is created once
    }

    @Test
    void aSkillsOwnProficiencyRatingChoosesItsContentNeverTwoStepsAway() {
        long user = newUser();
        // overall A2 by placement, Reading verified at B2 (rating 560): Reading content from B2 ± 1 only
        sql.update("INSERT INTO proficiency_placement_attempt (user_id, result_cefr, status) VALUES (?, 'A2', 'VALID')", user);
        sql.update("INSERT INTO skill_proficiency (user_id, skill, rating, status, confidence) VALUES (?, 'READING', 560, 'VERIFIED', 0.82)", user);
        TodayView v = goal(user, "GENERAL", 30, null);
        assertThat(v.plan().level()).isEqualTo("A2");
        assertThat(v.tasks()).filteredOn(t -> t.kind().equals("READING")).isNotEmpty()
                .allMatch(t -> "B1".equals(t.targetKey())); // no B2 / C1 in the test catalog ⇒ one step down, never A2
        // an undetermined, low-confidence skill row is ignored
        long weak = newUser();
        sql.update("INSERT INTO skill_proficiency (user_id, skill, rating, status, confidence) VALUES (?, 'READING', 560, 'UNDETERMINED', 0.1)", weak);
        TodayView w = goal(weak, "GENERAL", 30, null);
        assertThat(w.tasks()).filteredOn(t -> t.kind().equals("READING")).isNotEmpty().allMatch(t -> "A2".equals(t.targetKey()));
    }

    @Test
    void unavailableContentAndRetiredKindsAreReplacedExplicitlyNeverCompleted() throws Exception {
        long user = newUser();
        TodayView v = goal(user, "GENERAL", 30, null);
        TaskView read = v.tasks().stream().filter(t -> t.kind().equals("READING")).findFirst().orElseThrow();
        LocalDate day = LocalDate.now(ZONE);
        tx.executeWithoutResult(s -> repo.insert(user, List.of(new LearningPathRepository.NewTask(day, 39, 1, "WRITING", "WRITING",
                null, null, "", 8, 1, "GOAL_CORE", null, Instant.now(), null))));
        sql.update("UPDATE reading_materials SET is_system = false, owner_user_id = 1 WHERE id = ?", read.targetId()); // no longer SYSTEM
        try {
            ExecutorService pool = Executors.newFixedThreadPool(4); // first reads after the change, in parallel tabs
            List<Future<TodayView>> f = new ArrayList<>();
            for (int i = 0; i < 6; i++) f.add(pool.submit(() -> today(user)));
            for (Future<TodayView> x : f) x.get(60, TimeUnit.SECONDS);
            pool.shutdown();
            TodayView after = today(user);
            assertThat(sql.queryForObject("SELECT count(*) FROM learning_path_task WHERE user_id = ? AND status = 'OPEN' "
                    + "GROUP BY skill ORDER BY count(*) DESC LIMIT 1", Integer.class, user)).isEqualTo(1); // nothing added twice
            assertThat(after.tasks()).noneMatch(t -> t.id() == read.id() || t.kind().equals("WRITING"));
            assertThat(sql.queryForList("SELECT status FROM learning_path_task WHERE user_id = ? AND (id = ? OR kind = 'WRITING')",
                    String.class, user, read.id())).containsOnly("REPLACED");
            assertThat(after.done()).isZero();
            assertThat(identity(today(user))).isEqualTo(identity(after)); // stable again
        } finally {
            sql.update("UPDATE reading_materials SET is_system = true, owner_user_id = NULL WHERE id = ?", read.targetId());
        }
    }

    // ── Writing (free, no AI) and exam practice (exact practice-ready part) — feature closure ──────────────────

    private static final String PARA_SNAPSHOT = """
            {"id":"gen-paragraph-01","title":"General Writing: The Power of Daily Reading (Single Paragraph)",
             "prompt":"Write a single paragraph explaining why reading every day can improve a person's life.",
             "guidance":"Write at least 80 words.","targetWordCountMin":80,"targetWordCountMax":130}""";
    private static final String ESSAY = "Reading every day changes my life in small but important ways. In the morning I read a short "
            + "article with my coffee, and this habit helps me learn new words without stress. When I meet a difficult sentence, "
            + "I try to guess the meaning from the context before I use a dictionary. Over time my reading speed has improved, and I "
            + "feel more confident when I talk with colleagues about the news. Reading also calms me down after a busy day at work.";

    private static String session(long user, String id, String text) {
        sql.update("INSERT INTO writing_sessions (id, user_id, task_id, task_snapshot, working_text) VALUES (?, ?, 'gen-paragraph-01', CAST(? AS jsonb), ?)",
                id, user, PARA_SNAPSHOT, text);
        return id;
    }

    @Test
    void aWritingTaskIsAssignedWithARealPromptAndCompletesOnlyFromTheLearnersFreePracticeSubmission() {
        long user = newUser(), other = newUser();
        goal(user, "GENERAL", 30, null);
        // a day planned with a writing focus (as after an applied Learner DNA revision); A2 provisional ⇒ the short prompt
        sql.update("DELETE FROM learning_path_task WHERE user_id = ?", user); // test only: plan the day again
        sql.update("UPDATE learning_path_plan SET focus = '{\"WRITING\": 0.2}'::jsonb WHERE user_id = ?", user);
        TaskView task = today(user).tasks().stream().filter(x -> x.kind().equals("WRITING")).findFirst().orElseThrow();
        assertThat(task.targetKey()).isEqualTo("GENPARA");
        assertThat(task.minutes()).isEqualTo(LearningPathEngine.writingMinutes(80));
        // refused submissions write nothing: too short, junk repetition, a copy of the prompt, a foreign session
        assertThatThrownBy(() -> tx.execute(s -> writing.submit(user, session(user, "s-short-" + user, "Reading is good."))))
                .isInstanceOf(WritingValidationException.class).hasMessageContaining("80");
        assertThatThrownBy(() -> tx.execute(s -> writing.submit(user, session(user, "s-junk-" + user, "good ".repeat(90)))))
                .isInstanceOf(WritingValidationException.class);
        String copy = "Write a single paragraph explaining why reading every day can improve a person's life. ".repeat(6);
        assertThatThrownBy(() -> tx.execute(s -> writing.submit(user, session(user, "s-copy-" + user, copy))))
                .isInstanceOf(WritingValidationException.class);
        String foreign = session(other, "s-other-" + other, ESSAY);
        assertThatThrownBy(() -> tx.execute(s -> writing.submit(user, foreign))).isInstanceOf(WritingNotFoundException.class);
        tx.execute(s -> writing.submit(other, foreign)); // another learner's real submission never counts for this learner
        assertThat(find(today(user), task.id()).status()).isEqualTo("OPEN");
        assertThat(sql.queryForObject("SELECT count(*) FROM writing_practice_submission WHERE user_id = ?", Integer.class, user)).isZero();
        // a real paragraph on the learner's own session: recorded once (a replay returns the same row), task DONE, no score
        String mine = session(user, "s-real-" + user, ESSAY);
        WritingPracticeSubmissionService.Result r = tx.execute(s -> writing.submit(user, mine));
        assertThat(r.wordCount()).isGreaterThanOrEqualTo(80);
        assertThat(tx.execute(s -> writing.submit(user, mine)).alreadySubmitted()).isTrue();
        TaskView done = find(today(user), task.id());
        assertThat(done.status()).isEqualTo("DONE");
        assertThat(done.resultPct()).isNull(); // participation, never a quality score
        assertThat(sql.queryForObject("SELECT evidence_ref FROM learning_path_task WHERE id = ?", String.class, task.id())).isEqualTo("wp:" + r.id());
        assertThat(tx.execute(s -> service.summary(user)).skills()).filteredOn(k -> k.skill().equals("WRITING"))
                .allMatch(k -> k.band().equals("NOT_MEASURED")); // no writing estimate from word count: not measured
    }

    @Test
    void examPracticeIsAssignedOnlyFromTheExamsCatalogAndCompletesOnlyFromTheExactSubmittedPart() {
        UUID form = UUID.randomUUID(), otherForm = UUID.randomUUID();
        sql.update("INSERT INTO exams.form_versions (id) VALUES (?), (?)", form, otherForm);
        EXAMS.scopes.clear();
        // unknown level ⇒ no exam task yet (the placement quiz comes first)
        long fresh = newUser();
        EXAMS.scopes.add(new LearningExamPractice.Scope(form, "TOEIC", "TOEIC_PART_5", "Economy TOEIC Test 1"));
        assertThat(goal(fresh, "TOEIC", 60, "650").tasks()).noneMatch(t -> t.kind().equals("EXAM_PRACTICE"));
        // known level (placement B1): one exact, practice-ready part of the catalog — never a writing / speaking part
        long user = newUser(), stranger = newUser();
        EXAMS.scopes.add(new LearningExamPractice.Scope(otherForm, "TOEIC", "TOEIC_PART_1", "Not in the path's list"));
        sql.update("INSERT INTO proficiency_placement_attempt (user_id, result_cefr, status) VALUES (?, 'B1', 'VALID')", user);
        TodayView v = goal(user, "TOEIC", 60, "650");
        TaskView exam = v.tasks().stream().filter(t -> t.kind().equals("EXAM_PRACTICE")).findFirst().orElseThrow();
        assertThat(exam.targetRef()).isEqualTo(form + "/TOEIC_PART_5");
        assertThat(exam.skill()).isEqualTo("READING");
        assertThat(exam.targetKey()).isEqualTo("TOEIC");
        List<String> before = identity(today(user));
        // another learner's attempt, another part of the same form, an empty submit: nothing
        UUID foreign = attempt(stranger, form, "TOEIC_PART_5", true);
        UUID wrongPart = attempt(user, form, "TOEIC_PART_6", true);
        UUID empty = attempt(user, form, "TOEIC_PART_5", false);
        EXAMS.outcomes.put(foreign, new LearningExamPractice.Outcome(30, 30, 90));
        EXAMS.outcomes.put(wrongPart, new LearningExamPractice.Outcome(16, 16, 75));
        assertThat(find(today(user), exam.id()).status()).isEqualTo("OPEN");
        // a submit after answering a third of the part is not a practised part
        UUID partial = attempt(user, form, "TOEIC_PART_5", true);
        EXAMS.outcomes.put(partial, new LearningExamPractice.Outcome(10, 30, 60));
        assertThat(find(today(user), exam.id()).status()).isEqualTo("OPEN");
        // the real practice of the assigned part: DONE with the server-scored raw accuracy, answered count as progress
        UUID real = attempt(user, form, "TOEIC_PART_5", true);
        EXAMS.outcomes.put(real, new LearningExamPractice.Outcome(28, 30, 70));
        TaskView done = find(today(user), exam.id());
        assertThat(done.status()).isEqualTo("DONE");
        assertThat(done.resultPct()).isEqualTo(70);
        assertThat(sql.queryForObject("SELECT evidence_ref FROM learning_path_task WHERE id = ?", String.class, exam.id())).isEqualTo("ex:" + real);
        assertThat(identity(today(user))).isEqualTo(before);
        assertThat(empty).isNotNull();
        // the scored part feeds the Reading practice estimate (IELTS / TOEIC goals measure Reading)
        assertThat(tx.execute(s -> service.summary(user)).skills()).filteredOn(k -> k.skill().equals("READING"))
                .allMatch(k -> !k.band().equals("NOT_MEASURED") && k.observations() == 1);
        // a stored family-only exam task (before exact parts existed) cannot lead anywhere: replaced, never completed
        long legacy = newUser();
        goal(legacy, "TOEIC", 45, "650");
        LocalDate day = LocalDate.now(ZONE);
        tx.executeWithoutResult(s -> repo.insert(legacy, List.of(new LearningPathRepository.NewTask(day, 38, 1, "EXAM_PRACTICE",
                "ASSESSMENT", null, "TOEIC", "", 20, 1, "GOAL_CHECK", null, Instant.now(), null))));
        today(legacy);
        assertThat(sql.queryForObject("SELECT status FROM learning_path_task WHERE user_id = ? AND kind = 'EXAM_PRACTICE' AND target_ref IS NULL",
                String.class, legacy)).isEqualTo("REPLACED");
        EXAMS.scopes.clear();
    }

    /** A submitted practice attempt as the Exams module persists it (server-written scope code, responses). */
    private static UUID attempt(long user, UUID form, String scope, boolean answered) {
        UUID id = UUID.randomUUID();
        sql.update("INSERT INTO exams.attempts (id, user_id, form_id, family, attempt_mode, status, client_session_meta, submitted_at) "
                + "VALUES (?, ?, ?, 'TOEIC', 'PRACTICE', 'SUBMITTED', CAST(? AS jsonb), now())", id, user, form,
                "{\"practiceScopeCode\":\"" + scope + "\"}");
        sql.update("INSERT INTO exams.responses (attempt_id, answer_payload) VALUES (?, CAST(? AS jsonb))", id,
                answered ? "{\"selected\":\"B\"}" : "null");
        return id;
    }

    private static List<String> identity(TodayView v) {
        return v.tasks().stream().map(t -> t.id() + ":" + t.kind() + ":" + t.targetId() + ":" + t.targetKey()).toList();
    }

    /** The real Reading path: open (server time), a reading time later, complete. */
    /**
     * Owner closure 2026-10-18 (Scenario F / G on the real service and schema): a FREE IELTS learner — no Premium, no AI
     * writing score — moves from stage 2 to stage 3 once the free milestones hold (strong server-scored dictation and
     * topic rounds, completed Writing and Reading practice tasks); until then the stage names the Writing practice it
     * waits for. Writing stays "not measured" throughout. A confident WEAK AI writing assessment is real evidence and
     * keeps another learner at stage 2 even with more practice; the stored stage never goes down.
     */
    @Test
    void aFreeLearnerAdvancesWithoutAnAiWritingScoreAndAConfidentAssessmentStillCounts() {
        long free = newUser();
        sql.update("INSERT INTO proficiency_placement_attempt (user_id, result_cefr, status) VALUES (?, 'B1', 'VALID')", free);
        goal(free, "IELTS", 45, "6.5");
        attempts(free, 1L, 10, 95.0);                       // Listening: 10 scored dictation segments
        for (int i = 0; i < 18; i++) round(free, 500 + i, 75); // Speaking: 18 finished rounds that reached their target
        doneHistory(free, 24, 2, 3);                         // 24 done tasks: 2 Writing, 3 Reading practice tasks
        StageView before = tx.execute(x -> service.today(free)).stage();
        assertThat(before.current()).isEqualTo(2);
        assertThat(before.next()).anySatisfy(r -> {
            assertThat(r.code()).isEqualTo("PRACTICE_WRITING");
            assertThat(r.current()).isEqualTo(2);
            assertThat(r.needed()).isEqualTo(3);
            assertThat(r.met()).isFalse();
        });
        // one more free Writing practice task (participation, no AI, no score) ⇒ stage 3
        doneHistory(free, 1, 1, 0);
        TodayView after = tx.execute(x -> service.today(free));
        assertThat(after.stage().current()).isEqualTo(3);
        assertThat(sql.queryForObject("SELECT stage FROM learning_path_plan WHERE user_id = ?", Integer.class, free)).isEqualTo(3);
        assertThat(tx.execute(x -> service.summary(free)).skills()).filteredOn(k -> k.skill().equals("WRITING"))
                .allMatch(k -> k.band().equals("NOT_MEASURED"));
        assertThat(sql.queryForObject("SELECT count(*) FROM writing_assessments a JOIN writing_submissions w ON w.id = a.submission_id "
                + "WHERE w.user_id = ?", Integer.class, free)).isZero();

        // the same free evidence, plus a confident but weak AI rubric (e.g. a Premium learner): the evidence decides
        long assessed = newUser();
        sql.update("INSERT INTO proficiency_placement_attempt (user_id, result_cefr, status) VALUES (?, 'B1', 'VALID')", assessed);
        goal(assessed, "IELTS", 45, "6.5");
        attempts(assessed, 2L, 10, 95.0);
        for (int i = 0; i < 18; i++) round(assessed, 700 + i, 75);
        for (int i = 0; i < 14; i++) {
            String w = "wa-" + assessed + "-" + i;
            sql.update("INSERT INTO writing_submissions (id, user_id, session_id, kind, word_count) VALUES (?, ?, ?, 'COACH_DRAFT', 120)",
                    w, assessed, "s-" + w);
            sql.update("INSERT INTO writing_assessments (id, submission_id, status, overall_score, completed_at) VALUES (?, ?, 'READY', 30, now())",
                    "a-" + w, w);
        }
        doneHistory(assessed, 24, 6, 3);
        assertThat(tx.execute(x -> service.today(assessed)).stage().current()).isEqualTo(2);
        assertThat(tx.execute(x -> service.summary(assessed)).skills()).filteredOn(k -> k.skill().equals("WRITING"))
                .allMatch(k -> k.band().equals("NEEDS_WORK"));
    }

    /** DONE tasks on earlier plan days (participation history fixture): {@code writing} Writing, {@code reading} Reading, rest dictation. */
    private static void doneHistory(long user, int total, int writing, int reading) {
        Integer base = sql.queryForObject("SELECT COALESCE(max(CURRENT_DATE - plan_day), 0) FROM learning_path_task WHERE user_id = ?",
                Integer.class, user);
        for (int i = 0; i < total; i++) {
            String kind = i < writing ? "WRITING" : i < writing + reading ? "READING" : "DICTATION";
            String skill = kind.equals("DICTATION") ? "LISTENING" : kind;
            int ago = base + 1 + i;
            sql.update("""
                    INSERT INTO learning_path_task (user_id, plan_day, position, plan_version, kind, skill, title, minutes, goal_count,
                        reason_code, status, assigned_at, completed_at, evidence_ref)
                    VALUES (?, CURRENT_DATE - ?, 1, 1, ?, ?, 'History', 10, 1, 'GOAL_CORE', 'DONE', now() - make_interval(days => ?),
                        now() - make_interval(days => ?), ?)""",
                    user, ago, kind, skill, ago, ago, "fx:" + user + ":" + ago);
        }
    }

    private static void readFor(long user, long material) {
        tx.execute(s -> reading.open(user, material));
        sql.update("UPDATE user_reading_progress SET opened_at = now() - interval '10 minutes' WHERE user_id = ? AND reading_material_id = ?",
                user, material);
        assertThat(tx.execute(s -> reading.complete(user, material)).accepted()).isTrue();
    }


    // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

    private static void attempts(long user, long material, int segments, double accuracy) {
        Long session = sql.queryForObject("INSERT INTO listening_sessions (user_id, listening_material_id, started_at) VALUES (?, ?, LOCALTIMESTAMP) RETURNING id",
                Long.class, user, material);
        List<Long> exercises = sql.queryForList("SELECT id FROM listening_exercises WHERE listening_material_id = ? ORDER BY id LIMIT ?",
                Long.class, material, segments);
        for (Long e : exercises)
            sql.update("INSERT INTO exercise_attempts (listening_session_id, listening_exercise_id, is_correct, accuracy_percentage) VALUES (?, ?, ?, ?)",
                    session, e, accuracy >= 80, accuracy);
    }

    private static void round(long user, int i, int seconds) {
        sql.update("""
                INSERT INTO speaking_topic_draws (user_id, request_id, item_id, style, bank_version, origin, status, target_seconds,
                    spoken_seconds, reached_target, drawn_at, started_at, finished_at)
                VALUES (?, ?, ?, 'QUICK', 'v1', 'SPIN', 'FINISHED', 60, ?, ?, now(), now(), now())""",
                user, UUID.randomUUID(), "QK-" + (1000 + i), seconds, seconds >= 60);
    }

    private static TaskView find(TodayView v, long id) {
        return v.tasks().stream().filter(t -> t.id() == id).findFirst().orElseThrow();
    }

    private static LearnerDnaSnapshot profile(long user) {
        return new LearnerDnaSnapshot(Instant.now().toString(),
                List.of("/θ/", "/s/", "<script>"), false,
                List.of("tense inconsistency"),
                2, 1,
                18L);
    }
}
