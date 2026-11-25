package com.englishcoach.leaderboard.board;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.leaderboard.activity.ActivityScoringProperties;
import com.englishcoach.leaderboard.activity.rollup.ActivityRankRepository;
import com.englishcoach.leaderboard.activity.rollup.ActivityRollupRepository;
import com.englishcoach.leaderboard.activity.rollup.ActivityRollupService;
import com.englishcoach.proficiency.ProficiencyProperties;
import com.englishcoach.proficiency.ProficiencyStateRepository;
import com.englishcoach.proficiency.board.ProficiencyBoardRepository;
import com.englishcoach.proficiency.board.ProficiencyBoardService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.junit.jupiter.Testcontainers;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3 rollup, ranking views, refresh job and read API against a real PostgreSQL 17 with the
 * real V52/V53/V54 migrations. Clock is explicit (Asia/Ho_Chi_Minh wall times).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringJUnitConfig(LeaderboardBoardIntegrationTest.Config.class)
class LeaderboardBoardIntegrationTest {

    static final ZoneId VN = ZoneId.of("Asia/Ho_Chi_Minh");
    static final String START_AT = "2026-09-01T00:00:00+07:00";
    static final long ADMIN = 599;
    static final long DISABLED = 598;

    @Configuration
    @EnableTransactionManagement(proxyTargetClass = true)
    @Import({ActivityRollupRepository.class, ActivityRollupService.class, ActivityRankRepository.class,
            ProficiencyStateRepository.class, ProficiencyBoardRepository.class, ProficiencyBoardService.class,
            LeaderboardRefreshStateRepository.class, LeaderboardRefreshJob.class, LeaderboardDisplayRepository.class,
            LeaderboardBoardService.class, LeaderboardController.class, LeaderboardOthersRepository.class})
    static class Config {
        @Bean DataSource dataSource() { return BoardTestPostgres.dataSource(); }
        @Bean NamedParameterJdbcTemplate namedParameterJdbcTemplate(DataSource ds) { return new NamedParameterJdbcTemplate(ds); }
        @Bean JdbcTemplate jdbcTemplate(DataSource ds) { return new JdbcTemplate(ds); }
        @Bean PlatformTransactionManager transactionManager(DataSource ds) { return new DataSourceTransactionManager(ds); }
        @Bean ProficiencyProperties proficiencyProperties() { return new ProficiencyProperties(); }
        @Bean LeaderboardRefreshProperties leaderboardRefreshProperties() { return new LeaderboardRefreshProperties(); }
        @Bean LeaderboardProperties leaderboardProperties() { return new LeaderboardProperties(); }
        @Bean ActivityScoringProperties activityScoringProperties() {
            ActivityScoringProperties p = new ActivityScoringProperties();
            p.setStartAt(START_AT);
            return p;
        }
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired LeaderboardRefreshJob job;
    @Autowired LeaderboardBoardService boards;
    @Autowired LeaderboardController controller;
    @Autowired ActivityScoringProperties activityProps;
    @Autowired LeaderboardRefreshProperties refreshProps;
    @Autowired ActivityRollupService rollupService;
    @Autowired ProficiencyBoardService proficiencyBoardService;
    @Autowired LeaderboardRefreshStateRepository stateRepository;
    @Autowired LeaderboardProperties boardProps;

    @BeforeEach
    void reset() throws Exception {
        // test-only reset of a throw-away container (TRUNCATE does not fire the append-only row trigger)
        try (Connection c = BoardTestPostgres.rawConnection(); Statement st = c.createStatement()) {
            st.execute("""
                    TRUNCATE public.proficiency_placement_progress, public.proficiency_placement_attempt, public.proficiency_placement_issue,
                             public.leaderboard_division_promotion,
                             public.score_events, public.leaderboard_activity_daily, public.skill_proficiency,
                             public.user_proficiency, public.user_profiles, public.user_avatar_frames;
                    UPDATE public.users SET role = 'ROLE_USER', account_status = 'ACTIVE';
                    UPDATE public.users SET role = 'ROLE_ADMIN' WHERE id = 599;
                    UPDATE public.users SET account_status = 'DISABLED' WHERE id = 598;
                    UPDATE public.leaderboard_refresh_state SET as_of = NULL, activity_start_at = NULL,
                        last_success_at = NULL, last_attempt_at = NULL, last_error = NULL,
                        last_processed_created_at = NULL;
                    """);
        }
        activityProps.setStartAt(START_AT);
        activityProps.setTimeZone("Asia/Ho_Chi_Minh");
        refreshProps.setWatermarkOverlapMs(300_000L);
        boardProps.setExcludedUserIds(new ArrayList<>());
        // the placement requirement has its own tests (PlacementDivisionIntegrationTest); these cover the rest
        boardProps.setRequirePlacement(false);
        boards.invalidateBoardCache();
    }

    /** Exact NUMERIC comparison (daily points / streak_mult are BigDecimal). */
    private static void assertNum(String expected, Object actual, String message) {
        assertNotNull(actual, message);
        assertEquals(0, new java.math.BigDecimal(expected).compareTo((java.math.BigDecimal) actual),
                message + " (expected " + expected + ", got " + actual + ")");
    }

    // ---- helpers ----------------------------------------------------------------------------------

    static Instant vn(String localDateTime) {
        return LocalDateTime.parse(localDateTime).atZone(VN).toInstant();
    }

    private void ev(long user, String source, String group, int raw, int eligible, Instant at) {
        jdbc.update("""
                INSERT INTO public.score_events (user_id, source_module, source_ref, skill_group, base, cefr_mult,
                    quality_mult, relative_mult, raw_points, eligible_points, occurred_at)
                VALUES (?, ?, ?, ?, 1, 1, 1, 1, ?, ?, ?)
                """, user, source, UUID.randomUUID().toString(), group, raw, eligible, Timestamp.from(at));
    }

    private void dictation(long user, int points, Instant at) {
        ev(user, "DICTATION", "LISTENING", points, points, at);
    }

    private LeaderboardRefreshJob.RefreshResult refresh(Instant now) {
        LeaderboardRefreshJob.RefreshResult r = job.run(now);
        assertEquals(LeaderboardRefreshJob.Outcome.RAN, r.outcome(), r.message());
        return r;
    }

    private Map<String, Object> daily(long user, String day, String source) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT * FROM public.leaderboard_activity_daily WHERE user_id = ? AND day = ? AND source_module = ?",
                user, LocalDate.parse(day), source);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private Integer rank(String period, String scope, String grp, long user) {
        List<Integer> r = jdbc.queryForList("SELECT rank FROM public.mv_activity_rank WHERE period = ? AND scope = ? AND grp = ? AND user_id = ?",
                Integer.class, period, scope, grp, user);
        return r.isEmpty() ? null : r.get(0);
    }

    private List<String> scopesOf(long user) {
        return jdbc.queryForList("SELECT DISTINCT scope FROM public.mv_activity_rank WHERE user_id = ? ORDER BY scope", String.class, user);
    }

    private void overall(long user, String status, Integer rating, String cefr, String peak, double conf, boolean show) {
        jdbc.update("""
                INSERT INTO public.user_proficiency (user_id, overall_rating, current_cefr, overall_confidence, overall_status,
                    peak_rating, peak_cefr, show_on_proficiency_board)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, user, rating, cefr, conf, status, rating, peak, show);
    }

    private void skill(long user, String skill, String status, Integer rating, double conf, Instant reached) {
        jdbc.update("""
                INSERT INTO public.skill_proficiency (user_id, skill, rating, confidence, status, rating_reached_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """, user, skill, rating, conf, status, reached == null ? null : Timestamp.from(reached));
    }

    private static UserDetailsImpl principal(long id) {
        UserDetailsImpl p = Mockito.mock(UserDetailsImpl.class);
        Mockito.when(p.getId()).thenReturn(id);
        return p;
    }

    // ---- rollup -----------------------------------------------------------------------------------

    @Test
    @DisplayName("Rollup: CARD_BLAST_SOLO takes the 3 best runs per day, then caps at 100")
    void cardBlastTop3AndCap() {
        Instant d = vn("2026-10-01T09:00");
        for (int pts : new int[]{50, 40, 30, 20}) {
            ev(1, "CARD_BLAST_SOLO", "VOCAB", pts, pts, d);
        }
        ev(1, "CARD_BLAST_SOLO", "VOCAB", 30, 30, vn("2026-10-02T09:00"));
        ev(1, "CARD_BLAST_SOLO", "VOCAB", 10, 10, vn("2026-10-02T10:00"));
        refresh(vn("2026-10-02T12:00"));

        Map<String, Object> day1 = daily(1, "2026-10-01", "CARD_BLAST_SOLO");
        assertEquals(140, day1.get("raw_sum"));
        assertEquals(100, day1.get("eligible_sum"), "50 + 40 + 30 = 120 → cap 100");
        assertNum("100.500", day1.get("points"), "100 × 1.005, stored exactly (Phase 3.1)");
        Map<String, Object> day2 = daily(1, "2026-10-02", "CARD_BLAST_SOLO");
        assertEquals(40, day2.get("eligible_sum"));
        assertNum("40.400", day2.get("points"), "40 × 1.010");
        assertEquals(141, rank2points("ALL_TIME", 1), "round(100.5 + 40.4) = round(140.9) — rounded once per period");
    }

    private Integer rank2points(String period, long user) {
        List<Integer> r = jdbc.queryForList("SELECT points FROM public.mv_activity_rank WHERE period = ? AND scope = 'GLOBAL' AND grp = 'ALL' AND user_id = ?",
                Integer.class, period, user);
        return r.isEmpty() ? null : r.get(0);
    }

    /** Raw ≥ 1, eligible 0 rows: active streak days with no points (a capped day). */
    private void activeDays(long user, String firstDay, int days) {
        LocalDate d = LocalDate.parse(firstDay);
        for (int i = 0; i < days; i++) {
            ev(user, "DICTATION", "LISTENING", 1, 0, d.plusDays(i).atTime(8, 0).atZone(VN).toInstant());
        }
    }

    @Test
    @DisplayName("Phase 3.1 A1: 36 eligible × streak 1.050 ⇒ 37.800 stored, 38 ranked (no per-row rounding loss)")
    void streakBonusKeptByExactDailyPoints() {
        activeDays(5, "2026-09-21", 9);                                  // 09-21 … 09-29 active
        ev(5, "EXAM_SIMULATION", "EXAMS", 36, 36, vn("2026-09-30T10:00")); // 10th consecutive day
        refresh(vn("2026-09-30T20:00"));

        Map<String, Object> row = daily(5, "2026-09-30", "EXAM_SIMULATION");
        assertEquals((short) 10, ((Number) row.get("streak_days")).shortValue());
        assertNum("1.050", row.get("streak_mult"), "10-day streak");
        assertNum("37.800", row.get("points"), "36 × 1.050 kept exactly");
        assertEquals(38, rank2points("WEEK", 5), "round(37.8) once, in mv_activity_rank");
        assertEquals(38, boards.activityMe(5, BoardParams.Period.WEEK, "GLOBAL", BoardParams.Group.ALL).points());
        assertEquals(List.of(new LeaderboardDtos.SourceBreakdown("EXAM_SIMULATION", 38)),
                boards.activityMe(5, BoardParams.Period.WEEK, "GLOBAL", BoardParams.Group.ALL).breakdown());
    }

    @Test
    @DisplayName("Phase 3.1 A1: ten modules × 3 eligible keep their streak bonus in the period total (32, not 30)")
    void tenSmallModulesKeepBonus() {
        activeDays(6, "2026-09-21", 9);
        String[][] modules = {
                {"FLASHCARD_REVIEW", "VOCAB"}, {"FLASHCARD_NEW", "VOCAB"}, {"FLASHCARD_MASTERED", "VOCAB"},
                {"CARD_BLAST_SOLO", "VOCAB"}, {"CARD_BLAST_PVP", "VOCAB"}, {"DICTATION", "LISTENING"},
                {"SHADOWING", "SPEAKING"}, {"ROLEPLAY", "SPEAKING"}, {"WRITING", "WRITING"}, {"EXAM_PRACTICE", "EXAMS"}};
        for (String[] m : modules) {
            ev(6, m[0], m[1], 3, 3, vn("2026-09-30T10:00"));
        }
        refresh(vn("2026-09-30T20:00"));

        for (String[] m : modules) {
            assertNum("3.150", daily(6, "2026-09-30", m[0]).get("points"), m[0] + ": 3 × 1.050");
        }
        assertEquals(32, rank2points("WEEK", 6), "round(10 × 3.15) = round(31.5) = 32; per-row rounding gave 30");
        LeaderboardDtos.ActivityMeResponse me = boards.activityMe(6, BoardParams.Period.WEEK, "GLOBAL", BoardParams.Group.ALL);
        assertEquals(32, me.points());
        assertEquals(10, me.breakdown().size());
        assertTrue(me.breakdown().stream().allMatch(b -> b.points() == 3), "breakdown rounds each module for display only");
    }

    @Test
    @DisplayName("Phase 3.1 A2: EXAM_SIMULATION inserted now with occurred_at 5 days ago lands in that day; its streak_mult stays frozen")
    void lateEventPastWatermark() {
        dictation(7, 40, vn("2026-10-04T10:00"));
        dictation(7, 40, vn("2026-10-05T10:00"));
        refresh(vn("2026-10-05T20:00"));                        // stores 10-04 ×1.005, 10-05 ×1.010
        dictation(7, 20, vn("2026-10-10T09:00"));
        refresh(vn("2026-10-10T12:00"));                        // catch-up, 10-05 is now final
        Instant watermarkBefore = stateRepository.find().orElseThrow().lastProcessedCreatedAt();
        assertNotNull(watermarkBefore, "watermark advanced by the refresh");
        assertNum("1.010", daily(7, "2026-10-05", "DICTATION").get("streak_mult"), "stored multiplier of 10-05");

        refreshProps.setWatermarkOverlapMs(0); // prove the watermark itself, not the overlap, finds the event
        ev(7, "EXAM_SIMULATION", "EXAMS", 300, 300, vn("2026-10-05T15:00")); // scored late, 5 days back
        dictation(7, 10, vn("2026-10-03T10:00"));                           // late, a day never rolled up
        refresh(vn("2026-10-10T12:10"));

        Map<String, Object> exam = daily(7, "2026-10-05", "EXAM_SIMULATION");
        assertNotNull(exam, "late event rolled up into its own day");
        assertEquals(300, exam.get("eligible_sum"));
        assertNum("1.010", exam.get("streak_mult"), "frozen multiplier of 10-05 kept (fresh would be 1.015)");
        assertNum("303.000", exam.get("points"), "300 × 1.010");
        assertNum("1.010", daily(7, "2026-10-05", "DICTATION").get("streak_mult"), "existing row unchanged");
        Map<String, Object> first = daily(7, "2026-10-03", "DICTATION");
        assertNotNull(first, "day computed for the first time");
        assertNum("1.005", first.get("streak_mult"), "streak as of 10-03 (first active day)");

        // WEEK (Mon 10-05 …) = 40.400 + 303.000 + 20.100 (10-10, streak 1) = 363.5 → 364; 10-03 is in the previous week
        assertEquals(364, rank2points("WEEK", 7));
        // MONTH / ALL_TIME add 10-03 (10.050) and 10-04 (40.200): 413.75 → 414
        assertEquals(414, rank2points("MONTH", 7));
        assertEquals(414, rank2points("ALL_TIME", 7));
        assertEquals(List.of("EXAM_SIMULATION", "DICTATION"),
                boards.activityMe(7, BoardParams.Period.WEEK, "GLOBAL", BoardParams.Group.ALL).breakdown().stream()
                        .map(LeaderboardDtos.SourceBreakdown::sourceModule).toList());

        Instant watermarkAfter = stateRepository.find().orElseThrow().lastProcessedCreatedAt();
        assertTrue(watermarkAfter.isAfter(watermarkBefore), "watermark advanced past the late events");
        assertEquals(jdbc.queryForObject("SELECT MAX(created_at) FROM public.score_events", Timestamp.class).toInstant(),
                watermarkAfter, "watermark = max created_at processed");
    }

    @Test
    @DisplayName("Rollup: streak_mult applied per day and frozen once the day is past; late events reopen only their day")
    void streakFrozenAndWindow() {
        dictation(2, 100, vn("2026-10-03T10:00"));
        dictation(2, 100, vn("2026-10-04T10:00"));
        dictation(2, 100, vn("2026-10-05T10:00"));
        refresh(vn("2026-10-05T20:00"));
        assertEquals(0, new java.math.BigDecimal("1.005").compareTo((java.math.BigDecimal) daily(2, "2026-10-03", "DICTATION").get("streak_mult")));
        assertEquals(0, new java.math.BigDecimal("1.010").compareTo((java.math.BigDecimal) daily(2, "2026-10-04", "DICTATION").get("streak_mult")));
        assertEquals(0, new java.math.BigDecimal("1.015").compareTo((java.math.BigDecimal) daily(2, "2026-10-05", "DICTATION").get("streak_mult")));
        assertNum("101.500", daily(2, "2026-10-05", "DICTATION").get("points"), "100 × 1.015");
        Map<String, Object> d04 = daily(2, "2026-10-04", "DICTATION");

        // late events (Phase 3.1 watermark): one on 10-02 (would extend every streak), one more on 10-03 and one on 10-05
        dictation(2, 100, vn("2026-10-02T10:00"));
        dictation(2, 50, vn("2026-10-03T11:00"));
        dictation(2, 50, vn("2026-10-05T11:00"));
        refresh(vn("2026-10-06T09:00")); // today 10-06, yesterday 10-05

        Map<String, Object> d02 = daily(2, "2026-10-02", "DICTATION");
        assertNotNull(d02, "a late event older than yesterday is rolled up into its day");
        assertNum("1.005", d02.get("streak_mult"), "first computation of 10-02 = streak as of 10-02");
        Map<String, Object> d03 = daily(2, "2026-10-03", "DICTATION");
        assertEquals(150, d03.get("eligible_sum"), "10-03 sums recomputed");
        assertNum("1.005", d03.get("streak_mult"), "10-03 keeps its stored multiplier (fresh would be 1.010)");
        assertNum("150.750", d03.get("points"), "150 × 1.005");
        assertEquals(d04.get("eligible_sum"), daily(2, "2026-10-04", "DICTATION").get("eligible_sum"), "10-04 unchanged");
        assertNum("1.010", daily(2, "2026-10-04", "DICTATION").get("streak_mult"), "10-04 multiplier unchanged");
        Map<String, Object> y = daily(2, "2026-10-05", "DICTATION");
        assertEquals(150, y.get("eligible_sum"), "yesterday recomputed from events");
        assertNum("1.015", y.get("streak_mult"), "yesterday keeps its stored multiplier (a fresh computation would give 1.020)");
        assertNum("152.250", y.get("points"), "150 × 1.015");
    }

    @Test
    @DisplayName("Rollup: events before start-at are excluded; unset start-at ⇒ nothing rolled up")
    void startAtExcluded() {
        dictation(3, 70, vn("2026-08-31T23:59"));
        dictation(3, 30, vn("2026-09-01T00:01"));
        refresh(vn("2026-09-01T08:00"));
        assertNull(daily(3, "2026-08-31", "DICTATION"));
        assertEquals(30, daily(3, "2026-09-01", "DICTATION").get("eligible_sum"));

        activityProps.setStartAt("");
        LeaderboardRefreshJob.RefreshResult r = refresh(vn("2026-09-01T09:00"));
        assertEquals(0, r.dailyRows());
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM public.mv_activity_rank", Integer.class),
                "start-at unset ⇒ empty Activity board");
    }

    // ---- periods ----------------------------------------------------------------------------------

    @Test
    @DisplayName("Periods: Monday 00:00 VN resets WEEK (Sun 23:59 vs Mon 00:01); MONTH and ALL_TIME keep both")
    void weekBoundary() {
        dictation(10, 10, vn("2026-10-04T23:59")); // Sunday
        dictation(11, 5, vn("2026-10-05T00:01"));  // Monday
        refresh(vn("2026-10-05T00:05"));
        assertNull(rank("WEEK", "GLOBAL", "ALL", 10));
        assertEquals(1, rank("WEEK", "GLOBAL", "ALL", 11));
        assertEquals(1, rank("MONTH", "GLOBAL", "ALL", 10));
        assertEquals(2, rank("MONTH", "GLOBAL", "ALL", 11));
        assertEquals(1, rank("ALL_TIME", "GLOBAL", "ALL", 10));

        LeaderboardDtos.ActivityBoardResponse week = boards.activityBoard(BoardParams.Period.WEEK,
                BoardParams.Scope.GLOBAL, BoardParams.Group.ALL, 20);
        assertEquals(vn("2026-10-05T00:00"), week.periodStartsAt());
        assertEquals(vn("2026-10-12T00:00"), week.periodEndsAt());
        assertEquals(List.of(11L), week.items().stream().map(LeaderboardDtos.ActivityItem::userId).toList());
        LeaderboardDtos.ActivityBoardResponse all = boards.activityBoard(BoardParams.Period.ALL_TIME,
                BoardParams.Scope.GLOBAL, BoardParams.Group.ALL, 20);
        assertNull(all.periodEndsAt());
        assertEquals(Instant.parse("2026-08-31T17:00:00Z"), all.periodStartsAt());
    }

    @Test
    @DisplayName("Periods: month boundary resets MONTH; WEEK spans it; ALL_TIME never resets")
    void monthBoundary() {
        dictation(12, 10, vn("2026-10-31T23:59"));
        dictation(13, 5, vn("2026-11-01T00:01"));
        refresh(vn("2026-11-01T00:05"));
        assertNull(rank("MONTH", "GLOBAL", "ALL", 12));
        assertEquals(1, rank("MONTH", "GLOBAL", "ALL", 13));
        assertEquals(1, rank("WEEK", "GLOBAL", "ALL", 12), "week of Mon 10-26 contains both days");
        assertEquals(2, rank("WEEK", "GLOBAL", "ALL", 13));
        assertEquals(1, rank("ALL_TIME", "GLOBAL", "ALL", 12));
        assertEquals(2, rank("ALL_TIME", "GLOBAL", "ALL", 13));
    }

    // ---- ranking ----------------------------------------------------------------------------------

    @Test
    @DisplayName("Ranking: equal points ⇒ earlier reached_at first; identical (points, reached_at) ⇒ lower id first; ranks unique")
    void ties() {
        dictation(20, 50, vn("2026-10-01T10:00"));
        dictation(21, 50, vn("2026-10-01T11:00"));
        dictation(22, 50, vn("2026-10-01T10:00"));
        dictation(23, 10, vn("2026-10-01T09:00"));
        refresh(vn("2026-10-01T12:00"));
        assertEquals(1, rank("WEEK", "GLOBAL", "ALL", 20));
        assertEquals(2, rank("WEEK", "GLOBAL", "ALL", 22), "identical points + reached_at ⇒ user id breaks the tie");
        assertEquals(3, rank("WEEK", "GLOBAL", "ALL", 21));
        assertEquals(4, rank("WEEK", "GLOBAL", "ALL", 23));
        assertEquals(1, rank("WEEK", "GLOBAL", "LISTENING", 20));
        assertNull(rank("WEEK", "GLOBAL", "VOCAB", 20), "no VOCAB points ⇒ no VOCAB row");

        LeaderboardDtos.ActivityMeResponse me = boards.activityMe(21, BoardParams.Period.WEEK, "GLOBAL", BoardParams.Group.ALL);
        assertEquals(3, me.rank());
        assertEquals(1, me.pointsToNextRank(), "50 − 50 + 1");
        assertEquals(2, me.nextRank(), "unique ranks: the nearest row above is rank − 1");
        assertEquals(3, boards.activityMe(23, BoardParams.Period.WEEK, "GLOBAL", BoardParams.Group.ALL).nextRank());
        assertEquals(List.of(new LeaderboardDtos.SourceBreakdown("DICTATION", 50)), me.breakdown());
        assertNull(boards.activityMe(20, BoardParams.Period.WEEK, "GLOBAL", BoardParams.Group.ALL).pointsToNextRank());
    }

    @Test
    @DisplayName("Ranking: no level ⇒ GLOBAL only; division = max(current, peak − 1 step); admins / disabled excluded")
    void scopesAndExclusions() {
        for (long u : new long[]{30, 31, 32, 33, ADMIN, DISABLED}) {
            dictation(u, 40, vn("2026-10-01T10:00"));
        }
        overall(30, "UNDETERMINED", null, null, null, 0, true);
        overall(31, "VERIFIED", 600, "B2", "C2", 0.8, true);      // max(B2, C1) = C1 ⇒ CAO_CAP
        overall(32, "PROVISIONAL", 300, "A2", "B1", 0.4, true);   // max(A2, A2) ⇒ SO_CAP
        overall(33, "STALE", 400, "B1", null, 0.7, true);         // ⇒ TRUNG_CAP
        refresh(vn("2026-10-01T12:00"));

        assertEquals(List.of("GLOBAL"), scopesOf(30));
        assertEquals(List.of("CAO_CAP", "GLOBAL"), scopesOf(31));
        assertEquals(List.of("GLOBAL", "SO_CAP"), scopesOf(32));
        assertEquals(List.of("GLOBAL", "TRUNG_CAP"), scopesOf(33));
        assertTrue(scopesOf(ADMIN).isEmpty(), "admin excluded");
        assertTrue(scopesOf(DISABLED).isEmpty(), "disabled account excluded");

        LeaderboardDtos.ActivityMeResponse me31 = boards.activityMe(31, BoardParams.Period.WEEK, null, BoardParams.Group.ALL);
        assertEquals("GLOBAL", me31.defaultScope(), "Bảng chung is the default for everyone (Stage 2.3)");
        assertEquals("GLOBAL", me31.scope());
        assertEquals("CAO_CAP", me31.division());
        assertEquals("C1", me31.divisionCefr(), "floor max(B2, C2 − 1) = C1");
        assertEquals("VERIFIED", me31.divisionSource());
        LeaderboardDtos.ActivityMeResponse me30 = boards.activityMe(30, BoardParams.Period.WEEK, null, BoardParams.Group.ALL);
        assertEquals("GLOBAL", me30.defaultScope());
        assertNull(me30.division(), "no level ⇒ never put into a division / never defaulted to A1");
        assertNull(me30.divisionCefr());
        LeaderboardDtos.ActivityMeResponse admin = boards.activityMe(ADMIN, BoardParams.Period.WEEK, "GLOBAL", BoardParams.Group.ALL);
        assertNull(admin.rank());
        assertEquals(40, admin.points(), "points still visible to the admin from the daily rollup");
    }

    @Test
    @DisplayName("Activity API: display name + avatar + equipped frame, never email")
    void displayData() throws Exception {
        dictation(40, 40, vn("2026-10-01T10:00"));
        dictation(41, 30, vn("2026-10-01T10:00"));
        jdbc.update("INSERT INTO public.user_profiles (user_id, display_name, avatar_storage_key, avatar_updated_at) VALUES (40, 'Lan', 'avatars/40/a.png', ?)",
                Timestamp.from(Instant.parse("2026-09-30T00:00:00Z")));
        jdbc.update("UPDATE public.users SET name = 'x41@example.test' WHERE id = 41");
        jdbc.update("INSERT INTO public.user_avatar_frames (user_id, frame_id, is_equipped) VALUES (40, 1, TRUE)");
        refresh(vn("2026-10-01T12:00"));
        LeaderboardDtos.ActivityBoardResponse r = boards.activityBoard(BoardParams.Period.WEEK, BoardParams.Scope.GLOBAL,
                BoardParams.Group.ALL, 20);
        LeaderboardDtos.ActivityItem lan = r.items().get(0);
        assertEquals("Lan", lan.displayName());
        assertEquals("/api/v1/users/40/avatar?v=" + Instant.parse("2026-09-30T00:00:00Z").toEpochMilli(), lan.avatarUrl());
        assertEquals("jade-dragon", lan.avatarFrame().slug());
        LeaderboardDtos.ActivityItem other = r.items().get(1);
        assertEquals("Học viên #41", other.displayName(), "an e-mail-like name is never shown; a distinct fallback instead");
        assertNull(other.avatarUrl());
        assertNull(other.avatarFrame());
        assertFalse(new com.fasterxml.jackson.databind.ObjectMapper().findAndRegisterModules().writeValueAsString(r).contains("@"));
    }

    // ---- proficiency board ------------------------------------------------------------------------

    @Test
    @DisplayName("Proficiency board: only VERIFIED; STALE/PROVISIONAL out; hidden absent from list but /me gives would-be rank")
    void proficiencyBoard() {
        overall(50, "VERIFIED", 640, "B2", "B2", 0.85, true);
        overall(51, "STALE", 650, "B2", "B2", 0.70, true);
        overall(52, "PROVISIONAL", 660, "B2", null, 0.50, true);
        overall(53, "VERIFIED", 700, "C1", "C1", 0.90, true);   // other division
        overall(54, "VERIFIED", 660, "B2", "B2", 0.65, false);  // hidden, would be #1 in TRUNG_CAP
        overall(55, "VERIFIED", 640, "B2", "B2", 0.70, true);   // same rating as 50, lower confidence
        overall(ADMIN, "VERIFIED", 650, "B2", "B2", 0.9, true);
        skill(50, "LISTENING", "VERIFIED", 620, 0.8, vn("2026-09-20T10:00"));
        skill(50, "READING", "PROVISIONAL", 500, 0.5, vn("2026-09-21T10:00"));
        skill(55, "LISTENING", "VERIFIED", 620, 0.8, vn("2026-09-25T10:00"));
        skill(51, "LISTENING", "STALE", 700, 0.8, vn("2026-01-01T10:00"));
        refresh(vn("2026-10-01T12:00"));

        LeaderboardDtos.ProficiencyBoardResponse b = boards.proficiencyBoard(50,
                com.englishcoach.proficiency.board.ProficiencyBoardType.OVERALL, "TRUNG_CAP", 20);
        assertEquals(List.of(50L, 55L), b.items().stream().map(LeaderboardDtos.ProficiencyItem::userId).toList(),
                "STALE / PROVISIONAL / hidden / admin / other division absent; tie on rating ⇒ confidence");
        assertEquals(List.of(1, 2), b.items().stream().map(LeaderboardDtos.ProficiencyItem::rank).toList());
        LeaderboardDtos.ProficiencyItem top = b.items().get(0);
        assertEquals("Độ tin cậy cao", top.confidenceLabel());
        assertEquals(new LeaderboardDtos.SkillCellDto("B2", "VERIFIED"), top.skills().get("L"));
        assertEquals(new LeaderboardDtos.SkillCellDto("B2", "PROVISIONAL"), top.skills().get("R"));
        assertEquals(new LeaderboardDtos.SkillCellDto(null, "UNDETERMINED"), top.skills().get("W"));

        LeaderboardDtos.ProficiencyMeResponse hidden = boards.proficiencyMe(54, com.englishcoach.proficiency.board.ProficiencyBoardType.OVERALL);
        assertTrue(hidden.hidden());
        assertTrue(hidden.eligible());
        assertEquals(1, hidden.rank(), "would be #1 ahead of 50 (660 > 640)");
        LeaderboardDtos.ProficiencyMeResponse stale = boards.proficiencyMe(51, com.englishcoach.proficiency.board.ProficiencyBoardType.OVERALL);
        assertFalse(stale.eligible());
        assertEquals("STALE", stale.ineligibleReason());
        assertNull(stale.rank());
        assertEquals("PROVISIONAL", boards.proficiencyMe(52, com.englishcoach.proficiency.board.ProficiencyBoardType.OVERALL).ineligibleReason());
        assertEquals("UNDETERMINED", boards.proficiencyMe(56, com.englishcoach.proficiency.board.ProficiencyBoardType.OVERALL).ineligibleReason());
        assertEquals("EXCLUDED", boards.proficiencyMe(ADMIN, com.englishcoach.proficiency.board.ProficiencyBoardType.OVERALL).ineligibleReason());

        // skill board: division from the skill's own CEFR; tie (620, 0.8) ⇒ earlier rating_reached_at first
        LeaderboardDtos.ProficiencyBoardResponse l = boards.proficiencyBoard(50,
                com.englishcoach.proficiency.board.ProficiencyBoardType.LISTENING, null, 20);
        assertEquals("TRUNG_CAP", l.division(), "default = caller's own division");
        assertEquals(List.of(50L, 55L), l.items().stream().map(LeaderboardDtos.ProficiencyItem::userId).toList());
        assertEquals(List.of(1, 2), l.items().stream().map(LeaderboardDtos.ProficiencyItem::rank).toList());
    }

    @Test
    @DisplayName("API: VOCABULARY board ⇒ 400; unknown period ⇒ 400; limit capped at 50; no principal ⇒ 401")
    void apiValidation() {
        UserDetailsImpl me = principal(60);
        ResponseStatusException vocab = assertThrows(ResponseStatusException.class,
                () -> controller.proficiency(me, "VOCABULARY", null, null));
        assertEquals(HttpStatus.BAD_REQUEST, vocab.getStatusCode());
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> controller.proficiencyMe(me, "VOCABULARY")).getStatusCode());
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> controller.activity(me, "YEAR", null, null, null)).getStatusCode());
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> controller.activity(me, null, null, null, 0)).getStatusCode());
        assertEquals(50, BoardParams.limit(500));
        assertEquals(HttpStatus.UNAUTHORIZED, assertThrows(ResponseStatusException.class,
                () -> controller.activityMe(null, null, null, null)).getStatusCode());
    }

    @Test
    @DisplayName("API read path: the four endpoints never touch score_events or proficiency_evidence")
    void readPathUsesViewsOnly() {
        dictation(70, 40, vn("2026-10-01T10:00"));
        overall(70, "VERIFIED", 640, "B2", "B2", 0.85, true);
        refresh(vn("2026-10-01T12:00"));
        UserDetailsImpl me = principal(70);
        BoardTestPostgres.SQL_LOG.clear();
        controller.activity(me, "WEEK", "GLOBAL", "ALL", 20);
        controller.activityMe(me, "MONTH", null, "LISTENING");
        controller.proficiency(me, "OVERALL", "TRUNG_CAP", 20);
        controller.proficiencyMe(me, "LISTENING");
        List<String> sql = new ArrayList<>(BoardTestPostgres.SQL_LOG);
        assertFalse(sql.isEmpty());
        for (String s : sql) {
            assertFalse(s.contains("score_events"), "score_events read by the API: " + s);
            assertFalse(s.contains("proficiency_evidence"), "proficiency_evidence read by the API: " + s);
        }
        assertTrue(sql.stream().anyMatch(s -> s.contains("mv_activity_rank")));
        assertTrue(sql.stream().anyMatch(s -> s.contains("mv_proficiency_rank")));
    }

    // ---- refresh ----------------------------------------------------------------------------------

    @Test
    @DisplayName("Refresh: concurrent triggers ⇒ one run (in-JVM flag and cross-instance advisory lock)")
    void singleFlight() throws Exception {
        dictation(80, 40, vn("2026-10-01T10:00"));
        try (Connection holder = BoardTestPostgres.rawConnection(); Statement st = holder.createStatement()) {
            holder.setAutoCommit(false);
            st.executeQuery("SELECT 1 FROM public.leaderboard_refresh_state WHERE name = 'LEADERBOARD' FOR UPDATE");
            // run A takes the advisory lock, then blocks on the state row held above
            CompletableFuture<LeaderboardRefreshJob.RefreshResult> a =
                    CompletableFuture.supplyAsync(() -> job.run(vn("2026-10-01T12:00")));
            waitForAdvisoryLock();
            LeaderboardRefreshJob.RefreshResult b = job.run(vn("2026-10-01T12:00"));
            assertEquals(LeaderboardRefreshJob.Outcome.SKIPPED, b.outcome());
            LeaderboardRefreshJob otherInstance = new LeaderboardRefreshJob(refreshProps, boardProps, activityProps, rollupService,
                    proficiencyBoardService, stateRepository, new DataSourceTransactionManager(BoardTestPostgres.dataSource()));
            LeaderboardRefreshJob.RefreshResult c = otherInstance.run(vn("2026-10-01T12:00"));
            assertEquals(LeaderboardRefreshJob.Outcome.SKIPPED, c.outcome());
            assertEquals("refresh lock held by another run", c.message());
            holder.rollback();
            assertEquals(LeaderboardRefreshJob.Outcome.RAN, a.get(30, TimeUnit.SECONDS).outcome());
        }
        assertEquals(1, rank("WEEK", "GLOBAL", "ALL", 80));
    }

    private void waitForAdvisoryLock() throws Exception {
        for (int i = 0; i < 200; i++) {
            try (Connection c = BoardTestPostgres.rawConnection(); Statement st = c.createStatement();
                 var rs = st.executeQuery("SELECT COUNT(*) FROM pg_locks WHERE locktype = 'advisory' AND granted")) {
                rs.next();
                if (rs.getInt(1) > 0) return;
            }
            Thread.sleep(50);
        }
        fail("refresh never took the advisory lock");
    }

    @Test
    @DisplayName("Refresh: query count per refresh is the same for 10 and 100 learners")
    void constantQueryCount() {
        refresh(vn("2026-10-01T08:00")); // first run (catch-up window) out of the way
        for (long u = 100; u < 110; u++) {
            dictation(u, 20, vn("2026-10-01T09:00"));
        }
        BoardTestPostgres.SQL_LOG.clear();
        refresh(vn("2026-10-01T10:00"));
        int ten = BoardTestPostgres.SQL_LOG.size();
        for (long u = 110; u < 200; u++) {
            dictation(u, 20, vn("2026-10-01T10:30"));
            overall(u, "PROVISIONAL", 400, "B1", "B1", 0.5, true);
        }
        BoardTestPostgres.SQL_LOG.clear();
        refresh(vn("2026-10-01T11:00"));
        int hundred = BoardTestPostgres.SQL_LOG.size();
        assertEquals(ten, hundred, "statements per refresh must not grow with learners");
        assertEquals(100, jdbc.queryForObject(
                "SELECT COUNT(*) FROM public.mv_activity_rank WHERE period = 'WEEK' AND scope = 'GLOBAL' AND grp = 'ALL'", Integer.class));
        assertEquals(90, jdbc.queryForObject(
                "SELECT COUNT(*) FROM public.mv_activity_rank WHERE period = 'WEEK' AND scope = 'TRUNG_CAP' AND grp = 'ALL'", Integer.class));
    }

    @Test
    @DisplayName("Refresh: a failed run rolls back, keeps serving the previous view data and records the error")
    void failureKeepsPreviousData() {
        dictation(90, 40, vn("2026-10-01T10:00"));
        refresh(vn("2026-10-01T12:00"));
        Instant firstSuccess = stateRepository.find().orElseThrow().lastSuccessAt();
        dictation(91, 80, vn("2026-10-01T12:30"));
        activityProps.setTimeZone("Mars/Olympus_Mons");
        LeaderboardRefreshJob.RefreshResult r = job.run(vn("2026-10-01T13:00"));
        assertEquals(LeaderboardRefreshJob.Outcome.FAILED, r.outcome());
        assertEquals(1, rank("WEEK", "GLOBAL", "ALL", 90), "previous data still served");
        assertNull(rank("WEEK", "GLOBAL", "ALL", 91));
        LeaderboardRefreshStateRepository.State st = stateRepository.find().orElseThrow();
        assertEquals(firstSuccess, st.lastSuccessAt());
        assertNotNull(st.lastError());
        assertEquals(firstSuccess, boards.activityBoard(BoardParams.Period.WEEK, BoardParams.Scope.GLOBAL,
                BoardParams.Group.ALL, 20).updatedAt());
    }

    // ---- prod pipeline Stage 2 ------------------------------------------------------------------

    @Test
    @DisplayName("Stage 2.5: unranked list = ACTIVE non-admin non-excluded learners not in the partition, 30/page cursor, division by level")
    void unrankedPaginationAndExclusions() {
        dictation(201, 40, vn("2026-10-01T10:00"));
        dictation(202, 30, vn("2026-10-01T10:00"));
        overall(203, "PROVISIONAL", 400, "B1", null, 0.5, true);   // TRUNG_CAP, no points
        overall(204, "VERIFIED", 700, "C1", "C1", 0.9, true);      // CAO_CAP, no points
        boardProps.setExcludedUserIds(new ArrayList<>(List.of(205L)));
        refresh(vn("2026-10-01T12:00"));

        // GLOBAL: 600 seeded users − 2 ranked − admin − disabled − excluded = 595, paged by 30
        java.util.List<Long> all = new ArrayList<>();
        Long cursor = null;
        int pages = 0;
        do {
            LeaderboardDtos.UnrankedResponse page = boards.activityUnranked(BoardParams.Period.WEEK, BoardParams.Scope.GLOBAL,
                    BoardParams.Group.ALL, cursor, 30);
            assertTrue(page.items().size() <= 30);
            page.items().forEach(i -> all.add(i.userId()));
            cursor = page.nextCursor();
            pages++;
        } while (cursor != null && pages < 50);
        assertEquals(595, all.size());
        assertEquals(20, pages, "595 / 30 ⇒ 20 pages");
        assertEquals(all, all.stream().sorted().toList(), "ordered by id, no duplicates across pages");
        for (long excluded : new long[]{201, 202, ADMIN, DISABLED, 205}) {
            assertFalse(all.contains(excluded), "must not list " + excluded);
        }
        assertTrue(all.contains(203L) && all.contains(204L));

        LeaderboardDtos.UnrankedResponse trung = boards.activityUnranked(BoardParams.Period.WEEK, BoardParams.Scope.TRUNG_CAP,
                BoardParams.Group.ALL, null, 30);
        assertEquals(List.of(203L), trung.items().stream().map(LeaderboardDtos.UnrankedItem::userId).toList(),
                "division scope lists only learners whose division level is that division");
        assertNull(trung.nextCursor());
        assertFalse(new com.fasterxml.jackson.databind.ObjectMapper().findAndRegisterModules().valueToTree(trung).toString().contains("@"));
    }

    @Test
    @DisplayName("Stage 2: app.leaderboard.excluded-user-ids removes learners from both boards in one batch filter; participants count")
    void exclusionListBothBoards() {
        dictation(211, 40, vn("2026-10-01T10:00"));
        dictation(212, 30, vn("2026-10-01T10:00"));
        overall(211, "VERIFIED", 640, "B2", "B2", 0.85, true);
        overall(212, "VERIFIED", 600, "B2", "B2", 0.85, true);
        refresh(vn("2026-10-01T12:00"));
        assertEquals(2, boards.activityBoard(BoardParams.Period.WEEK, BoardParams.Scope.GLOBAL, BoardParams.Group.ALL, 20).participants());

        boardProps.setExcludedUserIds(new ArrayList<>(List.of(211L)));
        refresh(vn("2026-10-01T12:10"));
        LeaderboardDtos.ActivityBoardResponse a = boards.activityBoard(BoardParams.Period.WEEK, BoardParams.Scope.GLOBAL, BoardParams.Group.ALL, 20);
        assertEquals(List.of(212L), a.items().stream().map(LeaderboardDtos.ActivityItem::userId).toList());
        assertEquals(1, a.participants());
        assertEquals(1, a.items().get(0).rank());
        LeaderboardDtos.ProficiencyBoardResponse p = boards.proficiencyBoard(212,
                com.englishcoach.proficiency.board.ProficiencyBoardType.OVERALL, "TRUNG_CAP", 20);
        assertEquals(List.of(212L), p.items().stream().map(LeaderboardDtos.ProficiencyItem::userId).toList());
        assertEquals("EXCLUDED", boards.proficiencyMe(211, com.englishcoach.proficiency.board.ProficiencyBoardType.OVERALL).ineligibleReason());
        assertNull(boards.activityMe(211, BoardParams.Period.WEEK, "GLOBAL", BoardParams.Group.ALL).rank());
        assertEquals("{211}", jdbc.queryForObject("SELECT excluded_user_ids::text FROM public.leaderboard_refresh_state", String.class));
    }
}
