package com.englishcoach.learningpath;

/** A refused Learning Path command: HTTP status + stable public code (never internals). */
public final class LearningPathException extends RuntimeException {

    final int status;
    final String code;

    public LearningPathException(int status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
