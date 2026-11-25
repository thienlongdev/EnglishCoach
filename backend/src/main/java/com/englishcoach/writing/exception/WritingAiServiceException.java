package com.englishcoach.writing.exception;

public class WritingAiServiceException extends RuntimeException {
    public WritingAiServiceException(String message) {
        super(message);
    }

    public WritingAiServiceException(String message, Throwable cause) {
        super(message, cause);
    }
}
