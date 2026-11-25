package com.englishcoach.leaderboard.activity;

import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Exact point values per source (Activity Spec §1–§4 + owner decisions D2–D8).
 * points = round(base × cefrMult × qualityMult × relativeMult).
 */
class ActivityPointsCalculatorTest {

    private final ActivityScoringProperties props = new ActivityScoringProperties();
    private final ActivityPointsCalculator calc = new ActivityPointsCalculator(props);

    private int pts(double base, Cefr cefr, double quality) {
        return calc.points(base, cefr == null ? 1.0 : calc.cefrMult(cefr), quality, 1.0);
    }

    @Test
    @DisplayName("CEFR and relative multipliers match the spec tables")
    void multipliers() {
        assertEquals(1.0, calc.cefrMult(Cefr.A1));
        assertEquals(1.2, calc.cefrMult(Cefr.A2));
        assertEquals(1.5, calc.cefrMult(Cefr.B1));
        assertEquals(1.8, calc.cefrMult(Cefr.B2));
        assertEquals(2.2, calc.cefrMult(Cefr.C1));
        assertEquals(2.6, calc.cefrMult(Cefr.C2));

        assertEquals(1.0, calc.relativeMult(Cefr.B2, Optional.empty()), "undetermined user");
        assertEquals(0.4, calc.relativeMult(Cefr.A1, Optional.of(Cefr.B1)));
        assertEquals(0.7, calc.relativeMult(Cefr.A2, Optional.of(Cefr.B1)));
        assertEquals(1.0, calc.relativeMult(Cefr.B1, Optional.of(Cefr.B1)));
        assertEquals(1.2, calc.relativeMult(Cefr.B2, Optional.of(Cefr.B1)));
        assertEquals(1.3, calc.relativeMult(Cefr.C2, Optional.of(Cefr.B1)));
        assertEquals(36, calc.points(20, 1.5, 1.0, 1.2));   // 20 × 1.5 × 1.0 × 1.2
        assertEquals(0, calc.points(0, 2.6, 1.0, 1.3));
    }

    @Test
    @DisplayName("FLASHCARD_REVIEW / NEW / MASTERED")
    void flashcards() {
        assertEquals(2, calc.flashcardReviewBase("good"));
        assertEquals(2, calc.flashcardReviewBase("easy"));
        assertEquals(1, calc.flashcardReviewBase("hard"));
        assertEquals(1, calc.flashcardReviewBase("khó"));
        assertEquals(0, calc.flashcardReviewBase("again"));
        assertEquals(0, calc.flashcardReviewBase("1"));
        assertEquals(3, pts(calc.flashcardReviewBase("good"), Cefr.B1, 1.0));   // 2 × 1.5
        assertEquals(5, pts(calc.flashcardReviewBase("easy"), Cefr.C2, 1.0));   // 2 × 2.6 = 5.2
        assertEquals(5, pts(3, Cefr.B1, 1.0));                                   // NEW: 3 × 1.5 = 4.5 → 5
        assertEquals(15, pts(10, Cefr.B1, 1.0));                                 // MASTERED: 10 × 1.5

        assertTrue(calc.isFirstStudy(1));
        assertFalse(calc.isFirstStudy(2));
        assertFalse(calc.earnsMasteredBonus("NEW", "MASTERED", 1), "D5: needs reviewCount >= 3");
        assertFalse(calc.earnsMasteredBonus("LEARNED", "MASTERED", 2));
        assertTrue(calc.earnsMasteredBonus("LEARNED", "MASTERED", 3));
        assertFalse(calc.earnsMasteredBonus("MASTERED", "MASTERED", 9), "already mastered");
    }

    @Test
    @DisplayName("CARD_BLAST_SOLO (hotfix): base = min(words × 2, 60); words = hits ≤ score/20 (proxy without hits); quality = 0.5 + 0.5 × accuracy")
    void cardBlastSolo() {
        assertEquals(30, calc.cardBlastSoloBase(300));            // proxy 15 words
        assertEquals(60, calc.cardBlastSoloBase(5000));           // capped
        assertEquals(0, calc.cardBlastSoloBase(null));
        assertEquals(0, calc.cardBlastSoloBase(-40));
        assertEquals(24, calc.cardBlastSoloBase(300, 12));        // reported hits
        assertEquals(30, calc.cardBlastSoloBase(300, 999));       // hits > score / 20 ⇒ clamped to 15
        assertEquals(0, calc.cardBlastSoloBase(300, -3));
        assertEquals(0, calc.cardBlastSoloBase(0, 10), "no score ⇒ no hits possible");
        assertEquals(60, calc.cardBlastSoloBase(100_000, 500));   // run cap
        assertEquals(0.9, calc.cardBlastSoloQuality(80.0), 1e-9);
        assertEquals(0.5, calc.cardBlastSoloQuality(null), 1e-9);
        assertEquals(1.0, calc.cardBlastSoloQuality(250.0), 1e-9);
        assertEquals(41, pts(calc.cardBlastSoloBase(300), Cefr.B1, calc.cardBlastSoloQuality(80.0))); // 30 × 1.5 × 0.9
        // the prod run that gave 1 point before (score 60 = 2 hits, accuracy 15 %): now 4 × 1.5 × 0.575 = 3.45 ⇒ 3
        assertEquals(3, pts(calc.cardBlastSoloBase(60, 2), Cefr.B1, calc.cardBlastSoloQuality(15.0)));
    }

    @Test
    @DisplayName("CARD_BLAST_PVP (D7): human 30/10/0, bot 15/5/0, rating quality 0.8–1.3")
    void pvp() {
        assertEquals(ActivityPointsCalculator.PvpOutcome.WIN, calc.pvpOutcome(7L, "7", "KO"));
        assertEquals(ActivityPointsCalculator.PvpOutcome.LOSS, calc.pvpOutcome(7L, "8", "KO"));
        assertEquals(ActivityPointsCalculator.PvpOutcome.LOSS, calc.pvpOutcome(7L, "DRAW", "WORDS_EXHAUSTED"));
        assertEquals(ActivityPointsCalculator.PvpOutcome.FORFEIT, calc.pvpOutcome(7L, "8", "FORFEIT"));
        assertEquals(ActivityPointsCalculator.PvpOutcome.WIN, calc.pvpOutcome(8L, "8", "FORFEIT"));

        assertEquals(30, calc.pvpBase(false, ActivityPointsCalculator.PvpOutcome.WIN));
        assertEquals(10, calc.pvpBase(false, ActivityPointsCalculator.PvpOutcome.LOSS));
        assertEquals(0, calc.pvpBase(false, ActivityPointsCalculator.PvpOutcome.FORFEIT));
        assertEquals(15, calc.pvpBase(true, ActivityPointsCalculator.PvpOutcome.WIN));
        assertEquals(5, calc.pvpBase(true, ActivityPointsCalculator.PvpOutcome.LOSS));
        assertEquals(0, calc.pvpBase(true, ActivityPointsCalculator.PvpOutcome.FORFEIT));

        assertEquals(1.0, calc.pvpQuality(false, null, 1200));
        assertEquals(1.0, calc.pvpQuality(true, 1000, 1400), "bot ⇒ 1.0");
        assertEquals(1.25, calc.pvpQuality(false, 1000, 1200), 1e-9);
        assertEquals(1.3, calc.pvpQuality(false, 1000, 2000), 1e-9);
        assertEquals(0.8, calc.pvpQuality(false, 2000, 1000), 1e-9);
        // Phase 1.1 instant-forfeit rule (HUMAN only, FORFEIT only, < 60 s; unknown duration = instant)
        assertTrue(calc.isInstantForfeit(false, "FORFEIT", 30_000L));
        assertTrue(calc.isInstantForfeit(false, "FORFEIT", null));
        assertFalse(calc.isInstantForfeit(false, "FORFEIT", 60_000L));
        assertFalse(calc.isInstantForfeit(false, "FORFEIT", 90_000L));
        assertFalse(calc.isInstantForfeit(false, "KO", 5_000L));
        assertFalse(calc.isInstantForfeit(false, "WORDS_EXHAUSTED", 5_000L));
        assertFalse(calc.isInstantForfeit(true, "FORFEIT", 5_000L), "BOT unchanged");

        assertEquals(56, pts(30, Cefr.B1, 1.25));  // 30 × 1.5 × 1.25 = 56.25
        assertEquals(23, pts(15, Cefr.B1, 1.0));   // bot win: 22.5 → 23
    }

    @Test
    @DisplayName("DICTATION: 20 × (accuracy)², retries 100 % / 30 % / 0")
    void dictation() {
        assertEquals(1.0, calc.dictationRetryFactor(1));
        assertEquals(0.3, calc.dictationRetryFactor(2));
        assertEquals(0.3, calc.dictationRetryFactor(3));
        assertEquals(0.0, calc.dictationRetryFactor(4));
        assertEquals(0.81, calc.dictationQuality(90.0), 1e-9);
        assertEquals(24, pts(20 * calc.dictationRetryFactor(1), Cefr.B1, calc.dictationQuality(90.0))); // 24.3
        assertEquals(9, pts(20 * calc.dictationRetryFactor(2), Cefr.B1, calc.dictationQuality(100.0))); // 6 × 1.5
        assertEquals(0, pts(20 * calc.dictationRetryFactor(4), Cefr.B1, 1.0));
    }

    @Test
    @DisplayName("SHADOWING 10 × pron/100; ROLEPLAY 15 × fluency/100 (none = 1.0)")
    void speaking() {
        assertEquals(12, pts(10, Cefr.B1, calc.shadowingQuality(80.0)));   // 10 × 1.5 × 0.8
        assertEquals(1.0, calc.roleplayQuality(null));
        assertEquals(16, pts(15, Cefr.A2, calc.roleplayQuality(90.0)));    // 15 × 1.2 × 0.9 = 16.2
        assertEquals(18, pts(15, Cefr.A2, calc.roleplayQuality(null)));    // 15 × 1.2
    }

    @Test
    @DisplayName("WRITING (D3, Activity only): T1 40 / T2 60 / other 40, quality = clamp((score/100·9 − 3)/6)")
    void writing() {
        assertEquals(40, calc.writingBase("ielts-t1-line-01"));
        assertEquals(60, calc.writingBase("ielts-t2-opinion-03"));
        assertEquals(40, calc.writingBase("toeic-email-01"));
        assertEquals(40, calc.writingBase(null));
        assertEquals(0.0, calc.writingQuality(30), 1e-9);        // band 2.7 → clamp 0
        assertEquals(0.49, calc.writingQuality(66), 1e-9);       // band 5.94 → 0.49
        assertEquals(1.0, calc.writingQuality(100), 1e-9);       // band 9
        assertEquals(44, pts(60, Cefr.B1, calc.writingQuality(66))); // 60 × 1.5 × 0.49 = 44.1
    }

    @Test
    @DisplayName("EXAMS (D8): 300 × overall% (full simulation), 50 × skill% (practice); cefr = 1.0")
    void exams() {
        assertTrue(calc.isFullExamScope("FULL", "ACADEMIC"));
        assertTrue(calc.isFullExamScope("LISTENING", "FULL_MOCK"));
        assertFalse(calc.isFullExamScope("READING", "ACADEMIC"));
        assertEquals(Optional.of(9.0), calc.examScaleMax("IELTS", ScoreMetric.FULL_OVERALL));
        assertEquals(Optional.of(495.0), calc.examScaleMax("TOEIC", ScoreMetric.LISTENING));
        assertEquals(Optional.of(200.0), calc.examScaleMax("TOEIC", ScoreMetric.WRITING));
        assertEquals(Optional.of(990.0), calc.examScaleMax("TOEIC", ScoreMetric.LR_TOTAL));
        assertEquals(Optional.empty(), calc.examScaleMax("TOEIC", ScoreMetric.FULL_OVERALL));
        assertEquals(200, pts(300, null, calc.examQuality(6.0, 9.0)));     // IELTS 6.0 overall
        assertEquals(212, pts(300, null, calc.examQuality(700, 990)));     // TOEIC 700 → 212.12
        assertEquals(39, pts(50, null, calc.examQuality(7.0, 9.0)));       // 38.89
    }

    @Test
    @DisplayName("Daily point cap: eligible = clamp(raw, 0, cap − already)")
    void pointCap() {
        assertEquals(10, ActivityPointsCalculator.eligibleUnderPointCap(10, 100, 150));
        assertEquals(5, ActivityPointsCalculator.eligibleUnderPointCap(10, 145, 150));
        assertEquals(0, ActivityPointsCalculator.eligibleUnderPointCap(10, 150, 150));
        assertEquals(0, ActivityPointsCalculator.eligibleUnderPointCap(10, 170, 150));
    }

    @Test
    @DisplayName("Cefr.parse is lenient but never guesses")
    void cefrParse() {
        assertEquals(Optional.of(Cefr.B1), Cefr.parse("b1"));
        assertEquals(Optional.of(Cefr.C1), Cefr.parse("C1 Advanced"));
        assertEquals(Optional.empty(), Cefr.parse(""));
        assertEquals(Optional.empty(), Cefr.parse("Intermediate"));
        assertEquals(Optional.empty(), Cefr.parse(null));
    }

    @Test
    @DisplayName("start-at parsing: ISO instant, offset date-time, blank and invalid")
    void startAtParsing() {
        ActivityScoringProperties p = new ActivityScoringProperties();
        assertNull(p.startAtInstant());
        p.setStartAt(" ");
        assertNull(p.startAtInstant());
        p.setStartAt("not-a-date");
        assertNull(p.startAtInstant());
        p.setStartAt("2026-10-01T10:00:00+07:00");
        assertEquals(java.time.Instant.parse("2026-10-01T03:00:00Z"), p.startAtInstant());
        p.setStartAt("2026-10-01T03:00:00Z");
        assertEquals(java.time.Instant.parse("2026-10-01T03:00:00Z"), p.startAtInstant());
    }
}
