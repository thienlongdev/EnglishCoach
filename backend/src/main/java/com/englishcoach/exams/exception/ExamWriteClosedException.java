package com.englishcoach.exams.exception;

import lombok.Getter;

/**
 * Exams Phase 9C — an answer write refused because the attempt (or its section) is closed: submitted / expired /
 * invalidated, or past its server deadline. Terminal for the client (409, {@code retryable=false}): retrying the same
 * write can never succeed, so the runner keeps its local copy and stops re-sending.
 */
@Getter
public class ExamWriteClosedException extends IllegalStateException {

    private final String code;
    private final Long currentRevision;

    public ExamWriteClosedException(String code, String message, Long currentRevision) {
        super(message);
        this.code = code;
        this.currentRevision = currentRevision;
    }
}
