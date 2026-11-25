package com.englishcoach.kingofenglish;

import com.englishcoach.leaderboard.board.LeaderboardDisplayRepository;
import com.englishcoach.sentinel.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;
import java.nio.file.*;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.*;

/**
 * V119 on PostgreSQL 17 over the production shape of king_conquest_results (V105 + V113) holding the owner-approved
 * 357-point record with its real key (match ea3742f1-…, user 674). P0-01…P0-04, P0-16, P0-19, P0-20 of the directive.
 */
class SentinelPreservationPostgresTest {
    static final UUID RECORD = UUID.fromString("ea3742f1-3896-4731-930c-3b4d8cb0c25f");
    static final Instant RECORD_AT = Instant.parse("2026-11-12T13:15:27.980Z");
    static final UUID LEGACY_EXAM = UUID.randomUUID();
    static PostgreSQLContainer<?> pg; static JdbcTemplate sql; static KingConquestResults results; static SentinelService sentinel;
    static Map<String, Object> before;

    static String migration(String name) throws Exception { return Files.readString(Path.of("src/main/resources/db/migration/exams/" + name)); }

    @BeforeAll static void start() throws Exception {
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker not available");
        pg = new PostgreSQLContainer<>("postgres:17"); pg.start();
        sql = new JdbcTemplate(new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword()));
        sql.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, role VARCHAR(32) NOT NULL DEFAULT 'ROLE_USER', account_status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE');"
            + " INSERT INTO public.users(id) SELECT g FROM generate_series(1, 20) g; INSERT INTO public.users(id) VALUES (674); UPDATE public.users SET role='ROLE_ADMIN' WHERE id=1;");
        sql.execute(migration("V105__king_conquest_results.sql"));
        sql.execute(migration("V113__king_conquest_unlimited_score.sql"));
        // Historical rows as production holds them before V119 (the record, the admin's 353, ordinary learners).
        sql.update("INSERT INTO public.king_conquest_results(match_id,user_id,board_size,category,flow,score,word_count,territory,throne,won,finished_at) VALUES (?,674,5,'SOLO','SOLO',357,133,25,true,NULL,?)",
            RECORD, Timestamp.from(RECORD_AT));
        sql.update("INSERT INTO public.king_conquest_results(match_id,user_id,board_size,category,flow,score,word_count,territory,throne,won,finished_at) VALUES (gen_random_uuid(),1,5,'SOLO','SOLO',353,126,25,true,NULL,now())");
        for (int u = 2; u <= 6; u++)
            sql.update("INSERT INTO public.king_conquest_results(match_id,user_id,board_size,category,flow,score,word_count,territory,throne,won,finished_at) VALUES (gen_random_uuid(),?,5,'SOLO','SOLO',?,20,5,false,NULL,now())", u, 40 + u);
        before = sql.queryForMap("SELECT * FROM public.king_conquest_results WHERE match_id=? AND user_id=674", RECORD);
        sql.execute(migration("V119__echo_sentinel_attempts.sql"));
        // Minimal exams tables (the columns the Sentinel rule reads) with one simulation taken before activation.
        sql.execute("CREATE SCHEMA exams; CREATE TABLE exams.attempts (id UUID PRIMARY KEY, user_id BIGINT, attempt_mode VARCHAR(32), status VARCHAR(32), created_at TIMESTAMPTZ NOT NULL);"
            + " CREATE TABLE exams.submissions (id UUID PRIMARY KEY, attempt_id UUID); CREATE TABLE exams.score_artifacts (id UUID PRIMARY KEY, submission_id UUID);");
        sql.update("INSERT INTO exams.attempts VALUES (?,674,'EXAM_SIMULATION','SUBMITTED',now()-interval '1 day')", LEGACY_EXAM);
        sql.execute(migration("V120__echo_sentinel_coverage.sql"));
        @SuppressWarnings("unchecked") ObjectProvider<LeaderboardDisplayRepository> none = mock(ObjectProvider.class);
        results = new KingConquestResults(sql, none);
        sentinel = new SentinelService(new SentinelStore(sql), Clock.systemUTC());
        results.setSentinel(sentinel);
    }
    @AfterAll static void stop() { if (sentinel != null) sentinel.close(); if (pg != null) pg.stop(); }

    Map<String, Object> record() { return sql.queryForMap("SELECT * FROM public.king_conquest_results WHERE match_id=? AND user_id=674", RECORD); }

    @Test void theRecordIsUntouchedApprovedAndStillRanked() {
        var after = record();
        assertEquals(before.get("score"), after.get("score")); assertEquals(357, after.get("score"));
        for (var k : before.keySet()) assertEquals(before.get(k), after.get(k), k + " unchanged");
        assertNull(after.get("sentinel_attempt_id"), "historical row keeps its pre-Sentinel provenance");
        var approval = sql.queryForMap("SELECT * FROM public.sentinel_legacy_approvals WHERE match_id=?", RECORD);
        assertEquals(674L, ((Number) approval.get("user_id")).longValue()); assertEquals(357, approval.get("score"));
        assertEquals(1, sql.queryForObject("SELECT count(*) FROM public.sentinel_legacy_approvals", Integer.class), "exactly one named approval");
        @SuppressWarnings("unchecked") var top = (List<Map<String, Object>>) results.board(2, 5, "SOLO").get("top");
        assertEquals(357, top.getFirst().get("score"), "public leaderboard still includes it, at #1 today");
        assertEquals("Học viên #674", top.getFirst().get("name"));
        @SuppressWarnings("unchecked") var mine = (Map<String, Object>) results.board(674, 5, "SOLO").get("you");
        assertEquals(357, mine.get("best")); assertEquals(1, mine.get("rank"));
    }

    @Test void examEvidenceIsProspectiveAndNeedsAVerifiedAttemptBoundOnce() {
        var integrity = new SentinelExamIntegrity(sql);
        assertTrue(integrity.allowsAttempt(LEGACY_EXAM), "a simulation taken before activation keeps its historical rules");
        UUID fresh = UUID.randomUUID(), other = UUID.randomUUID();
        sql.update("INSERT INTO exams.attempts VALUES (?,5,'EXAM_SIMULATION','IN_PROGRESS',now()+interval '1 second')", fresh);
        sql.update("INSERT INTO exams.attempts VALUES (?,6,'EXAM_SIMULATION','IN_PROGRESS',now()+interval '1 second')", other);
        assertFalse(integrity.allowsAttempt(fresh), "no verified attempt: no evidence");
        assertTrue(integrity.bindable(5, fresh)); assertFalse(integrity.bindable(6, fresh), "another learner's exam");
        var b = sentinel.begin(5, SentinelPolicy.EXAM_SIMULATION, true, SentinelPolicy.POLICY_VERSION);
        assertNotNull(sentinel.bindSubject(5, b.id() + "." + b.token(), SentinelPolicy.EXAM_SIMULATION, fresh.toString()));
        // A second attempt for the same exam (reloaded page acknowledging again) is refused by the unique index.
        var again = sentinel.begin(5, SentinelPolicy.EXAM_SIMULATION, true, SentinelPolicy.POLICY_VERSION);
        assertNull(sentinel.bindSubject(5, again.id() + "." + again.token(), SentinelPolicy.EXAM_SIMULATION, fresh.toString()));
        assertFalse(integrity.allowsAttempt(fresh));
        // A fresh exam bound, kept on screen and submitted normally: evidence allowed, also through its artifact.
        UUID exam2 = UUID.randomUUID(), sub = UUID.randomUUID(), art = UUID.randomUUID();
        sql.update("INSERT INTO exams.attempts VALUES (?,5,'EXAM_SIMULATION','IN_PROGRESS',now()+interval '1 second')", exam2);
        sql.update("INSERT INTO exams.submissions VALUES (?,?)", sub, exam2); sql.update("INSERT INTO exams.score_artifacts VALUES (?,?)", art, sub);
        var c = sentinel.begin(5, SentinelPolicy.EXAM_SIMULATION, true, SentinelPolicy.POLICY_VERSION);
        sentinel.bindSubject(5, c.id() + "." + c.token(), SentinelPolicy.EXAM_SIMULATION, exam2.toString());
        sentinel.heartbeat(5, c.id(), c.token(), true);
        assertEquals(SentinelAttempt.State.COMPLETED_VERIFIED, sentinel.completeSubject(5, SentinelPolicy.EXAM_SIMULATION, exam2.toString()).to());
        assertTrue(integrity.allowsAttempt(exam2)); assertTrue(integrity.allowsArtifact(art));
        assertThrows(Exception.class, () -> sql.update("DELETE FROM public.sentinel_activation"));
        assertEquals(357, record().get("score"));
    }

    @Test void noRebuildOrCleanupCanRewriteOrDeleteIt() {
        assertThrows(Exception.class, () -> sql.update("UPDATE public.king_conquest_results SET score=0 WHERE match_id=?", RECORD));
        assertThrows(Exception.class, () -> sql.update("DELETE FROM public.king_conquest_results WHERE match_id=?", RECORD));
        assertThrows(Exception.class, () -> sql.update("DELETE FROM public.king_conquest_results"));
        assertThrows(Exception.class, () -> sql.update("DELETE FROM public.sentinel_legacy_approvals"));
        assertThrows(Exception.class, () -> sql.update("UPDATE public.sentinel_legacy_approvals SET score=0"));
        assertEquals(357, record().get("score"));
    }

    @Test void newResultsNeedAVerifiedAttemptOfTheSameLearner() {
        // No attempt, as before Sentinel: refused (a new 357 never inherits the historical status).
        var plain = new KingConquestResults.Row(UUID.randomUUID(), 674, 5, "SOLO", 357, 133, 25, true, null, Instant.now());
        assertThrows(Exception.class, () -> results.save(List.of(plain)));
        // A READY / ACTIVE / voided attempt, or another learner's: refused by the database itself.
        var b = sentinel.begin(674, SentinelPolicy.KING_CONQUEST, true, SentinelPolicy.POLICY_VERSION);
        assertThrows(Exception.class, () -> sql.update("INSERT INTO public.king_conquest_results(match_id,user_id,board_size,category,flow,score,word_count,territory,throne,finished_at,sentinel_attempt_id) VALUES (gen_random_uuid(),674,5,'SOLO','SOLO',999,1,1,false,now(),?)", b.id()));
        sentinel.violation(674, b.id(), b.token(), "HIDDEN");
        assertEquals("VOIDED_FOCUS_LOSS", sql.queryForObject("SELECT state FROM public.sentinel_attempts WHERE id=?", String.class, b.id()));
        assertThrows(Exception.class, () -> sql.update("UPDATE public.sentinel_attempts SET state='ACTIVE' WHERE id=?", b.id()), "a voided attempt never becomes ACTIVE again");
        assertThrows(Exception.class, () -> sql.update("UPDATE public.sentinel_attempts SET state='COMPLETED_VERIFIED' WHERE id=?", b.id()));
        assertThrows(Exception.class, () -> sql.update("DELETE FROM public.sentinel_attempts WHERE id=?", b.id()));
        assertThrows(Exception.class, () -> sql.update("DELETE FROM public.sentinel_attempt_events"));
        // A verified attempt of the same learner: accepted, and the same account is subject to the same rules as everyone.
        var v = sentinel.begin(674, SentinelPolicy.KING_CONQUEST, true, SentinelPolicy.POLICY_VERSION);
        var a = sentinel.resolve(674, v.id() + "." + v.token());
        assertNotNull(sentinel.bind(674, v.id() + "." + v.token(), SentinelPolicy.KING_CONQUEST, "ROOM1"));
        sentinel.playStarted(a, UUID.randomUUID().toString());
        sentinel.heartbeat(674, v.id(), v.token(), true);
        var done = sentinel.complete(a); assertEquals(SentinelAttempt.State.COMPLETED_VERIFIED, done.to());
        var match = UUID.randomUUID();
        results.save(List.of(new KingConquestResults.Row(match, 674, 5, "SOLO", 30, 5, 6, false, null, Instant.now(), done)));
        assertEquals(v.id(), sql.queryForObject("SELECT sentinel_attempt_id FROM public.king_conquest_results WHERE match_id=?", UUID.class, match));
        assertEquals(0, sql.queryForObject("SELECT count(*) FROM public.sentinel_legacy_approvals WHERE match_id=?", Integer.class, match), "no approval for a new row");
        // One ranked row per attempt; another learner cannot reuse it.
        assertThrows(Exception.class, () -> sql.update("INSERT INTO public.king_conquest_results(match_id,user_id,board_size,category,flow,score,word_count,territory,throne,finished_at,sentinel_attempt_id) VALUES (gen_random_uuid(),674,5,'SOLO','SOLO',31,1,1,false,now(),?)", v.id()));
        assertThrows(Exception.class, () -> sql.update("INSERT INTO public.king_conquest_results(match_id,user_id,board_size,category,flow,score,word_count,territory,throne,finished_at,sentinel_attempt_id) VALUES (gen_random_uuid(),3,5,'SOLO','SOLO',31,1,1,false,now(),?)", v.id()));
        assertTrue(sql.queryForObject("SELECT count(*) FROM public.sentinel_attempt_events WHERE attempt_id=?", Integer.class, v.id()) >= 2, "audit trail of the decisions");
        assertEquals(357, record().get("score"));
    }
}
