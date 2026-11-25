package com.englishcoach.leaderboard.board;

import com.englishcoach.leaderboard.activity.ActivityEventListener;
import com.englishcoach.leaderboard.activity.ActivityPointsCalculator;
import com.englishcoach.leaderboard.activity.ActivityScoringProperties;
import com.englishcoach.leaderboard.activity.ActivityScoringService;
import com.englishcoach.leaderboard.activity.ActivitySourceReadRepository;
import com.englishcoach.leaderboard.activity.ScoreEventRepository;
import com.englishcoach.leaderboard.activity.UserLevelProvider;
import com.englishcoach.leaderboard.activity.event.CardBlastRunFinishedEvent;
import com.englishcoach.leaderboard.activity.event.FlashcardReviewedEvent;
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
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.testcontainers.junit.jupiter.Testcontainers;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.*;

/**
 * End-to-end near-realtime path against PostgreSQL 17 with the real migrations (no manual refresh call):
 * source event → ActivityEventListener → ActivityScoringService (score_events) → LeaderboardLiveRefresh (debounced,
 * dedicated scheduler) → LeaderboardRefreshJob (rollup + views) → board API returns the new XP and rank.
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringJUnitConfig(LeaderboardRealtimeIntegrationTest.Config.class)
class LeaderboardRealtimeIntegrationTest {

    static final long A = 371;
    static final long B = 372;

    @Configuration
    @EnableTransactionManagement(proxyTargetClass = true)
    @Import({ActivityRollupRepository.class, ActivityRollupService.class, ActivityRankRepository.class,
            ProficiencyStateRepository.class, ProficiencyBoardRepository.class, ProficiencyBoardService.class,
            LeaderboardRefreshStateRepository.class, LeaderboardRefreshJob.class, LeaderboardDisplayRepository.class,
            LeaderboardBoardService.class, LeaderboardOthersRepository.class, LeaderboardSchedulerConfig.class,
            LeaderboardLiveRefresh.class, ActivityScoringService.class, ActivityPointsCalculator.class,
            ScoreEventRepository.class, ActivitySourceReadRepository.class, ActivityEventListener.class})
    static class Config {
        @Bean DataSource dataSource() { return BoardTestPostgres.dataSource(); }
        @Bean NamedParameterJdbcTemplate namedParameterJdbcTemplate(DataSource ds) { return new NamedParameterJdbcTemplate(ds); }
        @Bean JdbcTemplate jdbcTemplate(DataSource ds) { return new JdbcTemplate(ds); }
        @Bean PlatformTransactionManager transactionManager(DataSource ds) { return new DataSourceTransactionManager(ds); }
        @Bean ProficiencyProperties proficiencyProperties() { return new ProficiencyProperties(); }
        @Bean LeaderboardProperties leaderboardProperties() { return new LeaderboardProperties(); }
        @Bean LeaderboardRefreshProperties leaderboardRefreshProperties() {
            LeaderboardRefreshProperties p = new LeaderboardRefreshProperties();
            p.setLiveDebounceMs(200);
            p.setLiveMinIntervalMs(300);
            return p;
        }
        @Bean ActivityScoringProperties activityScoringProperties() {
            ActivityScoringProperties p = new ActivityScoringProperties();
            p.setStartAt("2026-09-01T00:00:00+07:00");
            return p;
        }
        @Bean UserLevelProvider userLevelProvider() {
            UserLevelProvider p = Mockito.mock(UserLevelProvider.class);
            Mockito.when(p.currentLevel(Mockito.any())).thenReturn(Optional.empty());
            Mockito.when(p.activityDivisionLevel(Mockito.any())).thenReturn(Optional.empty());
            return p;
        }
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired ApplicationEventPublisher publisher;
    @Autowired LeaderboardBoardService boards;
    @Autowired LeaderboardRefreshJob job;
    @Autowired LeaderboardProperties boardProps;

    @BeforeEach
    void reset() throws Exception {
        try (Connection c = BoardTestPostgres.rawConnection(); Statement st = c.createStatement()) {
            st.execute("""
                    TRUNCATE public.proficiency_placement_progress, public.proficiency_placement_attempt, public.proficiency_placement_issue,
                             public.leaderboard_division_promotion, public.score_events, public.leaderboard_activity_daily,
                             public.skill_proficiency, public.user_proficiency, public.user_profiles, public.user_avatar_frames;
                    UPDATE public.users SET role = 'ROLE_USER', account_status = 'ACTIVE';
                    UPDATE public.leaderboard_refresh_state SET as_of = NULL, activity_start_at = NULL, last_success_at = NULL,
                        last_attempt_at = NULL, last_error = NULL, last_processed_created_at = NULL;
                    """);
        }
        boardProps.setExcludedUserIds(new ArrayList<>());
        boardProps.setRequirePlacement(true);
        boards.invalidateBoardCache();
        for (long u : new long[]{A, B}) placed(u);
    }

    /** A VALID placement attempt (eligibility for Thi đua). */
    private void placed(long user) {
        UUID issue = UUID.randomUUID();
        Instant t = Instant.now().minus(Duration.ofDays(1));
        jdbc.update("INSERT INTO public.proficiency_placement_issue (id, user_id, items, created_at, expires_at, model_version) VALUES (?, ?, '[]', ?, ?, 2)",
                issue, user, Timestamp.from(t), Timestamp.from(t.plusSeconds(1800)));
        jdbc.update("""
                INSERT INTO public.proficiency_placement_attempt (issue_id, user_id, items, answers, fa, level_rates, result_cefr, status,
                    created_at, model_version) VALUES (?, ?, '[]', '[]', 0, '{}', 'B1', 'VALID', ?, 2)
                """, issue, user, Timestamp.from(t));
    }

    private LeaderboardDtos.ActivityBoardResponse board() {
        return boards.activityBoard(BoardParams.Period.WEEK, BoardParams.Scope.GLOBAL, BoardParams.Group.ALL, 20);
    }

    private int pointsOf(LeaderboardDtos.ActivityBoardResponse b, long user) {
        return b.items().stream().filter(i -> i.userId() == user).mapToInt(LeaderboardDtos.ActivityItem::points).findFirst().orElse(0);
    }

    /** Polls the read API (as an open leaderboard would) until {@code done}; returns the elapsed ms. */
    private long awaitBoard(Predicate<LeaderboardDtos.ActivityBoardResponse> done, Duration timeout) throws InterruptedException {
        long start = System.nanoTime();
        while (System.nanoTime() - start < timeout.toNanos()) {
            if (done.test(board())) return (System.nanoTime() - start) / 1_000_000L;
            Thread.sleep(100);
        }
        fail("board not updated within " + timeout + ": " + board().items());
        return -1;
    }

    @Test
    @DisplayName("Card Blast run ⇒ score event ⇒ live refresh ⇒ API shows the new XP and the new #1 within seconds (no manual refresh); replay adds nothing")
    void cardBlastEndToEnd() throws Exception {
        // B already leads with 50 XP (Dictation earlier today)
        jdbc.update("""
                INSERT INTO public.score_events (user_id, source_module, source_ref, skill_group, base, cefr_mult, quality_mult,
                    relative_mult, raw_points, eligible_points, occurred_at) VALUES (?, 'DICTATION', 'seed', 'LISTENING', 1, 1, 1, 1, 50, 50, ?)
                """, B, Timestamp.from(Instant.now().minusSeconds(60)));
        assertEquals(LeaderboardRefreshJob.Outcome.RAN, job.run(Instant.now()).outcome());
        assertEquals(1, board().items().get(0).rank());
        assertEquals(B, board().items().get(0).userId());
        assertEquals(0, pointsOf(board(), A));

        // A finishes a Card Blast run: 30 hits, 80 % ⇒ 60 (cap) × 1.5 × 0.9 = 81 XP
        CardBlastRunFinishedEvent run = new CardBlastRunFinishedEvent(A, 990001L, null, 1500, 80.0, 2, 30, 38, Instant.now());
        publisher.publishEvent(run);
        long ms = awaitBoard(b -> !b.items().isEmpty() && b.items().get(0).userId() == A && pointsOf(b, A) == 81, Duration.ofSeconds(10));
        assertTrue(ms < 5_000, "visible after " + ms + " ms");
        LeaderboardDtos.ActivityMeResponse me = boards.activityMe(A, BoardParams.Period.WEEK, null, BoardParams.Group.ALL);
        assertEquals(1, me.rank(), "rank recomputed: A passed B");
        assertEquals(81, me.points());
        assertEquals("RANKED", me.eligibility());
        assertEquals(2, boards.activityMe(B, BoardParams.Period.WEEK, null, BoardParams.Group.ALL).rank());

        // the same completion delivered again ⇒ no second row, no extra XP
        publisher.publishEvent(run);
        publisher.publishEvent(run);
        Thread.sleep(1_000);
        assertEquals(LeaderboardRefreshJob.Outcome.RAN, job.run(Instant.now()).outcome());
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM public.score_events WHERE user_id = ? AND source_module = 'CARD_BLAST_SOLO'",
                Integer.class, A));
        assertEquals(81, pointsOf(board(), A));
    }

    @Test
    @DisplayName("Non-game source (flashcard first study) reaches the board API within seconds")
    void flashcardEndToEnd() throws Exception {
        for (int i = 0; i < 4; i++) {
            publisher.publishEvent(new FlashcardReviewedEvent(B, 880000L + i, 1, "good", "NEW", "LEARNED", null, "B1", null, Instant.now()));
        }
        // 4 × FLASHCARD_NEW (3 × B1 1.5 = 4.5 ⇒ 5) = 20 (× streak 1.005 ⇒ 20)
        long ms = awaitBoard(b -> pointsOf(b, B) == 20, Duration.ofSeconds(10));
        assertTrue(ms < 5_000, "visible after " + ms + " ms");
        assertEquals("RANKED", boards.activityMe(B, BoardParams.Period.WEEK, null, BoardParams.Group.ALL).eligibility());
    }

    @Test
    @DisplayName("Learner without placement: XP recorded and shown in /me (PLACEMENT_REQUIRED), never on the public board")
    void notPlacedNotRanked() throws Exception {
        long c = 373;
        publisher.publishEvent(new CardBlastRunFinishedEvent(c, 990101L, null, 600, 100.0, 0, 30, 30, Instant.now()));
        publisher.publishEvent(new CardBlastRunFinishedEvent(A, 990102L, null, 200, 100.0, 0, 10, 10, Instant.now()));
        awaitBoard(b -> pointsOf(b, A) > 0, Duration.ofSeconds(10));
        assertEquals(0, pointsOf(board(), c));
        LeaderboardDtos.ActivityMeResponse me = boards.activityMe(c, BoardParams.Period.WEEK, null, BoardParams.Group.ALL);
        assertEquals("PLACEMENT_REQUIRED", me.eligibility());
        assertTrue(me.points() > 0, "the learner sees their real XP");
        assertNull(me.rank());
    }
}
