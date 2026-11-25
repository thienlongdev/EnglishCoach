package com.englishcoach.garden.api;

import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

import java.util.LinkedHashMap;
import java.util.Map;

/** Stable public error codes for the Garden package only (never internals). */
@Slf4j
@RestControllerAdvice(basePackageClasses = GardenController.class)
@Order(Ordered.HIGHEST_PRECEDENCE)
public class GardenExceptionHandler {

    @ExceptionHandler(GardenException.class)
    public ResponseEntity<Map<String, Object>> domain(GardenException e) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code);
        if (!e.details.isEmpty()) body.put("details", e.details);
        return ResponseEntity.status(e.status).header("Cache-Control", "no-store").body(body);
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, Object>> typeMismatch(MethodArgumentTypeMismatchException e) {
        // a malformed Idempotency-Key header (not a UUID) lands here too
        String code = "Idempotency-Key".equals(e.getName()) ? "IDEMPOTENCY_KEY_REQUIRED" : "INVALID_COMMAND";
        return error(400, code);
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class,
            HandlerMethodValidationException.class, MissingRequestHeaderException.class, IllegalArgumentException.class})
    public ResponseEntity<Map<String, Object>> invalid(Exception e) {
        return error(400, "INVALID_COMMAND");
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> unavailable(Exception e) {
        log.error("Echo Garden request failed", e);
        return error(503, "GARDEN_UNAVAILABLE");
    }

    private static ResponseEntity<Map<String, Object>> error(int status, String code) {
        return ResponseEntity.status(status).header("Cache-Control", "no-store").body(Map.of("code", code));
    }
}
