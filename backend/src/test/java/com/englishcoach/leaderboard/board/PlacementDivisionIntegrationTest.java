package com.englishcoach.leaderboard.board;

import com.englishcoach.leaderboard.activity.ActivityScoringProperties;
import com.englishcoach.leaderboard.activity.rollup.ActivityRankRepository;
import com.englishcoach.leaderboard.activity.rollup.ActivityRollupRepository;
import com.englishcoach.leaderboard.activity.rollup.ActivityRollupService;
import com.englishcoach.proficiency.ProficiencyProperties;
import com.englishcoach.proficiency.ProficiencyStateRepository;
import com.englishcoach.proficiency.board.ProficiencyBoardRepository;
import com.englishcoach.proficiency.board.ProficiencyBoardService;
import com.englishcoach.proficiency.board.ProficiencyBoardType;
import com.englishcoach.proficiency.placement.PlacementQuizProperties;
import com.englishcoach.proficiency.placement.PlacementRepository;
import com.englishcoach.proficiency.placement.PlacementService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
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
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Placement quiz model 2 (V66: vocabulary + grammar multiple choice, server-side items + scoring, append-only),
 * division level precedence (V63 view), anti-sandbagging promotion, the Năng lực "others" groups and the Thi đua
 * eligibility rules (placement required, admin / excluded never ranked, unique ranks) — real PostgreSQL 17 with V52–V66.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringJUnitConfig(PlacementDivisionIntegrationTest.Config.class)
class PlacementDivisionIntegrationTest {

    static final ZoneId VN = ZoneId.of("Asia/Ho_Chi_Minh");

    @Configuration
    @EnableTransactionManagement(proxyTargetClass = true)
    @Import({ActivityRollupRepository.class, ActivityRollupService.class, ActivityRankRepository.class,
            ProficiencyStateRepository.class, ProficiencyBoardRepository.class, ProficiencyBoardService.class,
            LeaderboardRefreshStateRepository.class, LeaderboardRefreshJob.class, LeaderboardDisplayRepository.class,
            LeaderboardBoardService.class, LeaderboardOthersRepository.class, PlacementRepository.class, PlacementService.class})
    static class Config {
        @Bean DataSource dataSource() { return BoardTestPostgres.dataSource(); }
        @Bean NamedParameterJdbcTemplate namedParameterJdbcTemplate(DataSource ds) { return new NamedParameterJdbcTemplate(ds); }
        @Bean JdbcTemplate jdbcTemplate(DataSource ds) { return new JdbcTemplate(ds); }
        @Bean PlatformTransactionManager transactionManager(DataSource ds) { return new DataSourceTransactionManager(ds); }
        @Bean ProficiencyProperties proficiencyProperties() { return new ProficiencyProperties(); }
        @Bean LeaderboardRefreshProperties leaderboardRefreshProperties() { return new LeaderboardRefreshProperties(); }
        @Bean LeaderboardProperties leaderboardProperties() { return new LeaderboardProperties(); }
        @Bean PlacementQuizProperties placementQuizProperties() { return new PlacementQuizProperties(); }
        @Bean ActivityScoringProperties activityScoringProperties() {
            ActivityScoringProperties p = new ActivityScoringProperties();
            p.setStartAt("2026-09-01T00:00:00+07:00");
            return p;
        }
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired PlacementService placement;
    @Autowired LeaderboardRefreshJob job;
    @Autowired LeaderboardBoardService boards;
    @Autowired LeaderboardProperties boardProps;

    @BeforeEach
    void reset() throws Exception {
        try (Connection c = BoardTestPostgres.rawConnection(); Statement st = c.createStatement()) {
            st.execute("""
                    TRUNCATE public.proficiency_placement_progress, public.proficiency_placement_attempt, public.proficiency_placement_issue,
                             public.leaderboard_division_promotion, public.score_events, public.leaderboard_activity_daily,
                             public.skill_proficiency, public.user_proficiency, public.user_profiles, public.user_avatar_frames;
                    UPDATE public.users SET role = 'ROLE_USER', account_status = 'ACTIVE';
                    UPDATE public.users SET role = 'ROLE_ADMIN' WHERE id = 599;
                    UPDATE public.users SET account_status = 'DISABLED' WHERE id = 598;
                    UPDATE public.leaderboard_refresh_state SET as_of = NULL, activity_start_at = NULL, last_success_at = NULL,
                        last_attempt_at = NULL, last_error = NULL, last_processed_created_at = NULL;
                    """);
        }
        boardProps.setExcludedUserIds(new ArrayList<>());
        boardProps.setRequirePlacement(true);
        boards.invalidateBoardCache();
    }

    private static Instant vn(String t) {
        return LocalDateTime.parse(t).atZone(VN).toInstant();
    }

    private List<Map<String, Object>> issuedItems(UUID id) {
        return jdbc.queryForList("""
                SELECT (e->>'index')::int AS idx, e->>'skill' AS skill, e->>'cefr' AS cefr, (e->>'answer')::int AS answer,
                       e->>'prompt' AS prompt
                FROM public.proficiency_placement_issue i, jsonb_array_elements(i.items) e WHERE i.id = ? ORDER BY 1
                """, id);
    }

    static final List<String> LEVELS = List.of("A1", "A2", "B1", "B2", "C1");

    /** Correct option for every question up to {@code upTo} (inclusive), "Tôi chưa biết" (null) above. */
    private List<Integer> knowUpTo(UUID id, String upTo) {
        int limit = LEVELS.indexOf(upTo);
        List<Integer> a = new ArrayList<>();
        for (Map<String, Object> it : issuedItems(id)) {
            a.add(LEVELS.indexOf((String) it.get("cefr")) <= limit ? (Integer) it.get("answer") : null);
        }
        return a;
    }

    /** Hard levels right, easy levels wrong (random / careless pattern). */
    private List<Integer> reversed(UUID id) {
        List<Integer> a = new ArrayList<>();
        for (Map<String, Object> it : issuedItems(id)) {
            int answer = (Integer) it.get("answer");
            a.add(LEVELS.indexOf((String) it.get("cefr")) >= 3 ? answer : (answer + 1) % 4);
        }
        return a;
    }

    private void overall(long user, String status, Integer rating, String cefr, String peak, boolean show) {
        jdbc.update("""
                INSERT INTO public.user_proficiency (user_id, overall_rating, current_cefr, overall_confidence, overall_status,
                    peak_rating, peak_cefr, show_on_proficiency_board) VALUES (?, ?, ?, 0.7, ?, ?, ?, ?)
                """, user, rating, cefr, status, rating, peak, show);
    }

    private void ev(long user, String source, String group, int points, String cefr, Instant at) {
        jdbc.update("""
                INSERT INTO public.score_events (user_id, source_module, source_ref, skill_group, base, cefr_level, cefr_mult,
                    quality_mult, relative_mult, raw_points, eligible_points, occurred_at)
                VALUES (?, ?, ?, ?, 1, ?, 1, 1, 1, ?, ?, ?)
                """, user, source, UUID.randomUUID().toString(), group, cefr, points, points, Timestamp.from(at));
    }

    private Map<String, Object> level(long user) {
        List<Map<String, Object>> r = jdbc.queryForList("SELECT cefr, source, division FROM public.leaderboard_division_level WHERE user_id = ?", user);
        return r.isEmpty() ? null : r.get(0);
    }

    private void takePlacement(long user, String upTo, Instant at) {
        PlacementService.StartResponse s = placement.start(user, at);
        placement.submit(user, s.attemptId(), knowUpTo(s.attemptId(), upTo), at.plusSeconds(120));
    }

    // ---------------------------------------------------------------------------------------------

    @Test
    @DisplayName("Model 2 quick issue: 30 of the 80-question bank = 3 vocabulary + 3 grammar per level, 4 options each; no pseudoword; client sees no key / level")
    void issueShapeAndPool() {
        assertEquals(80, jdbc.queryForObject("SELECT COUNT(*) FROM public.proficiency_placement_question WHERE active", Integer.class));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM public.proficiency_placement_item WHERE active", Integer.class),
                "V63 pool (pseudowords + dictionary words) retired");
        PlacementService.StartResponse s = placement.start(301, Instant.now());
        assertEquals(30, s.items().size());
        assertEquals(List.of("index", "skill", "prompt", "options"), List.of(PlacementService.IssuedItem.class.getRecordComponents()).stream()
                .map(java.lang.reflect.RecordComponent::getName).toList(), "client sees no level and no answer key");
        for (PlacementService.IssuedItem it : s.items()) {
            assertEquals(4, it.options().size());
            assertEquals(4, it.options().stream().distinct().count(), "distinct options");
            assertTrue(it.prompt().contains("___"));
        }
        List<Map<String, Object>> stored = issuedItems(s.attemptId());
        for (String l : LEVELS) {
            assertEquals(3, stored.stream().filter(m -> l.equals(m.get("cefr")) && "VOCABULARY".equals(m.get("skill"))).count(), l);
            assertEquals(3, stored.stream().filter(m -> l.equals(m.get("cefr")) && "GRAMMAR".equals(m.get("skill"))).count(), l);
        }
        assertEquals(30, stored.stream().map(m -> m.get("prompt")).distinct().count(), "no duplicate question in one issue");
        assertTrue(stored.stream().allMatch(m -> (Integer) m.get("answer") >= 0 && (Integer) m.get("answer") <= 3));
        assertEquals(2, jdbc.queryForObject("SELECT model_version FROM public.proficiency_placement_issue WHERE id = ?",
                Integer.class, s.attemptId()));
    }

    @Test
    @DisplayName("Simulated learners A1 / A2 / B1 / B2 / C1 through the real service + item bank classify correctly")
    void levelsThroughService() {
        Instant t = vn("2026-10-01T09:00");
        long user = 341;
        for (String level : LEVELS) {
            PlacementService.StartResponse s = placement.start(user, t);
            PlacementService.SubmitResponse r = placement.submit(user, s.attemptId(), knowUpTo(s.attemptId(), level), t.plusSeconds(60));
            assertEquals("VALID", r.status());
            assertEquals(level, r.resultCefr(), "learner who knows up to " + level);
            assertEquals(15, r.vocabulary().total());
            assertEquals(15, r.grammar().total());
            assertEquals(r.vocabulary().correct(), r.grammar().correct(), "both skills measured evenly");
            user++;
        }
    }

    @Test
    @DisplayName("Client cannot send scores or choose items: wrong length / bad index 400, other user's attempt 404, double submit idempotent (same result, one row), expired 410")
    void submitValidation() {
        Instant now = Instant.now();
        PlacementService.StartResponse s = placement.start(302, now);
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> placement.submit(302, s.attemptId(), List.of(1, 2), now)).getStatusCode());
        List<Integer> outOfRange = new ArrayList<>(knowUpTo(s.attemptId(), "B1"));
        outOfRange.set(0, 9);
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> placement.submit(302, s.attemptId(), outOfRange, now)).getStatusCode());
        assertEquals(HttpStatus.NOT_FOUND, assertThrows(ResponseStatusException.class,
                () -> placement.submit(303, s.attemptId(), knowUpTo(s.attemptId(), "B1"), now)).getStatusCode());
        PlacementService.SubmitResponse r = placement.submit(302, s.attemptId(), knowUpTo(s.attemptId(), "B1"), now);
        assertEquals("VALID", r.status());
        assertEquals("B1", r.resultCefr());
        PlacementService.SubmitResponse again = placement.submit(302, s.attemptId(), knowUpTo(s.attemptId(), "A1"), now);
        assertEquals(List.of(r.status(), r.resultCefr(), r.vocabulary(), r.grammar()),
                List.of(again.status(), again.resultCefr(), again.vocabulary(), again.grammar()),
                "a resubmit (lost response / retry) returns the stored result, never a second one");
        assertNotNull(again.retakeAvailableAt());
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM public.proficiency_placement_attempt WHERE user_id = 302", Integer.class));
        PlacementService.StartResponse late = placement.start(304, now);
        assertEquals(HttpStatus.GONE, assertThrows(ResponseStatusException.class,
                () -> placement.submit(304, late.attemptId(), knowUpTo(late.attemptId(), "A2"), now.plus(Duration.ofHours(25)))).getStatusCode());
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.proficiency_placement_attempt SET status = 'INVALID'"),
                "attempts are append-only (trigger)");
    }

    @Test
    @DisplayName("30-day retake lock after VALID; INVALID (reversed pattern) can be retaken at once; placement never touches ratings or evidence")
    void retakeAndNoRatingChange() {
        Instant t0 = vn("2026-10-01T10:00");
        PlacementService.StartResponse bad = placement.start(305, t0);
        PlacementService.SubmitResponse invalid = placement.submit(305, bad.attemptId(), reversed(bad.attemptId()), t0);
        assertEquals("INVALID", invalid.status());
        assertNull(level(305), "INVALID gives no level");
        takePlacement(305, "A2", t0.plusSeconds(300));
        assertEquals("A2", level(305).get("cefr"));
        assertEquals(HttpStatus.CONFLICT, assertThrows(ResponseStatusException.class,
                () -> placement.start(305, t0.plus(Duration.ofDays(29)))).getStatusCode());
        PlacementService.MeResponse me = placement.me(305, t0.plus(Duration.ofDays(29)));
        assertFalse(me.canRetake());
        assertFalse(me.outdated());
        assertEquals(30, me.itemCount());
        assertTrue(placement.me(305, t0.plus(Duration.ofDays(31))).canRetake());
        assertNotNull(placement.start(305, t0.plus(Duration.ofDays(31))).attemptId());
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM public.proficiency_evidence", Integer.class));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM public.skill_proficiency", Integer.class));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM public.user_proficiency", Integer.class));
    }

    @Test
    @DisplayName("Model-1 (yes/no word list) result: still a completed placement, marked outdated, retake open at once")
    void modelOneResultOutdated() {
        Instant t0 = vn("2026-10-02T09:00");
        UUID issue = UUID.randomUUID();
        jdbc.update("INSERT INTO public.proficiency_placement_issue (id, user_id, items, created_at, expires_at) VALUES (?, 306, '[]', ?, ?)",
                issue, Timestamp.from(t0), Timestamp.from(t0.plusSeconds(1800)));
        jdbc.update("""
                INSERT INTO public.proficiency_placement_attempt (issue_id, user_id, items, answers, fa, level_rates, result_cefr, status, created_at)
                VALUES (?, 306, '[]', '[]', 0, '{}', 'B1', 'VALID', ?)
                """, issue, Timestamp.from(t0));
        PlacementService.MeResponse me = placement.me(306, t0.plus(Duration.ofDays(1)));
        assertTrue(me.outdated());
        assertTrue(me.canRetake(), "the 30-day lock applies to model-2 results only");
        assertEquals("B1", me.resultCefr());
        takePlacement(306, "C1", t0.plus(Duration.ofDays(1)));
        assertEquals("C1", level(306).get("cefr"), "latest VALID result wins");
        assertFalse(placement.me(306, t0.plus(Duration.ofDays(2))).outdated());
    }

    @Test
    @DisplayName("Precedence VERIFIED/STALE → PROVISIONAL → placement; no level ⇒ Bảng chung only; placement user ranked in its division")
    void precedenceAndScopes() {
        Instant t = vn("2026-10-01T09:00");
        takePlacement(311, "A2", t);                       // placement A2 ⇒ SO_CAP
        takePlacement(312, "A2", t);
        overall(312, "VERIFIED", 600, "B2", "B2", true);  // VERIFIED wins over placement
        takePlacement(313, "C1", t);
        overall(313, "PROVISIONAL", 400, "B1", null, true); // PROVISIONAL wins over placement
        assertEquals(Map.of("cefr", "A2", "source", "PLACEMENT", "division", "SO_CAP"), level(311));
        assertEquals("VERIFIED", level(312).get("source"));
        assertEquals("PROVISIONAL", level(313).get("source"));
        assertNull(level(314));
        for (long u : new long[]{311, 314}) ev(u, "DICTATION", "LISTENING", 30, "A2", vn("2026-10-01T10:00"));
        assertEquals("RAN", job.run(vn("2026-10-01T12:00")).outcome().name());
        assertEquals(List.of("GLOBAL", "SO_CAP"), jdbc.queryForList(
                "SELECT DISTINCT scope FROM public.mv_activity_rank WHERE user_id = 311 ORDER BY scope", String.class));
        assertEquals(List.of(), jdbc.queryForList(
                "SELECT DISTINCT scope FROM public.mv_activity_rank WHERE user_id = 314 ORDER BY scope", String.class),
                "no placement ⇒ not ranked (placement required)");
        boardProps.setRequirePlacement(false);
        assertEquals("RAN", job.run(vn("2026-10-01T12:05")).outcome().name());
        assertEquals(List.of("GLOBAL"), jdbc.queryForList(
                "SELECT DISTINCT scope FROM public.mv_activity_rank WHERE user_id = 314 ORDER BY scope", String.class),
                "no level ⇒ never in a division, never defaulted to A1");
        boardProps.setRequirePlacement(true);
        LeaderboardDtos.ActivityMeResponse me = boards.activityMe(311, BoardParams.Period.WEEK, null, BoardParams.Group.ALL);
        assertEquals("GLOBAL", me.defaultScope());
        assertEquals("PLACEMENT", me.divisionSource());
        assertEquals("SO_CAP", me.division());
    }

    @Test
    @DisplayName("Anti-sandbagging: ≥ 60 % of 14-day points on content ≥ 2 steps above a placement level ⇒ +1 step once; never lowers")
    void antiSandbagPromotion() {
        takePlacement(321, "A2", vn("2026-09-20T09:00"));   // placement A2
        takePlacement(322, "A2", vn("2026-09-20T09:00"));
        ev(321, "DICTATION", "LISTENING", 70, "B2", vn("2026-09-30T10:00"));  // 70 % on B2 (= A2 + 2)
        ev(321, "DICTATION", "LISTENING", 30, "A2", vn("2026-09-30T11:00"));
        ev(322, "DICTATION", "LISTENING", 50, "B2", vn("2026-09-30T10:00"));  // 50 % only
        ev(322, "DICTATION", "LISTENING", 50, "A1", vn("2026-09-30T11:00"));
        job.run(vn("2026-10-01T12:00"));
        assertEquals("B1", level(321).get("cefr"), "promoted one step");
        assertEquals("TRUNG_CAP", level(321).get("division"));
        assertEquals("A2", level(322).get("cefr"), "below the 60 % threshold");
        // The "promoted" badge is shown for promotions within the window counted back from the WALL clock (Instant.now()),
        // while this test's data is pinned to 2026-10-01: widen the display window by the days elapsed since then.
        int window = boardProps.getDivision().getPromotionWindowDays();
        boardProps.getDivision().setPromotionWindowDays(window
                + (int) java.time.Duration.between(vn("2026-10-01T12:00"), Instant.now()).toDays());
        try {
            assertEquals("B1", boards.activityMe(321, BoardParams.Period.WEEK, null, BoardParams.Group.ALL).promotedTo());
        } finally {
            boardProps.getDivision().setPromotionWindowDays(window);
        }

        // more easy content and another refresh: no second promotion inside the window, never lowered
        ev(321, "DICTATION", "LISTENING", 200, "A1", vn("2026-10-01T13:00"));
        job.run(vn("2026-10-01T14:00"));
        assertEquals("B1", level(321).get("cefr"));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM public.leaderboard_division_promotion WHERE user_id = 321", Integer.class));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.leaderboard_division_promotion"), "append-only");
    }

    @Test
    @DisplayName("Năng lực others: PROVISIONAL / STALE and placement groups (no rank), hidden never listed, undetermined as a count")
    void proficiencyOthersGroups() {
        overall(331, "PROVISIONAL", 450, "B1", null, true);
        overall(332, "STALE", 480, "B1", "B2", true);
        overall(333, "PROVISIONAL", 460, "B1", null, false);    // hidden
        takePlacement(334, "B1", vn("2026-10-01T09:00"));
        takePlacement(335, "A2", vn("2026-10-01T09:00"));        // other division
        overall(336, "VERIFIED", 600, "B2", "B2", true);         // ranked board, not in the groups
        boardProps.setExcludedUserIds(new ArrayList<>(List.of(337L)));
        takePlacement(337, "B1", vn("2026-10-01T09:00"));        // excluded
        LeaderboardDtos.ProficiencyOthersResponse r = boards.proficiencyOthers(331, ProficiencyBoardType.OVERALL, "TRUNG_CAP");
        assertEquals(List.of(332L, 331L), r.verifying().stream().map(LeaderboardDtos.OtherLevelItem::userId).toList());
        assertEquals(List.of("STALE", "PROVISIONAL"), r.verifying().stream().map(LeaderboardDtos.OtherLevelItem::source).toList());
        assertEquals(List.of(334L), r.placement().stream().map(LeaderboardDtos.OtherLevelItem::userId).toList());
        assertEquals("PLACEMENT", r.placement().get(0).source());
        // 600 seeded − admin − disabled − excluded(337) − levelled (331, 332, 333, 334, 335, 336) = 591
        assertEquals(591, r.undeterminedCount());
        assertTrue(boards.proficiencyOthers(331, ProficiencyBoardType.LISTENING, "TRUNG_CAP").placement().isEmpty(),
                "placement is an overall level ⇒ OVERALL board only");
    }

    @Test
    @DisplayName("Thi đua eligibility: placement required, admin / excluded never ranked, unique ranks, #4+ continuation, honest /me status")
    void eligibilityAndContinuation() {
        Instant t = vn("2026-10-01T08:00");
        long[] placed = {351, 352, 353, 354, 355, 356};
        for (long u : placed) takePlacement(u, "B1", t);
        takePlacement(599, "B1", t);                                  // admin with placement
        takePlacement(357, "B1", t);                                  // configured exclusion
        takePlacement(359, "B1", t);
        takePlacement(361, "B1", t);                                  // placed, no points
        boardProps.setExcludedUserIds(new ArrayList<>(List.of(357L)));
        int pts = 100;
        for (long u : placed) {
            pts -= 10;                                                // 90, 80, … 40
            ev(u, "DICTATION", "LISTENING", pts, "B1", vn("2026-10-01T10:00"));
        }
        ev(359, "DICTATION", "LISTENING", 90, "B1", vn("2026-10-01T10:30")); // same points as 351, reached later
        ev(358, "DICTATION", "LISTENING", 500, "B1", vn("2026-10-01T10:00")); // most points, no placement
        ev(599, "DICTATION", "LISTENING", 400, "B1", vn("2026-10-01T10:00"));
        ev(357, "DICTATION", "LISTENING", 300, "B1", vn("2026-10-01T10:00"));
        assertEquals("RAN", job.run(vn("2026-10-01T12:00")).outcome().name());

        LeaderboardDtos.ActivityBoardResponse board = boards.activityBoard(BoardParams.Period.WEEK, BoardParams.Scope.GLOBAL,
                BoardParams.Group.ALL, 100);
        List<Long> ids = board.items().stream().map(LeaderboardDtos.ActivityItem::userId).toList();
        assertEquals(List.of(351L, 359L, 352L, 353L, 354L, 355L, 356L), ids,
                "only placed, non-admin, non-excluded learners; equal points ⇒ earlier reach first");
        assertEquals(List.of(1, 2, 3, 4, 5, 6, 7), board.items().stream().map(LeaderboardDtos.ActivityItem::rank).toList(),
                "unique consecutive ranks: podium 1–3, list continues at #4");
        assertEquals(7, board.participants());
        assertTrue(board.items().stream().noneMatch(i -> "Người học".equals(i.displayName())), "no placeholder rows");

        assertEquals("RANKED", boards.activityMe(351, BoardParams.Period.WEEK, null, BoardParams.Group.ALL).eligibility());
        assertEquals(2, boards.activityMe(359, BoardParams.Period.WEEK, null, BoardParams.Group.ALL).rank());
        LeaderboardDtos.ActivityMeResponse noPlacement = boards.activityMe(358, BoardParams.Period.WEEK, null, BoardParams.Group.ALL);
        assertEquals("PLACEMENT_REQUIRED", noPlacement.eligibility());
        assertEquals(503, noPlacement.points(), "points are still recorded and shown (500 × streak 1.005)");
        assertFalse(noPlacement.placementCompleted());
        assertNull(noPlacement.excludedReason(), "a normal learner without placement is never classified admin / test");
        LeaderboardDtos.ActivityMeResponse admin = boards.activityMe(599, BoardParams.Period.WEEK, null, BoardParams.Group.ALL);
        assertEquals("EXCLUDED", admin.eligibility());
        assertEquals("ADMIN", admin.excludedReason(), "explicit reason: administrator");
        assertEquals(402, admin.points(), "an excluded account sees its XP (400 × 1.005), never a zero state");
        assertNull(admin.rank());
        LeaderboardDtos.ActivityMeResponse listed = boards.activityMe(357, BoardParams.Period.WEEK, null, BoardParams.Group.ALL);
        assertEquals("EXCLUDED", listed.eligibility());
        assertEquals("EXCLUDED_TEST", listed.excludedReason(), "explicit reason: configured test / excluded account");
        assertEquals("PLACEMENT_REQUIRED", boards.activityMe(360, BoardParams.Period.WEEK, null, BoardParams.Group.ALL).eligibility());
        LeaderboardDtos.ActivityMeResponse fresh = boards.activityMe(361, BoardParams.Period.WEEK, null, BoardParams.Group.ALL);
        assertEquals("NO_POINTS", fresh.eligibility());
        assertTrue(fresh.placementCompleted());
        assertEquals("OTHER_DIVISION", boards.activityMe(351, BoardParams.Period.WEEK, "SO_CAP", BoardParams.Group.ALL).eligibility());

        // "Chưa ghi điểm kỳ này": placed learners without points only
        List<Long> unranked = boards.activityUnranked(BoardParams.Period.WEEK, BoardParams.Scope.GLOBAL, BoardParams.Group.ALL, null, 50)
                .items().stream().map(LeaderboardDtos.UnrankedItem::userId).toList();
        assertEquals(List.of(361L), unranked, "only the placed learner without points");
        assertFalse(unranked.contains(358L), "no placement ⇒ not listed");
        assertFalse(unranked.contains(360L));
        assertFalse(unranked.contains(599L));
        assertFalse(unranked.contains(357L));
        assertTrue(unranked.stream().noneMatch(ids::contains), "ranked learners are not repeated below");
    }

    @Test
    @DisplayName("relativeMult source is untouched by placement: the level provider never reads placement")
    void relativeMultUntouched() throws Exception {
        for (String f : List.of("src/main/java/com/englishcoach/leaderboard/activity/ProficiencyUserLevelProvider.java",
                "src/main/java/com/englishcoach/proficiency/ProficiencyLevelQueryService.java")) {
            String src = Files.readString(Path.of(f)).toLowerCase();
            assertFalse(src.contains("placement"), f);
            assertFalse(src.contains("leaderboard_division_level"), f);
        }
    }

    // ---- V69 autosave / resume ----------------------------------------------------------------------

    @Test
    @DisplayName("Autosave + resume: 28/30 answers survive a closed modal / F5; same questions and order; no keys in the payload")
    void autosaveAndResume() {
        Instant t = Instant.now();
        PlacementService.StartResponse s = placement.start(371, t);
        List<Integer> all = knowUpTo(s.attemptId(), "B1");
        List<Integer> first28 = new ArrayList<>(all.subList(0, 28));
        PlacementService.SaveResponse saved = placement.saveProgress(371, s.attemptId(), first28, t.plusSeconds(200));
        assertEquals(28, saved.answered());
        assertEquals(30, saved.total());
        // modal closed / page reloaded: only the server state remains
        PlacementService.ActiveResponse a = placement.active(371, t.plusSeconds(400)).orElseThrow();
        assertEquals(s.attemptId(), a.attemptId());
        assertEquals(first28, a.answers());
        assertEquals(28, a.answered());
        assertEquals(s.items(), a.items(), "same questions, same order, same option order");
        assertEquals(List.of("index", "skill", "prompt", "options"), List.of(PlacementService.IssuedItem.class.getRecordComponents()).stream()
                .map(java.lang.reflect.RecordComponent::getName).toList(), "resume payload has no level and no answer key");
        PlacementService.MeResponse me = placement.me(371, t.plusSeconds(400));
        assertNotNull(me.activeAttempt());
        assertEquals(28, me.activeAttempt().answered());
        // finish after resume ⇒ one result, progress COMPLETED, resume state gone
        PlacementService.SubmitResponse r = placement.submit(371, s.attemptId(), all, t.plusSeconds(500));
        assertEquals("B1", r.resultCefr());
        assertEquals("COMPLETED", jdbc.queryForObject("SELECT status FROM public.proficiency_placement_progress WHERE issue_id = ?",
                String.class, s.attemptId()));
        assertTrue(placement.active(371, t.plusSeconds(501)).isEmpty());
        assertNull(placement.me(371, t.plusSeconds(501)).activeAttempt());
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM public.proficiency_placement_attempt WHERE user_id = 371", Integer.class));
    }

    @Test
    @DisplayName("No silent second attempt: start with an unfinished one ⇒ 409 ACTIVE_ATTEMPT; 'Làm lại từ đầu' (replace) abandons it explicitly")
    void noSilentSecondAttempt() {
        Instant t = Instant.now();
        PlacementService.StartResponse s = placement.start(372, t);
        placement.saveProgress(372, s.attemptId(), new ArrayList<>(List.of(0, 1, 2)), t.plusSeconds(30));
        ResponseStatusException ex = assertThrows(ResponseStatusException.class, () -> placement.start(372, t.plusSeconds(60)));
        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
        assertEquals(PlacementService.ACTIVE_ATTEMPT, ex.getReason());
        PlacementService.StartResponse fresh = placement.start(372, t.plusSeconds(90), true);
        assertNotEquals(s.attemptId(), fresh.attemptId());
        assertEquals("ABANDONED", jdbc.queryForObject("SELECT status FROM public.proficiency_placement_progress WHERE issue_id = ?",
                String.class, s.attemptId()));
        assertEquals(fresh.attemptId(), placement.active(372, t.plusSeconds(91)).orElseThrow().attemptId());
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.proficiency_placement_progress (issue_id, user_id, status, started_at, updated_at)
                VALUES (?, 372, 'IN_PROGRESS', now(), now())""", s.attemptId()), "at most one IN_PROGRESS per learner (index)");
        assertEquals(HttpStatus.CONFLICT, assertThrows(ResponseStatusException.class,
                () -> placement.saveProgress(372, s.attemptId(), List.of(0), t.plusSeconds(95))).getStatusCode(),
                "the abandoned attempt cannot be written any more");
    }

    @Test
    @DisplayName("Progress validation: own attempt only (404), indexes 0–3 / null, at most 30 answers; expired attempt closes (410) and disappears")
    void progressValidationAndExpiry() {
        Instant t = Instant.now();
        PlacementService.StartResponse s = placement.start(373, t);
        assertEquals(HttpStatus.NOT_FOUND, assertThrows(ResponseStatusException.class,
                () -> placement.saveProgress(374, s.attemptId(), List.of(0), t)).getStatusCode());
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> placement.saveProgress(373, s.attemptId(), List.of(7), t)).getStatusCode());
        List<Integer> tooMany = new ArrayList<>();
        for (int i = 0; i < 31; i++) tooMany.add(0);
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class,
                () -> placement.saveProgress(373, s.attemptId(), tooMany, t)).getStatusCode());
        List<Integer> withSkip = new ArrayList<>();
        withSkip.add(null);
        withSkip.add(2);
        assertEquals(2, placement.saveProgress(373, s.attemptId(), withSkip, t).answered(), "null = 'Tôi chưa biết' is a saved answer");
        assertEquals(withSkip, placement.active(373, t).orElseThrow().answers());
        Instant later = t.plus(Duration.ofHours(25));
        assertEquals(HttpStatus.GONE, assertThrows(ResponseStatusException.class,
                () -> placement.saveProgress(373, s.attemptId(), withSkip, later)).getStatusCode());
        assertTrue(placement.active(373, later).isEmpty());
        assertNull(placement.me(373, later).activeAttempt());
        assertNotNull(placement.start(373, later).attemptId(), "a new attempt can start after expiry");
    }

    @Test
    @DisplayName("Question bank after V69: 80 active, 8 + 8 per level; ambiguous B1-V-05 retired, B1-V-09 issued instead")
    void bankAfterFix() {
        assertEquals(80, jdbc.queryForObject("SELECT COUNT(*) FROM public.proficiency_placement_question WHERE active", Integer.class));
        assertEquals(Boolean.FALSE, jdbc.queryForObject("SELECT active FROM public.proficiency_placement_question WHERE question_key = 'B1-V-05'", Boolean.class));
        assertEquals(Boolean.TRUE, jdbc.queryForObject("SELECT active FROM public.proficiency_placement_question WHERE question_key = 'B1-V-09'", Boolean.class));
        for (String level : LEVELS) {
            for (String skill : List.of("VOCABULARY", "GRAMMAR")) {
                assertEquals(8, jdbc.queryForObject("SELECT COUNT(*) FROM public.proficiency_placement_question WHERE active AND cefr = ? AND skill = ?",
                        Integer.class, level, skill), level + " " + skill);
            }
        }
    }
}
