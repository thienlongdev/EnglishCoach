package com.englishcoach.exams.validation;

/**
 * Validation status vocabulary (Exams Recovery Phase 2).
 * <p>Section level: {@link #VALID} (simulation-grade), {@link #PRACTICE_ONLY} or {@link #INVALID}.
 * <p>Form level: {@link #VALID} (full simulation eligible), {@link #NEEDS_REVIEW} (some skills usable, not a full
 * standardized form), {@link #INVALID} (nothing runnable) or {@link #UNKNOWN} (no trustworthy result — always
 * treated as not runnable, not full-ready and not evidence-eligible). UNKNOWN is never persisted.
 */
public enum ExamContentValidationStatus {
    VALID,
    PRACTICE_ONLY,
    NEEDS_REVIEW,
    INVALID,
    UNKNOWN;

    /** Fail-closed parse of a stored value: anything unrecognised is UNKNOWN. */
    public static ExamContentValidationStatus parse(String value) {
        if (value == null || value.isBlank()) return UNKNOWN;
        try {
            return valueOf(value.trim().toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return UNKNOWN;
        }
    }
}
