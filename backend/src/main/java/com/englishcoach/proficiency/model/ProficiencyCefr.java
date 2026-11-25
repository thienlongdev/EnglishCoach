package com.englishcoach.proficiency.model;

import java.util.Locale;
import java.util.Optional;

/**
 * Proficiency CEFR scale on the 0–1000 rating axis (Proficiency Spec §1). Separate from the
 * Activity {@code Cefr} enum on purpose (hard pipeline separation).
 */
public enum ProficiencyCefr {
    A1(0, 166),
    A2(167, 333),
    B1(334, 499),
    B2(500, 666),
    C1(667, 833),
    C2(834, 1000);

    private final int lo;
    private final int hi;

    ProficiencyCefr(int lo, int hi) {
        this.lo = lo;
        this.hi = hi;
    }

    public int lo() {
        return lo;
    }

    public int hi() {
        return hi;
    }

    public static ProficiencyCefr fromRating(int rating) {
        for (ProficiencyCefr c : values()) {
            if (rating <= c.hi) {
                return c;
            }
        }
        return C2;
    }

    public ProficiencyCefr next() {
        return this == C2 ? C2 : values()[ordinal() + 1];
    }

    public ProficiencyCefr previous() {
        return this == A1 ? A1 : values()[ordinal() - 1];
    }

    /**
     * Strict parse: only an exact level label (case-insensitive, trimmed). Anything else is empty.
     * No lenient prefixes and NEVER a default level (Hardening #3).
     */
    public static Optional<ProficiencyCefr> parseStrict(String raw) {
        if (raw == null) {
            return Optional.empty();
        }
        String s = raw.trim().toUpperCase(Locale.ROOT);
        for (ProficiencyCefr c : values()) {
            if (c.name().equals(s)) {
                return Optional.of(c);
            }
        }
        return Optional.empty();
    }
}
