package com.englishcoach.speaking.topic;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.util.Map;

/** Stable error codes for the topic-practice endpoints; anything else falls through to the global handler. */
@RestControllerAdvice(basePackageClasses = TopicController.class)
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TopicExceptionHandler {

    @ExceptionHandler(TopicException.class)
    public ResponseEntity<Map<String, String>> domain(TopicException e) {
        return error(e.status, e.code);
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class,
            MethodArgumentTypeMismatchException.class, HandlerMethodValidationException.class})
    public ResponseEntity<Map<String, String>> invalid(Exception e) {
        return error(400, "INVALID_REQUEST");
    }

    private static ResponseEntity<Map<String, String>> error(int status, String code) {
        return ResponseEntity.status(status).cacheControl(CacheControl.noStore()).body(Map.of("code", code));
    }
}
