package com.englishcoach.leaderboard.activity;

import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Locale;
import java.util.Optional;

/**
 * Pure Activity Points formulas (Activity Spec §1–§4 + owner decisions). No I/O.
 * points = round(base × cefrMult × qualityMult × relativeMult).
 */
@Component
@RequiredArgsConstructor
public class ActivityPointsCalculator {

    private final ActivityScoringProperties props;

    public int points(double base, double cefrMult, double qualityMult, double relativeMult) {
        double value = base * cefrMult * qualityMult * relativeMult;
        return value <= 0 ? 0 : (int) Math.round(value);
    }

    public double cefrMult(Cefr cefr) {
        ActivityScoringProperties.CefrMult m = props.getCefrMult();
        if (cefr == null) {
            return 1.0;
        }
        return switch (cefr) {
            case A1 -> m.getA1();
            case A2 -> m.getA2();
            case B1 -> m.getB1();
            case B2 -> m.getB2();
            case C1 -> m.getC1();
            case C2 -> m.getC2();
        };
    }

    public double relativeMult(Cefr content, Optional<Cefr> userLevel) {
        ActivityScoringProperties.RelativeMult m = props.getRelativeMult();
        if (content == null || userLevel == null || userLevel.isEmpty()) {
            return m.getUndetermined();
        }
        int delta = content.step() - userLevel.get().step();
        if (delta <= -2) return m.getMinus2OrLess();
        if (delta == -1) return m.getMinus1();
        if (delta == 0) return m.getSame();
        if (delta == 1) return m.getPlus1();
        return m.getPlus2OrMore();
    }

    public static double clamp01(double v) {
        if (Double.isNaN(v)) return 0.0;
        return Math.max(0.0, Math.min(1.0, v));
    }

    // ---- Flashcards -------------------------------------------------------------------------

    /** Good/Easy 2, Hard 1, Again 0; unknown quality strings score 0. */
    public int flashcardReviewBase(String quality) {
        ActivityScoringProperties.Flashcard f = props.getFlashcard();
        String q = quality == null ? "" : quality.trim().toLowerCase(Locale.ROOT);
        return switch (q) {
            case "good", "tot", "tốt", "3", "easy", "de", "dễ", "4" -> f.getReviewGoodEasy();
            case "hard", "kho", "khó", "2" -> f.getReviewHard();
            default -> f.getReviewAgain();
        };
    }

    public boolean isFirstStudy(Integer reviewCount) {
        return reviewCount != null && reviewCount == 1;
    }

    /** D5: became MASTERED in this review AND reviewCount >= masteredMinReviewCount. */
    public boolean earnsMasteredBonus(String previousStatus, String newStatus, Integer reviewCount) {
        return !"MASTERED".equals(previousStatus)
                && "MASTERED".equals(newStatus)
                && reviewCount != null
                && reviewCount >= props.getFlashcard().getMasteredMinReviewCount();
    }

    // ---- Card Blast solo (D2) ---------------------------------------------------------------

    /** Run without hit counts: words from the score proxy. */
    public int cardBlastSoloBase(Integer score) {
        return cardBlastSoloBase(score, null);
    }

    /**
     * base = min(words × pointsPerWord, maxBasePerRun). words = reported hits clamped to [0, floor(score / scorePerWord)]
     * and maxWordsPerRun; without hits the proxy round(score / scorePerWord) (capped the same way).
     */
    public int cardBlastSoloBase(Integer score, Integer hits) {
        ActivityScoringProperties.CardBlastSolo c = props.getCardBlastSolo();
        if (score == null || score <= 0) return 0;
        long maxByScore = score / c.getScorePerWord();
        long words = hits == null ? Math.round(score / (double) c.getScorePerWord())
                : Math.min(Math.max(0, hits), maxByScore);
        words = Math.min(words, c.getMaxWordsPerRun());
        return (int) Math.min(words * c.getPointsPerWord(), c.getMaxBasePerRun());
    }

    /** floor + (1 − floor) × accuracy/100; no accuracy ⇒ the floor. */
    public double cardBlastSoloQuality(Double accuracyPct) {
        double floor = clamp01(props.getCardBlastSolo().getQualityFloor());
        double acc = accuracyPct == null ? 0.0 : clamp01(accuracyPct / 100.0);
        return floor + (1.0 - floor) * acc;
    }

    // ---- Card Blast PvP (D7) ----------------------------------------------------------------

    public enum PvpOutcome { WIN, LOSS, FORFEIT }

    public PvpOutcome pvpOutcome(Long playerId, String winnerId, String endReason) {
        if (playerId != null && winnerId != null && winnerId.equals(String.valueOf(playerId))) {
            return PvpOutcome.WIN;
        }
        boolean draw = "DRAW".equals(winnerId);
        if (!draw && "FORFEIT".equals(endReason)) {
            return PvpOutcome.FORFEIT;
        }
        // D7: a draw counts as a loss.
        return PvpOutcome.LOSS;
    }

    public int pvpBase(boolean botMatch, PvpOutcome outcome) {
        ActivityScoringProperties.Pvp p = props.getPvp();
        return switch (outcome) {
            case WIN -> botMatch ? p.getBotWin() : p.getHumanWin();
            case LOSS -> botMatch ? p.getBotLoss() : p.getHumanLoss();
            case FORFEIT -> 0;
        };
    }

    /**
     * Phase 1.1: HUMAN match that ended in FORFEIT before {@code minForfeitDurationMs} ⇒ both
     * players score 0. Unknown duration counts as instant. BOT matches and KO / WORDS_EXHAUSTED
     * endings are never affected.
     */
    public boolean isInstantForfeit(boolean botMatch, String endReason, Long durationMs) {
        return !botMatch
                && "FORFEIT".equals(endReason)
                && (durationMs == null || durationMs < props.getPvp().getMinForfeitDurationMs());
    }

    /** Opponent-rating quality for HUMAN matches; any missing rating ⇒ 1.0. BOT ⇒ 1.0. */
    public double pvpQuality(boolean botMatch, Integer myRating, Integer opponentRating) {
        ActivityScoringProperties.Pvp p = props.getPvp();
        if (botMatch || myRating == null || opponentRating == null) {
            return 1.0;
        }
        double q = 1.0 + (opponentRating - myRating) / p.getRatingDivisor();
        return Math.max(p.getQualityMin(), Math.min(p.getQualityMax(), q));
    }

    // ---- Dictation --------------------------------------------------------------------------

    /** 1st attempt 100 %, attempts 2..retryMaxAttempt 30 %, later attempts 0. */
    public double dictationRetryFactor(long attemptNo) {
        ActivityScoringProperties.Dictation d = props.getDictation();
        if (attemptNo <= 1) return d.getFirstAttemptFactor();
        if (attemptNo <= d.getRetryMaxAttempt()) return d.getRetryFactor();
        return 0.0;
    }

    public double dictationQuality(Double accuracyPct) {
        if (accuracyPct == null) return 0.0;
        double a = clamp01(accuracyPct / 100.0);
        return a * a;
    }

    // ---- Speaking ---------------------------------------------------------------------------

    public double shadowingQuality(Double pronunciationScore) {
        return pronunciationScore == null ? 0.0 : clamp01(pronunciationScore / 100.0);
    }

    /** Average learner fluency / 100; no fluency data ⇒ 1.0. */
    public double roleplayQuality(Double averageFluency) {
        return averageFluency == null ? 1.0 : clamp01(averageFluency / 100.0);
    }

    // ---- Writing (D3, Activity only — never reuse for Proficiency) --------------------------

    public int writingBase(String taskId) {
        ActivityScoringProperties.Writing w = props.getWriting();
        String id = taskId == null ? "" : taskId.toLowerCase(Locale.ROOT);
        if (id.startsWith("ielts-t1-")) return w.getTask1Base();
        if (id.startsWith("ielts-t2-")) return w.getTask2Base();
        return w.getOtherBase();
    }

    public double writingQuality(Integer overallScore0to100) {
        if (overallScore0to100 == null) return 0.0;
        ActivityScoringProperties.Writing w = props.getWriting();
        double pseudoBand = overallScore0to100 / 100.0 * 9.0;
        return clamp01((pseudoBand - w.getBandOffset()) / w.getBandRange());
    }

    // ---- Exams (D8) -------------------------------------------------------------------------

    public boolean isFullExamScope(String scope, String variant) {
        String s = scope == null ? "" : scope.toUpperCase(Locale.ROOT);
        String v = variant == null ? "" : variant.toUpperCase(Locale.ROOT);
        return "FULL".equals(s) || "FULL_MOCK".equals(s) || v.contains("FULL");
    }

    /** Official scale maximum of a metric, or empty when the metric has no known scale. */
    public Optional<Double> examScaleMax(String family, ScoreMetric metric) {
        boolean toeic = "TOEIC".equalsIgnoreCase(family);
        if (metric == null) return Optional.empty();
        if (!toeic) {
            return metric == ScoreMetric.LR_TOTAL ? Optional.empty() : Optional.of(9.0);
        }
        return switch (metric) {
            case LISTENING, READING -> Optional.of(495.0);
            case WRITING, SPEAKING -> Optional.of(200.0);
            case LR_TOTAL -> Optional.of(990.0);
            case FULL_OVERALL -> Optional.empty();
        };
    }

    public double examQuality(double scaledScore, double scaleMax) {
        return scaleMax <= 0 ? 0.0 : clamp01(scaledScore / scaleMax);
    }

    // ---- Daily point cap --------------------------------------------------------------------

    /** eligible = clamp(raw, 0, cap − alreadyEligibleToday). */
    public static int eligibleUnderPointCap(int raw, long alreadyEligibleToday, int dailyCap) {
        long remaining = Math.max(0L, dailyCap - alreadyEligibleToday);
        return (int) Math.min(Math.max(raw, 0), remaining);
    }
}
