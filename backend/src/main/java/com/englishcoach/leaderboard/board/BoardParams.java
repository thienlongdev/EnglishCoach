package com.englishcoach.leaderboard.board;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.Locale;

/** Query parameters of the board API (Phase 3). Unknown values ⇒ 400. */
public final class BoardParams {

    public static final int DEFAULT_LIMIT = 20;
    public static final int MAX_LIMIT = 50;
    /** Thi đua list "Xem thêm" (#4 … #100): the board endpoint alone accepts up to 100 rows. */
    public static final int ACTIVITY_MAX_LIMIT = 100;

    private BoardParams() {}

    public enum Period { WEEK, MONTH, ALL_TIME }

    /** Thi đua scope: everyone, or one division (Sơ cấp / Trung cấp / Cao cấp). */
    public enum Scope { GLOBAL, SO_CAP, TRUNG_CAP, CAO_CAP }

    /** ALL + the six Activity skill groups. */
    public enum Group { ALL, VOCAB, LISTENING, SPEAKING, READING, WRITING, EXAMS }

    public enum Division { SO_CAP, TRUNG_CAP, CAO_CAP }

    /** Parses an enum query value (case-insensitive); blank ⇒ {@code fallback}; unknown ⇒ 400. */
    public static <E extends Enum<E>> E parse(Class<E> type, String raw, E fallback, String name) {
        if (raw == null || raw.isBlank()) {
            if (fallback == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, name + " is required");
            }
            return fallback;
        }
        try {
            return Enum.valueOf(type, raw.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported " + name + ": " + raw);
        }
    }

    /** null ⇒ 20; above 50 ⇒ 50; below 1 ⇒ 400. */
    public static int limit(Integer raw) {
        if (raw == null) {
            return DEFAULT_LIMIT;
        }
        if (raw < 1) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "limit must be between 1 and " + MAX_LIMIT);
        }
        return Math.min(raw, MAX_LIMIT);
    }

    /** Thi đua board: null ⇒ 20; above 100 ⇒ 100; below 1 ⇒ 400. */
    public static int activityLimit(Integer raw) {
        if (raw == null) {
            return DEFAULT_LIMIT;
        }
        if (raw < 1) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "limit must be between 1 and " + ACTIVITY_MAX_LIMIT);
        }
        return Math.min(raw, ACTIVITY_MAX_LIMIT);
    }
}
