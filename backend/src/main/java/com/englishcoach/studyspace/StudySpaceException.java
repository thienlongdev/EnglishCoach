package com.englishcoach.studyspace;

/** A refused Không gian học tập command: HTTP status + stable public code (never internals). */
public final class StudySpaceException extends RuntimeException {

    final int status;
    final String code;

    public StudySpaceException(int status, String code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}
