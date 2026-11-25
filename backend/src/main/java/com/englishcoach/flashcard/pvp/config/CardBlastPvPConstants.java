package com.englishcoach.flashcard.pvp.config;

public final class CardBlastPvPConstants {

    private CardBlastPvPConstants() {
    }

    // Match Engine & Gameplay
    public static final int STARTING_HP = 100;
    public static final int MAX_HP = 100;
    public static final int MISS_DAMAGE_HP = 12;
    public static final int HIT_GAIN_HP = 12;
    public static final int BASE_SCORE_PER_HIT = 20;
    public static final int MAX_WORDS_PER_MATCH = 60;
    public static final int NUM_LANES = 4;

    // Timing Constants
    public static final long COUNTDOWN_DURATION_MS = 3500L;
    public static final long TICK_INTERVAL_MS = 100L;
    public static final long HIT_GRACE_WINDOW_MS = 400L;
    public static final long ANTI_MACRO_MS_PER_CHAR = 40L;
    public static final long DISCONNECT_GRACE_PERIOD_MS = 15_000L; // 15 seconds
    public static final long WAITING_DISCONNECT_GRACE_PERIOD_MS = 60_000L; // 60 seconds grace period in waiting room

    // Schedule Progression & Single-player Calibration
    public static final long INITIAL_SPAWN_DELAY_MS = 1000L;
    public static final long INITIAL_INTERVAL_MS = 2400L;
    public static final long MIN_INTERVAL_MS = 1600L;
    public static final long INTERVAL_DECREASE_PER_WORD_MS = 15L;
    public static final long INITIAL_FALL_DURATION_MS = 10000L;
    public static final long MIN_FALL_DURATION_MS = 5000L;
    public static final long FALL_DURATION_DECREASE_PER_WORD_MS = 50L;

    // Single-Player Mirrored Difficulty & Speed Multipliers (from CardBlastEngine.tsx)
    // Letter hint mask logic: Easy 2 letters, Normal 1 letter, Hard 0 letters
    public static final int HINT_LETTERS_EASY = 2;
    public static final int HINT_LETTERS_NORMAL = 1;
    public static final int HINT_LETTERS_HARD = 0;

    public static final double SPEED_MULT_EASY = 0.9;
    public static final double SPEED_MULT_NORMAL = 1.3;
    public static final double SPEED_MULT_HARD = 1.8;

    public static final long BASE_INTERVAL_EASY_MS = 3200L;
    public static final long BASE_INTERVAL_NORMAL_MS = 2400L;
    public static final long BASE_INTERVAL_HARD_MS = 1700L;

    public static final double SPEED_FACTOR_BASE = 0.60;
    public static final double SPEED_FACTOR_STEP = 0.22; // Level 1: 0.60, Level 2: 0.82, Level 3: 1.04, Level 4: 1.26, Level 5: 1.48

    // Calibrated Spawn Gap Constants (Max 2-3 words on screen concurrently)
    // Speed 1 (fallDuration ~18500ms): spawnGap 8000ms -> 7000ms (strictly 2, max 3 words)
    // Speed 2 (fallDuration ~14000ms): spawnGap 6500ms -> 5500ms (max 2-3 words)
    // Speed 3 (fallDuration ~11000ms): spawnGap 4500ms -> 4000ms (max 3 words)
    // Speed 4 (fallDuration ~8000ms): spawnGap 3200ms -> 2800ms (max 3-4 words)
    // Speed 5 (fallDuration ~5500ms): spawnGap 2200ms -> 1800ms (max 3-4 words)
    public static final long SPAWN_GAP_SPEED_1_INITIAL_MS = 8000L;
    public static final long SPAWN_GAP_SPEED_1_MIN_MS = 7000L;
    public static final long SPAWN_GAP_SPEED_2_INITIAL_MS = 6500L;
    public static final long SPAWN_GAP_SPEED_2_MIN_MS = 5500L;
    public static final long SPAWN_GAP_SPEED_3_INITIAL_MS = 4500L;
    public static final long SPAWN_GAP_SPEED_3_MIN_MS = 4000L;
    public static final long SPAWN_GAP_SPEED_4_INITIAL_MS = 3200L;
    public static final long SPAWN_GAP_SPEED_4_MIN_MS = 2800L;
    public static final long SPAWN_GAP_SPEED_5_INITIAL_MS = 2200L;
    public static final long SPAWN_GAP_SPEED_5_MIN_MS = 1800L;

    // Room Limits & Cleanup
    public static final int MAX_ACTIVE_ROOMS = 200;
    public static final long WAITING_IDLE_PURGE_MS = 10 * 60 * 1000L; // 10 minutes
    public static final long FINISHED_PURGE_MS = 5 * 60 * 1000L;      // 5 minutes
    public static final long DISCONNECTED_PURGE_MS = 2 * 60 * 1000L;  // 2 minutes

    // Rate Limiting
    public static final int MAX_MESSAGES_PER_SECOND_PER_SESSION = 30;
    /**
     * Echo Quiz Rush commands (`/app/quiz-rush/*`) have their own per-session budget: its service already limits each
     * account to 40 movement leases and 24 other commands a second, and a held key, a change of keys, a jump, a ping and an
     * answer used to share the 30 above, so a legitimate lease or answer was dropped without a word (Codex audit 2026-10-25).
     */
    public static final int MAX_QUIZ_RUSH_MESSAGES_PER_SECOND_PER_SESSION = 64;

    // Bot Echo Constants
    public static final long BOT_MIN_THINK_MS = 600L;
    public static final long BOT_MAX_THINK_MS = 1100L;
    public static final long BOT_MIN_MS_PER_CHAR = 90L;
    public static final long BOT_MAX_MS_PER_CHAR = 140L;
    public static final double BOT_MAX_FALL_RATIO = 0.90;

    // Bot Echo Constants by Difficulty (Task 2)
    public static final double BOT_EASY_HIT_PROBABILITY = 0.55;
    public static final double BOT_NORMAL_HIT_PROBABILITY = 0.78;
    public static final double BOT_HARD_HIT_PROBABILITY = 0.92;

    public static final long BOT_EASY_MIN_THINK_MS = 3500L;
    public static final long BOT_EASY_MAX_THINK_MS = 5500L;
    public static final long BOT_EASY_MS_PER_CHAR = 120L;

    public static final long BOT_NORMAL_MIN_THINK_MS = 1600L;
    public static final long BOT_NORMAL_MAX_THINK_MS = 2600L;
    public static final long BOT_NORMAL_MS_PER_CHAR = 80L;

    public static final long BOT_HARD_MIN_THINK_MS = 800L;
    public static final long BOT_HARD_MAX_THINK_MS = 1300L;
    public static final long BOT_HARD_MS_PER_CHAR = 45L;

    // Bot Golden Word Contestation Delays by Difficulty (Task 2)
    public static final long BOT_GOLDEN_EASY_MIN_DELAY_MS = 7500L;
    public static final long BOT_GOLDEN_EASY_MAX_DELAY_MS = 9500L;
    public static final double BOT_GOLDEN_EASY_HIT_PROBABILITY = 0.50;

    public static final long BOT_GOLDEN_NORMAL_MIN_DELAY_MS = 4500L;
    public static final long BOT_GOLDEN_NORMAL_MAX_DELAY_MS = 6000L;

    public static final long BOT_GOLDEN_HARD_MIN_DELAY_MS = 2500L;
    public static final long BOT_GOLDEN_HARD_MAX_DELAY_MS = 3500L;

    // Phase 2 Combat & Attacks (Streak Milestone lowered to 3)
    public static final int ATTACK_STREAK_MILESTONE = 3;
    public static final long TELEGRAPH_DURATION_MS = 2000L;
    public static final double GARBAGE_SPEED_MULTIPLIER = 0.8; // 1.25x faster
    public static final int MAX_PENDING_AND_ACTIVE_GARBAGE = 3;

    // Golden Word Contestation (First at T+18s, every 18s thereafter)
    public static final long FIRST_GOLDEN_WORD_MS = 18_000L;
    public static final long GOLDEN_WORD_INTERVAL_MS = 18_000L; // every 18s thereafter
    public static final long GOLDEN_WORD_EXCLUDE_TAIL_MS = 10_000L; // exclude last 10s
    public static final double GOLDEN_WORD_SPEED_MULTIPLIER = 1.2; // falls 20% slower
    public static final int GOLDEN_WORD_SCORE_MULTIPLIER = 3;

    // Last Stand & Sudden Death
    public static final int LAST_STAND_HP_THRESHOLD = 30; // HP <= 30%
    public static final int LAST_STAND_GARBAGE_CAP = 1;
    public static final double LAST_STAND_GARBAGE_SPEED_MULTIPLIER = 1.0; // penalty removed
    public static final long SUDDEN_DEATH_ELAPSED_MS = 180_000L; // >= 180s (3 full minutes)
    public static final int SUDDEN_DEATH_DAMAGE_MULTIPLIER = 2; // 2x miss damage

    // Phase 3 Tactical Skills & Mana System
    public static final int STARTING_MANA = 0;
    public static final int MAX_MANA = 100;
    public static final int BASE_MANA_GAIN_PER_HIT = 10;
    public static final int LAST_STAND_MANA_GAIN_PER_HIT = 20;

    public static final String SKILL_ECHO_CHAIN = "ECHO_CHAIN";
    public static final String SKILL_SLOW_MO = "SLOW_MO";
    public static final String SKILL_EMP_BLAST = "EMP_BLAST";
    public static final String SKILL_FOG = "FOG";
    public static final String SKILL_SHIELD = "SHIELD";

    public static final int SKILL_ECHO_CHAIN_COST = 40;
    public static final int SKILL_SLOW_MO_COST = 50;
    public static final long SKILL_SLOW_MO_BONUS_MS = 5000L;
    public static final int SKILL_EMP_BLAST_COST = 80;
    public static final int SKILL_FOG_COST = 50;
    public static final long SKILL_FOG_DURATION_MS = 5000L;
    public static final int SKILL_SHIELD_COST = 35;
    public static final long SKILL_SHIELD_DURATION_MS = 8000L;

    public static final java.util.Set<String> ALL_SKILLS = java.util.Set.of(
            SKILL_ECHO_CHAIN, SKILL_SLOW_MO, SKILL_EMP_BLAST, SKILL_FOG, SKILL_SHIELD
    );
    public static final java.util.Set<String> VALID_SKILLS = ALL_SKILLS;
    public static final java.util.List<String> DEFAULT_SKILLS = java.util.List.of(
            SKILL_ECHO_CHAIN, SKILL_SLOW_MO, SKILL_EMP_BLAST
    );

    public static final int MANA_GAIN_NORMAL = BASE_MANA_GAIN_PER_HIT;
    public static final int MANA_GAIN_LAST_STAND = LAST_STAND_MANA_GAIN_PER_HIT;

    public static int getSkillCost(String skillId) {
        if (skillId == null) return Integer.MAX_VALUE;
        switch (skillId.trim().toUpperCase()) {
            case SKILL_ECHO_CHAIN: return SKILL_ECHO_CHAIN_COST;
            case SKILL_SLOW_MO: return SKILL_SLOW_MO_COST;
            case SKILL_EMP_BLAST: return SKILL_EMP_BLAST_COST;
            case SKILL_FOG: return SKILL_FOG_COST;
            case SKILL_SHIELD: return SKILL_SHIELD_COST;
            default: return Integer.MAX_VALUE;
        }
    }

    // Phase 3 Elo Rating System
    public static final int ELO_START_RATING = 1000;
    public static final int DEFAULT_ELO_RATING = ELO_START_RATING;
    public static final int ELO_K_FACTOR = 32;
    public static final long ELO_MIN_DURATION_MS = 30_000L; // >= 30 seconds
    public static final long MIN_RANKED_MATCH_DURATION_MS = ELO_MIN_DURATION_MS;
    public static final int ELO_MAX_RANKED_MATCHES_PER_PAIR_24H = 5;
    public static final int MAX_RANKED_MATCHES_PER_PAIR_24H = ELO_MAX_RANKED_MATCHES_PER_PAIR_24H;

    // Whale Reactions
    public static final long REACTION_RATE_LIMIT_MS = 1500L; // 1.5s per player
    public static final java.util.Set<String> REACTION_WHITELIST = java.util.Set.of("GG", "NICE", "OOPS", "FIRE");
}
