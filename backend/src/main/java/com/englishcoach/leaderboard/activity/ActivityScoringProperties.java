package com.englishcoach.leaderboard.activity;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;

/**
 * Activity Points configuration ({@code app.leaderboard.activity.*}). Defaults = Activity Spec
 * plus owner decisions D2–D8 (see features/leaderboard.md).
 */
@Data
@Configuration
@ConfigurationProperties(prefix = "app.leaderboard.activity")
public class ActivityScoringProperties {

    /** Master switch for recording score events. */
    private boolean enabled = true;

    /**
     * leaderboard_activity_start_at (ISO-8601, env APP_LEADERBOARD_ACTIVITY_START_AT), e.g.
     * {@code 2026-10-01T03:00:00Z} or {@code 2026-10-01T10:00:00+07:00}. Events occurring before it
     * are ignored. Unset, blank or unparseable = nothing is recorded. Kept as a String so an empty
     * env value can never fail application startup.
     */
    private String startAt;

    /** Parsed {@link #startAt}; null when unset or invalid. */
    public Instant startAtInstant() {
        if (startAt == null || startAt.isBlank()) {
            return null;
        }
        String s = startAt.trim();
        try {
            return Instant.parse(s);
        } catch (DateTimeParseException ignored) {
            try {
                return OffsetDateTime.parse(s).toInstant();
            } catch (DateTimeParseException ex) {
                return null;
            }
        }
    }

    /** Business time zone for daily caps (weeks start Monday 00:00 in this zone). */
    private String timeZone = "Asia/Ho_Chi_Minh";

    private CefrMult cefrMult = new CefrMult();
    private RelativeMult relativeMult = new RelativeMult();
    private Streak streak = new Streak();
    private Flashcard flashcard = new Flashcard();
    private CardBlastSolo cardBlastSolo = new CardBlastSolo();
    private Pvp pvp = new Pvp();
    private Dictation dictation = new Dictation();
    private ListeningWatch listeningWatch = new ListeningWatch();
    private Shadowing shadowing = new Shadowing();
    private Roleplay roleplay = new Roleplay();
    private Reading reading = new Reading();
    private Writing writing = new Writing();
    private Exam exam = new Exam();

    /** Content CEFR multiplier (Spec §2) and Activity-only fallbacks for unlabeled content. */
    @Data
    public static class CefrMult {
        private double a1 = 1.0;
        private double a2 = 1.2;
        private double b1 = 1.5;
        private double b2 = 1.8;
        private double c1 = 2.2;
        private double c2 = 2.6;
        private Cefr defaultCefr = Cefr.B1;
        private Cefr rssDefaultCefr = Cefr.B2;
    }

    /** Relative level multiplier by delta = content step − user step (Spec §3). */
    @Data
    public static class RelativeMult {
        private double minus2OrLess = 0.4;
        private double minus1 = 0.7;
        private double same = 1.0;
        private double plus1 = 1.2;
        private double plus2OrMore = 1.3;
        private double undetermined = 1.0;
    }

    /** Applied at daily aggregation (Phase 3 rollup), never on single events. */
    @Data
    public static class Streak {
        private double stepPerDay = 0.005;
        private int maxDays = 30;
    }

    @Data
    public static class Flashcard {
        private int reviewGoodEasy = 2;
        private int reviewHard = 1;
        private int reviewAgain = 0;
        private int newCard = 3;
        private int mastered = 10;
        /** D5: MASTERED bonus only when reviewCount >= this at the moment of mastery. */
        private int masteredMinReviewCount = 3;
        /** D5: shared by REVIEW, NEW and MASTERED. */
        private int dailyCap = 150;
        /** NOT RUN: answer time is not measured by the flashcard module. */
        private long minAnswerMs = 1500;
    }

    @Data
    public static class CardBlastSolo {
        /**
         * Hotfix 2026-10-02: base = min(words × pointsPerWord, maxBasePerRun). words = reported hits, clamped to
         * floor(score / scorePerWord) (every hit adds ≥ 20 score in the game, so more hits than that is impossible);
         * runs without hit counts (older clients, backfill) use the D2 proxy round(score / scorePerWord).
         */
        private int scorePerWord = 20;
        private int pointsPerWord = 2;
        private int maxBasePerRun = 60;
        /** Words above this per run are ignored (anti-farming; also bounds the proxy). */
        private int maxWordsPerRun = 60;
        /**
         * qualityMult = floor + (1 − floor) × accuracy. Solo runs always end with missed (fallen) words, so raw accuracy
         * alone (the old multiplier) turned short runs into ~0–1 point.
         */
        private double qualityFloor = 0.5;
        /** Phase 3 rollup: top N runs per day, then cap. */
        private int topRunsPerDay = 3;
        private int dailyCap = 100;
    }

    @Data
    public static class Pvp {
        private int humanWin = 30;
        private int humanLoss = 10;
        /** D7: BOT matches — win 15, loss 5, forfeit 0, quality 1.0. */
        private int botWin = 15;
        private int botLoss = 5;
        /** HUMAN and BOT share this limit. */
        private int maxMatchesPerDay = 10;
        private int maxMatchesPerOpponentPerDay = 3;
        /**
         * Phase 1.1 anti-collusion: a HUMAN match ending in FORFEIT before this duration gives
         * BOTH players 0 (rows are still written and still count toward the match limits).
         */
        private long minForfeitDurationMs = 60_000L;
        /** quality = clamp(1 + (oppRating − myRating) / divisor, min, max). */
        private double ratingDivisor = 800.0;
        private double qualityMin = 0.8;
        private double qualityMax = 1.3;
    }

    @Data
    public static class Dictation {
        private int base = 20;
        private double firstAttemptFactor = 1.0;
        private double retryFactor = 0.3;
        /** Attempts 2..retryMaxAttempt get retryFactor; later attempts get 0. */
        private int retryMaxAttempt = 3;
        private int dailyCap = 120;
    }

    /** NOT RUN in Phase 1 (no watch-progress data). */
    @Data
    public static class ListeningWatch {
        private int base = 5;
        private int dailyCap = 20;
    }

    @Data
    public static class Shadowing {
        private int base = 10;
        private int dailyCap = 100;
    }

    @Data
    public static class Roleplay {
        private int base = 15;
        private int minLearnerTurns = 6;
        private int maxSessionsPerDay = 3;
    }

    /** NOT RUN in Phase 1 (no finished-article signal). */
    @Data
    public static class Reading {
        private int base = 15;
        private int wordsPerMinute = 400;
        private int dailyCap = 45;
    }

    @Data
    public static class Writing {
        private int task1Base = 40;
        private int task2Base = 60;
        /** TOEIC / General tasks (D3). */
        private int otherBase = 40;
        /** D3 (Activity only): pseudoBand = score / 100 × 9; quality = clamp((pseudoBand − offset) / range). */
        private double bandOffset = 3.0;
        private double bandRange = 6.0;
        private int maxSubmissionsPerDay = 2;
    }

    @Data
    public static class Exam {
        private int simulationBase = 300;
        private int practiceBase = 50;
        private int practiceDailyCap = 200;
    }
}
