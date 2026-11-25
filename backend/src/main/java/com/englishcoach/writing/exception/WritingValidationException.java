package com.englishcoach.writing.exception;

import lombok.Getter;

import java.util.Map;

@Getter
public class WritingValidationException extends RuntimeException {
    private final Map<String, String> fieldErrors;

    public WritingValidationException(String message) {
        super(message);
        this.fieldErrors = Map.of();
    }

    public WritingValidationException(String message, Map<String, String> fieldErrors) {
        super(message);
        this.fieldErrors = fieldErrors != null ? fieldErrors : Map.of();
    }
}
