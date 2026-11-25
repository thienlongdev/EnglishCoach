package com.englishcoach.leaderboard.activity;

import java.util.Locale;
import java.util.Optional;

/**
 * CEFR scale used by the Activity engine (content level and user level).
 */
public enum Cefr {
    A1, A2, B1, B2, C1, C2;

    public int step() {
        return ordinal();
    }

    /**
     * Lenient parse of a stored label ("b1", "B1+", "C1 Advanced" → B1/B1/C1).
     * Returns empty for null, blank or unknown labels — never guesses.
     */
    public static Optional<Cefr> parse(String raw) {
        if (raw == null) {
            return Optional.empty();
        }
        String s = raw.trim().toUpperCase(Locale.ROOT);
        if (s.length() < 2) {
            return Optional.empty();
        }
        try {
            return Optional.of(Cefr.valueOf(s.substring(0, 2)));
        } catch (IllegalArgumentException ex) {
            return Optional.empty();
        }
    }
}
