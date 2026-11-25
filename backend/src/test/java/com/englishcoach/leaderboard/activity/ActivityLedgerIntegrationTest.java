package com.englishcoach.leaderboard.activity;

import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.common.event.DictationAttemptSubmittedEvent;
import com.englishcoach.common.event.ExamScoredEvent;
import com.englishcoach.common.event.RoleplayTurnRecordedEvent;
import com.englishcoach.leaderboard.activity.event.CardBlastRunFinishedEvent;
import com.englishcoach.leaderboard.activity.event.FlashcardReviewedEvent;
import com.englishcoach.leaderboard.activity.event.PvpMatchFinishedEvent;
import com.englishcoach.leaderboard.activity.event.ShadowingAttemptRecordedEvent;
import com.englishcoach.leaderboard.activity.event.WritingAssessmentCompletedEvent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Testcontainers;

import javax.sql.DataSource;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Activity ledger against a real PostgreSQL 17 (V52 applied): daily caps, retries, PvP limits,
 * idempotency, start-at, append-only trigger, per-user locking and AFTER_COMMIT delivery.
 * Listener runs synchronously here (no @EnableAsync in the test context).
 */
@Testcontainers(disabledWithoutDocker = true)
@SpringJUnitConfig(ActivityLedgerIntegrationTest.Config.class)
class ActivityLedgerIntegrationTest {

    static final Instant AT = Instant.parse("2026-10-01T03:00:00Z"); // 10:00 Asia/Ho_Chi_Minh

    @Configuration
    @EnableTransactionManagement
    @Import({ActivityPointsCalculator.class, ScoreEventRepository.class, ActivitySourceReadRepository.class,
            ActivityScoringService.class, ActivityEventListener.class})
    static class Config {
        /** Undetermined learners (relativeMult 1.0) — keeps the Phase 1 expectations exact. */
        @Bean UserLevelProvider userLevelProvider() {
            return new UserLevelProvider() {
                @Override public java.util.Optional<Cefr> currentLevel(Long userId) { return java.util.Optional.empty(); }
                @Override public java.util.Optional<Cefr> activityDivisionLevel(Long userId) { return java.util.Optional.empty(); }
            };
        }
        @Bean DataSource dataSource() { return LeaderboardTestPostgres.dataSource(); }
        @Bean NamedParameterJdbcTemplate namedParameterJdbcTemplate(DataSource ds) { return new NamedParameterJdbcTemplate(ds); }
        @Bean JdbcTemplate jdbcTemplate(DataSource ds) { return new JdbcTemplate(ds); }
        @Bean PlatformTransactionManager transactionManager(DataSource ds) { return new DataSourceTransactionManager(ds); }
        @Bean TransactionTemplate transactionTemplate(PlatformTransactionManager tm) { return new TransactionTemplate(tm); }
        @Bean ActivityScoringProperties activityScoringProperties() {
            ActivityScoringProperties p = new ActivityScoringProperties();
            p.setStartAt("2026-01-01T00:00:00Z");
            return p;
        }
    }

    @Autowired ActivityScoringService scoring;
    @Autowired ScoreEventRepository ledger;
    @Autowired ActivityScoringProperties props;
    @Autowired JdbcTemplate jdbc;
    @Autowired TransactionTemplate tx;
    @Autowired ApplicationEventPublisher publisher;

    private static FlashcardReviewedEvent review(long user, long card, int reviewCount, String quality,
                                                 String prev, String next, String cefr, Instant at) {
        return new FlashcardReviewedEvent(user, card, reviewCount, quality, prev, next, card + 1000, cefr, null, at);
    }

    private List<Integer> eligible(long user, ActivitySource source) {
        return ledger.findByUser(user).stream().filter(r -> r.sourceModule() == source)
                .map(ScoreEventRow::eligiblePoints).toList();
    }

    private long totalEligible(long user) {
        return ledger.findByUser(user).stream().mapToLong(ScoreEventRow::eligiblePoints).sum();
    }

    // ---- Formula per source through the ledger -----------------------------------------------

    @Test
    @DisplayName("Flashcard: first study ⇒ NEW only; later reviews ⇒ REVIEW; MASTERED only with reviewCount >= 3 (D5)")
    void flashcardReviewNewMastered() {
        long u = 101;
        scoring.onFlashcardReviewed(review(u, 1, 1, "good", "NEW", "LEARNED", "B1", AT));
        scoring.onFlashcardReviewed(review(u, 1, 3, "easy", "LEARNED", "MASTERED", "B1", AT));
        scoring.onFlashcardReviewed(review(u, 2, 1, "easy", "NEW", "MASTERED", "B1", AT));
        assertEquals(List.of(3), eligible(u, ActivitySource.FLASHCARD_REVIEW));
        assertEquals(List.of(5, 5), eligible(u, ActivitySource.FLASHCARD_NEW));
        assertEquals(List.of(15), eligible(u, ActivitySource.FLASHCARD_MASTERED), "card 2 mastered at reviewCount 1 ⇒ no bonus");
        ScoreEventRow first = ledger.findByUser(u).get(0);
        assertEquals("new:1", first.sourceRef());
        assertEquals(Cefr.B1, first.cefrLevel());
        assertEquals(SkillGroup.VOCAB, first.skillGroup());
    }

    @Test
    @DisplayName("Phase 1.1: reviewCount 1 ⇒ exactly one FLASHCARD_NEW row (base 3); reviewCount 2 ⇒ one FLASHCARD_REVIEW row")
    void firstStudyScoresNewOnly() {
        long u = 131;
        List<ScoreEventRow> first = scoring.onFlashcardReviewed(review(u, 1, 1, "good", "NEW", "LEARNED", "A1", AT));
        assertEquals(1, first.size());
        assertEquals(ActivitySource.FLASHCARD_NEW, first.get(0).sourceModule());
        assertEquals(0, first.get(0).base().compareTo(new java.math.BigDecimal("3")));
        assertEquals(3, first.get(0).eligiblePoints()); // A1 ⇒ ×1.0

        List<ScoreEventRow> second = scoring.onFlashcardReviewed(review(u, 1, 2, "good", "LEARNED", "LEARNED", "A1", AT));
        assertEquals(1, second.size());
        assertEquals(ActivitySource.FLASHCARD_REVIEW, second.get(0).sourceModule());
        assertEquals("review:1:2", second.get(0).sourceRef());
        assertEquals(2, second.get(0).eligiblePoints());
        assertEquals(2, ledger.findByUser(u).size());
    }

    @Test
    @DisplayName("Phase 1.1: MASTERED at reviewCount 3 scores 10; at reviewCount 1 or 2 it scores nothing")
    void masteredNeedsThreeReviews() {
        long u = 132;
        scoring.onFlashcardReviewed(review(u, 1, 1, "easy", "NEW", "MASTERED", "A1", AT));
        scoring.onFlashcardReviewed(review(u, 2, 2, "easy", "LEARNED", "MASTERED", "A1", AT));
        assertTrue(eligible(u, ActivitySource.FLASHCARD_MASTERED).isEmpty());
        scoring.onFlashcardReviewed(review(u, 3, 3, "easy", "LEARNED", "MASTERED", "A1", AT));
        assertEquals(List.of(10), eligible(u, ActivitySource.FLASHCARD_MASTERED));
        assertEquals(List.of(3), eligible(u, ActivitySource.FLASHCARD_NEW));
        assertEquals(List.of(2, 2), eligible(u, ActivitySource.FLASHCARD_REVIEW));
    }

    @Test
    @DisplayName("Flashcard daily cap 150 is shared by REVIEW/NEW/MASTERED and resets next VN day")
    void flashcardDailyCap() {
        long u = 102;
        for (int card = 1; card <= 20; card++) {
            scoring.onFlashcardReviewed(review(u, card, 1, "good", "NEW", "LEARNED", "C2", AT)); // NEW 3 × 2.6 = 8
        }
        assertEquals(150, totalEligible(u)); // 18 × 8 = 144, 19th ⇒ 6, 20th ⇒ 0
        assertTrue(ledger.findByUser(u).stream().anyMatch(r -> r.capped() && r.eligiblePoints() < r.rawPoints()));
        assertTrue(ledger.findByUser(u).stream().allMatch(r -> r.rawPoints() == 8), "raw never altered");

        scoring.onFlashcardReviewed(review(u, 99, 2, "good", "LEARNED", "LEARNED", "C2", AT.plus(Duration.ofDays(1))));
        assertEquals(155, totalEligible(u), "new day ⇒ full REVIEW 2 × 2.6 = 5 again");
    }

    @Test
    @DisplayName("Card Blast solo (hotfix): proxy 15 words × 2 × B1 1.5 × (0.5 + 0.5 × 0.8) = 41; 12 hits ⇒ 32; hits clamped by score")
    void cardBlastSolo() {
        long u = 111;
        scoring.onCardBlastRunFinished(new CardBlastRunFinishedEvent(u, 7001L, 3L, 300, 80.0, 2, AT));
        assertEquals(List.of(41), eligible(u, ActivitySource.CARD_BLAST_SOLO));
        assertEquals("cardblast:7001", ledger.findByUser(u).get(0).sourceRef());
        long v = 121;
        scoring.onCardBlastRunFinished(new CardBlastRunFinishedEvent(v, 7002L, 3L, 300, 80.0, 2, 12, 15, AT));
        scoring.onCardBlastRunFinished(new CardBlastRunFinishedEvent(v, 7003L, 3L, 300, 80.0, 2, 999, 999, AT));
        scoring.onCardBlastRunFinished(new CardBlastRunFinishedEvent(v, 7004L, 3L, 60, 15.0, 11, 2, 13, AT));
        // 12 hits ⇒ 24 × 1.5 × 0.9 = 32.4; 999 hits > 300 / 20 ⇒ 15 ⇒ 41; 2 hits at 15 % ⇒ 4 × 1.5 × 0.575 = 3.45
        assertEquals(List.of(32, 41, 3), eligible(v, ActivitySource.CARD_BLAST_SOLO));
    }

    @Test
    @DisplayName("Card Blast replay: the same finished run delivered twice awards points once")
    void cardBlastReplayIdempotent() {
        long u = 122;
        CardBlastRunFinishedEvent run = new CardBlastRunFinishedEvent(u, 7101L, null, 1200, 80.0, 0, 30, 40, AT);
        assertEquals(1, scoring.onCardBlastRunFinished(run).size());
        assertEquals(0, scoring.onCardBlastRunFinished(run).size());
        assertEquals(0, scoring.onCardBlastRunFinished(run).size());
        assertEquals(1, ledger.findByUser(u).size());
        assertEquals(81, totalEligible(u), "60 (cap) × 1.5 × 0.9 = 81, once");
    }

    @Test
    @DisplayName("Dictation retries: 1st 100 %, attempts 2–3 30 %, 4th 0")
    void dictationRetries() {
        long u = 103;
        Long session = jdbc.queryForObject("INSERT INTO public.listening_sessions (user_id) VALUES (?) RETURNING id", Long.class, u);
        for (int i = 0; i < 4; i++) {
            Long attempt = jdbc.queryForObject(
                    "INSERT INTO public.exercise_attempts (listening_session_id, listening_exercise_id) VALUES (?, 500) RETURNING id",
                    Long.class, session);
            scoring.onDictationAttemptSubmitted(new DictationAttemptSubmittedEvent(u, attempt, 500L, 9L, session, "B1", 100.0, true, AT));
        }
        assertEquals(List.of(30, 9, 9, 0), eligible(u, ActivitySource.DICTATION));
    }

    @Test
    @DisplayName("Dictation daily cap 120")
    void dictationCap() {
        long u = 104;
        Long session = jdbc.queryForObject("INSERT INTO public.listening_sessions (user_id) VALUES (?) RETURNING id", Long.class, u);
        for (long ex = 601; ex <= 605; ex++) {
            Long attempt = jdbc.queryForObject(
                    "INSERT INTO public.exercise_attempts (listening_session_id, listening_exercise_id) VALUES (?, ?) RETURNING id",
                    Long.class, session, ex);
            scoring.onDictationAttemptSubmitted(new DictationAttemptSubmittedEvent(u, attempt, ex, 9L, session, "B1", 100.0, true, AT));
        }
        assertEquals(List.of(30, 30, 30, 30, 0), eligible(u, ActivitySource.DICTATION));
    }

    @Test
    @DisplayName("PvP: more than 3 matches/day vs the same opponent ⇒ 4th capped for both players")
    void pvpSameOpponent() {
        for (long m = 1; m <= 4; m++) {
            scoring.onPvpMatchFinished(new PvpMatchFinishedEvent(900 + m, "HUMAN", 105L, 106L, "105", "KO", 60_000L, true, 20, 12, null, AT));
        }
        assertEquals(List.of(45, 45, 45, 0), eligible(105, ActivitySource.CARD_BLAST_PVP)); // 30 × 1.5
        assertEquals(List.of(15, 15, 15, 0), eligible(106, ActivitySource.CARD_BLAST_PVP)); // 10 × 1.5
    }

    @Test
    @DisplayName("PvP: HUMAN + BOT share 10 matches/day; forfeit = 0; opponent rating quality")
    void pvpDailyLimitAndForfeit() {
        long u = 107;
        for (long m = 1; m <= 9; m++) {
            scoring.onPvpMatchFinished(new PvpMatchFinishedEvent(1000 + m, "BOT", u, null, String.valueOf(u), "KO", 60_000L, false, 20, 0, null, AT));
        }
        jdbc.update("INSERT INTO public.pvp_ratings (user_id, rating) VALUES (107, 1000), (108, 1200)");
        scoring.onPvpMatchFinished(new PvpMatchFinishedEvent(1010L, "HUMAN", u, 108L, "108", "FORFEIT", 90_000L, false, 1, 3, null, AT));
        scoring.onPvpMatchFinished(new PvpMatchFinishedEvent(1011L, "HUMAN", u, 109L, String.valueOf(u), "KO", 60_000L, true, 20, 3, null, AT));
        List<Integer> points = eligible(u, ActivitySource.CARD_BLAST_PVP);
        assertEquals(11, points.size());
        assertEquals(23, points.get(0), "bot win 15 × 1.5 = 22.5 → 23");
        assertEquals(0, points.get(9), "10th match: forfeit ⇒ 0 (still counts as a match)");
        assertEquals(0, points.get(10), "11th match over the daily limit");
        assertTrue(ledger.findByUser(u).get(10).capped());
        // Opponent 108 won by forfeit with rating 1200 vs 1000 ⇒ quality 0.75 → clamp 0.8: 30 × 1.5 × 0.8 = 36.
        assertEquals(List.of(36), eligible(108, ActivitySource.CARD_BLAST_PVP));
    }

    @Test
    @DisplayName("Phase 1.1: HUMAN forfeit at 30 s ⇒ both players get a 0-point row (audit trail kept)")
    void pvpInstantForfeitGivesBothZero() {
        scoring.onPvpMatchFinished(new PvpMatchFinishedEvent(2001L, "HUMAN", 133L, 134L, "134", "FORFEIT", 30_000L, false, 2, 5, null, AT));
        for (long u : new long[]{133, 134}) {
            List<ScoreEventRow> rows = ledger.findByUser(u);
            assertEquals(1, rows.size());
            assertEquals(0, rows.get(0).rawPoints());
            assertEquals(0, rows.get(0).eligiblePoints());
            assertEquals(0, rows.get(0).base().signum());
            assertFalse(rows.get(0).capped());
        }
    }

    @Test
    @DisplayName("Phase 1.1: HUMAN forfeit at 90 s ⇒ winner base 30, forfeiter 0")
    void pvpLateForfeitKeepsNormalRules() {
        scoring.onPvpMatchFinished(new PvpMatchFinishedEvent(2002L, "HUMAN", 135L, 136L, "136", "FORFEIT", 90_000L, false, 2, 5, null, AT));
        ScoreEventRow forfeiter = ledger.findByUser(135).get(0);
        ScoreEventRow winner = ledger.findByUser(136).get(0);
        assertEquals(0, forfeiter.base().signum());
        assertEquals(0, forfeiter.eligiblePoints());
        assertEquals(0, winner.base().compareTo(new java.math.BigDecimal("30")));
        assertEquals(45, winner.eligiblePoints()); // 30 × B1 1.5 × 1.0
    }

    @Test
    @DisplayName("Phase 1.1: BOT forfeit at 30 s ⇒ unchanged BOT rules (win 15, forfeiter 0)")
    void pvpBotForfeitUnchanged() {
        long u = 137;
        scoring.onPvpMatchFinished(new PvpMatchFinishedEvent(2003L, "BOT", u, null, String.valueOf(u), "FORFEIT", 30_000L, false, 4, 0, null, AT));
        scoring.onPvpMatchFinished(new PvpMatchFinishedEvent(2004L, "BOT", u, null, "BOT_2", "FORFEIT", 30_000L, false, 0, 4, null, AT));
        List<ScoreEventRow> rows = ledger.findByUser(u);
        assertEquals(0, rows.get(0).base().compareTo(new java.math.BigDecimal("15")));
        assertEquals(23, rows.get(0).eligiblePoints()); // 15 × 1.5 = 22.5
        assertEquals(0, rows.get(1).eligiblePoints());
    }

    @Test
    @DisplayName("Phase 1.1: instant-forfeit rows still count toward the 3/day-vs-same-opponent limit")
    void pvpInstantForfeitsCountTowardLimits() {
        for (long m = 1; m <= 3; m++) {
            scoring.onPvpMatchFinished(new PvpMatchFinishedEvent(2100 + m, "HUMAN", 138L, 139L, "138", "FORFEIT", 5_000L, false, 1, 0, null, AT));
        }
        scoring.onPvpMatchFinished(new PvpMatchFinishedEvent(2104L, "HUMAN", 138L, 139L, "138", "KO", 90_000L, true, 20, 3, null, AT));
        List<ScoreEventRow> rows = ledger.findByUser(138);
        assertEquals(List.of(0, 0, 0, 0), rows.stream().map(ScoreEventRow::eligiblePoints).toList());
        assertEquals(List.of(false, false, false, true), rows.stream().map(ScoreEventRow::capped).toList());
        assertEquals(45, rows.get(3).rawPoints(), "4th match scored normally but capped by the opponent limit");
    }

    @Test
    @DisplayName("Shadowing: abstention/mocked = no event; first attempt per sentence per day")
    void shadowing() {
        long u = 112;
        scoring.onShadowingAttemptRecorded(new ShadowingAttemptRecordedEvent(u, 1L, 5L, 77L, 9L, "B1", null, null, null, false, 0, AT));
        scoring.onShadowingAttemptRecorded(new ShadowingAttemptRecordedEvent(u, 2L, 5L, 77L, 9L, "B1", 90.0, null, null, true, 0, AT));
        assertTrue(ledger.findByUser(u).isEmpty());
        scoring.onShadowingAttemptRecorded(new ShadowingAttemptRecordedEvent(u, 3L, 5L, 77L, 9L, "B1", 80.0, null, null, false, 0, AT));
        scoring.onShadowingAttemptRecorded(new ShadowingAttemptRecordedEvent(u, 4L, 5L, 77L, 9L, "B1", 100.0, null, null, false, 1, AT));
        assertEquals(List.of(12), eligible(u, ActivitySource.SHADOWING));
        assertEquals("shadowing:77:2026-10-01", ledger.findByUser(u).get(0).sourceRef());
    }

    @Test
    @DisplayName("Roleplay: scored once at >= 6 learner turns with average fluency")
    void roleplay() {
        long u = 113;
        long session = 4200;
        for (int i = 0; i < 5; i++) {
            jdbc.update("INSERT INTO public.speaking_turns (session_id, speaker, is_mocked, fluency_score) VALUES (?, 'LEARNER', false, 80)", session);
            jdbc.update("INSERT INTO public.speaking_turns (session_id, speaker, is_mocked) VALUES (?, 'ASSISTANT', false)", session);
        }
        scoring.onRoleplayTurnRecorded(new RoleplayTurnRecordedEvent(u, session, 1L, 3L, "A2", 70, 80, false, AT));
        assertTrue(ledger.findByUser(u).isEmpty(), "5 learner turns ⇒ nothing yet");
        jdbc.update("INSERT INTO public.speaking_turns (session_id, speaker, is_mocked, fluency_score) VALUES (?, 'LEARNER', false, 80)", session);
        scoring.onRoleplayTurnRecorded(new RoleplayTurnRecordedEvent(u, session, 2L, 3L, "A2", 70, 80, false, AT));
        scoring.onRoleplayTurnRecorded(new RoleplayTurnRecordedEvent(u, session, 3L, 3L, "A2", 70, 80, false, AT));
        assertEquals(List.of(14), eligible(u, ActivitySource.ROLEPLAY)); // 15 × 1.2 × 0.8 = 14.4
    }

    @Test
    @DisplayName("Writing: once per session, max 2 counted/day (D4)")
    void writing() {
        long u = 114;
        for (int s = 1; s <= 3; s++) {
            scoring.onWritingAssessmentCompleted(new WritingAssessmentCompletedEvent(u, "ws-" + s, "sub", "as", "ielts-t2-x", 100, 1, AT));
        }
        scoring.onWritingAssessmentCompleted(new WritingAssessmentCompletedEvent(u, "ws-1", "sub2", "as2", "ielts-t2-x", 100, 2, AT));
        assertEquals(List.of(90, 90, 0), eligible(u, ActivitySource.WRITING)); // 60 × 1.5 × 1.0
    }

    @Test
    @DisplayName("Exams: full simulation first per form; practice per skill; REVIEW_REQUIRED ignored; cefr 1.0")
    void exams() {
        long u = 115;
        UUID form = UUID.randomUUID();
        Map<ScoreMetric, Double> ielts = new EnumMap<>(ScoreMetric.class);
        ielts.put(ScoreMetric.FULL_OVERALL, 6.0);
        ielts.put(ScoreMetric.LISTENING, 6.5);
        scoring.onExamScored(new ExamScoredEvent(u, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), 1, form,
                "IELTS", "ACADEMIC", "FULL", "EXAM_SIMULATION", "COMPLETED", ielts, AT));
        scoring.onExamScored(new ExamScoredEvent(u, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), 1, form,
                "IELTS", "ACADEMIC", "FULL", "EXAM_SIMULATION", "COMPLETED", ielts, AT));
        assertEquals(List.of(200), eligible(u, ActivitySource.EXAM_SIMULATION));
        assertNull(ledger.findByUser(u).get(0).cefrLevel());

        Map<ScoreMetric, Double> toeic = new EnumMap<>(ScoreMetric.class);
        toeic.put(ScoreMetric.LISTENING, 400.0);
        UUID toeicForm = UUID.randomUUID();
        scoring.onExamScored(new ExamScoredEvent(u, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), 1, toeicForm,
                "TOEIC", "LR", "LISTENING", "PRACTICE", "REVIEW_REQUIRED", toeic, AT));
        assertTrue(eligible(u, ActivitySource.EXAM_PRACTICE).isEmpty());
        scoring.onExamScored(new ExamScoredEvent(u, UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), 1, toeicForm,
                "TOEIC", "LR", "LISTENING", "PRACTICE", "COMPLETED", toeic, AT));
        assertEquals(List.of(40), eligible(u, ActivitySource.EXAM_PRACTICE)); // 50 × 400/495 = 40.4
    }

    // ---- Anti-cheat / ledger invariants -------------------------------------------------------

    @Test
    @DisplayName("Idempotency: the same event twice ⇒ one row")
    void idempotency() {
        long u = 116;
        CardBlastRunFinishedEvent e = new CardBlastRunFinishedEvent(u, 8001L, null, 300, 80.0, 0, AT);
        assertEquals(1, scoring.onCardBlastRunFinished(e).size());
        assertEquals(0, scoring.onCardBlastRunFinished(e).size());
        FlashcardReviewedEvent r = review(u, 5, 1, "good", "NEW", "LEARNED", "B1", AT);
        scoring.onFlashcardReviewed(r);
        scoring.onFlashcardReviewed(r);
        assertEquals(2, ledger.findByUser(u).size()); // card blast + NEW (Phase 1.1: no REVIEW on first study)
    }

    @Test
    @DisplayName("Events before start-at (or with start-at unset) are not recorded")
    void startAt() {
        long u = 117;
        scoring.onCardBlastRunFinished(new CardBlastRunFinishedEvent(u, 9001L, null, 300, 80.0, 0, Instant.parse("2025-12-31T23:59:59Z")));
        assertTrue(ledger.findByUser(u).isEmpty());
        String saved = props.getStartAt();
        try {
            props.setStartAt(null);
            scoring.onCardBlastRunFinished(new CardBlastRunFinishedEvent(u, 9002L, null, 300, 80.0, 0, AT));
            assertTrue(ledger.findByUser(u).isEmpty());
        } finally {
            props.setStartAt(saved);
        }
        scoring.onCardBlastRunFinished(new CardBlastRunFinishedEvent(u, 9003L, null, 300, 80.0, 0, AT));
        assertEquals(1, ledger.findByUser(u).size());
    }

    @Test
    @DisplayName("Append-only: UPDATE and DELETE on score_events are rejected by the database")
    void appendOnly() {
        long u = 118;
        scoring.onCardBlastRunFinished(new CardBlastRunFinishedEvent(u, 9101L, null, 300, 80.0, 0, AT));
        assertThrows(DataAccessException.class,
                () -> jdbc.update("UPDATE public.score_events SET eligible_points = 999 WHERE user_id = ?", u));
        assertThrows(DataAccessException.class,
                () -> jdbc.update("DELETE FROM public.score_events WHERE user_id = ?", u));
        assertEquals(41, ledger.findByUser(u).get(0).eligiblePoints());
    }

    @Test
    @DisplayName("Per-user lock: 20 concurrent shadowing events cannot exceed the 100 cap")
    void concurrentCap() throws Exception {
        long u = 119;
        ExecutorService pool = Executors.newFixedThreadPool(8);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<?>> futures = new ArrayList<>();
        for (long unit = 1; unit <= 20; unit++) {
            long unitId = unit;
            futures.add(pool.submit(() -> {
                start.await();
                return scoring.onShadowingAttemptRecorded(new ShadowingAttemptRecordedEvent(
                        u, unitId, 1L, unitId, 9L, "C2", 100.0, null, null, false, 0, AT)); // 26 each
            }));
        }
        start.countDown();
        for (Future<?> f : futures) f.get();
        pool.shutdown();
        assertEquals(20, ledger.findByUser(u).size());
        assertEquals(100, totalEligible(u));
    }

    @Test
    @DisplayName("AFTER_COMMIT: committed source tx ⇒ row; rolled-back source tx ⇒ no row")
    void afterCommitDelivery() {
        long committed = 120;
        long rolledBack = 121;
        tx.executeWithoutResult(s -> {
            jdbc.update("INSERT INTO public.lb_test_source (note) VALUES ('flashcard saved')");
            publisher.publishEvent(review(committed, 1, 2, "good", "LEARNED", "LEARNED", "B1", AT));
            assertTrue(ledger.findByUser(committed).isEmpty(), "not scored before commit");
        });
        assertEquals(List.of(3), eligible(committed, ActivitySource.FLASHCARD_REVIEW));

        tx.executeWithoutResult(s -> {
            publisher.publishEvent(review(rolledBack, 1, 2, "good", "LEARNED", "LEARNED", "B1", AT));
            s.setRollbackOnly();
        });
        assertTrue(ledger.findByUser(rolledBack).isEmpty());
    }
}
