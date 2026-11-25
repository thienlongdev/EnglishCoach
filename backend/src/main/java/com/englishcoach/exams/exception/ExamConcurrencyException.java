package com.englishcoach.exams.exception;

import lombok.Getter;

@Getter
public class ExamConcurrencyException extends IllegalStateException {

    private final String code;
    private final Long currentRevision;
    private final Long expectedRevision;

    public ExamConcurrencyException(String message) {
        this("ATTEMPT_REVISION_CONFLICT", message, null, null);
    }

    public ExamConcurrencyException(String code, String message, Long currentRevision, Long expectedRevision) {
        super(message);
        this.code = code != null ? code : "ATTEMPT_REVISION_CONFLICT";
        this.currentRevision = currentRevision;
        this.expectedRevision = expectedRevision;
    }
}
