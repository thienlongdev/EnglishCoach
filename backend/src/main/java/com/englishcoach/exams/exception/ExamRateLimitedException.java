package com.englishcoach.exams.exception;

/** Exams Phase 9F — a throttled Exams request (429 {@code RATE_LIMITED}); the operation name stays in the server log. */
public class ExamRateLimitedException extends RuntimeException {

    public ExamRateLimitedException(String operation) {
        super("RATE_LIMITED: " + operation);
    }
}
