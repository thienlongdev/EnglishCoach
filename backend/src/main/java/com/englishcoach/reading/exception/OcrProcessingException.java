package com.englishcoach.reading.exception;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

@ResponseStatus(HttpStatus.BAD_REQUEST)
public class OcrProcessingException extends RuntimeException {
    public OcrProcessingException(String message) {
        super(message);
    }
}
