package com.englishcoach.common.exception;

import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

@Order(Ordered.LOWEST_PRECEDENCE)
@RestControllerAdvice
@Slf4j
public class GlobalExceptionHandler {

    private static final String SAFE_BAD_REQUEST_MESSAGE =
            "Yêu cầu không thể xử lý lúc này. Vui lòng thử lại sau.";
    private static final String SAFE_UPSTREAM_ERROR_MESSAGE =
            "Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.";
    private static final Pattern TAILSCALE_OR_CGNAT_IP =
            Pattern.compile("(?<![0-9])100\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}(?![0-9])");

    /**
     * EC-SEC-2026-037: Prevents internal service URLs, Tailscale IPs, ports, or raw RestTemplate
     * I/O exception messages from leaking to HTTP clients while preserving normal domain errors.
     */
    public static String sanitizeClientMessage(String rawMessage, String fallback) {
        if (rawMessage == null || rawMessage.isBlank()) {
            return fallback;
        }
        String lower = rawMessage.toLowerCase(Locale.ROOT);
        if (containsInternalEndpointLeak(lower)) {
            return SAFE_UPSTREAM_ERROR_MESSAGE;
        }
        return rawMessage;
    }

    private static boolean containsInternalEndpointLeak(String lower) {
        return lower.contains("http://")
                || lower.contains("https://")
                || lower.contains("127.0.0.1")
                || lower.contains("localhost:")
                || lower.contains(":8000")
                || lower.contains(":8005")
                || lower.contains(":8010")
                || lower.contains("i/o error on")
                || lower.contains("restclientexception")
                || lower.contains("resourceaccessexception")
                || lower.contains("ai-service")
                || lower.contains("mdd-service")
                || TAILSCALE_OR_CGNAT_IP.matcher(lower).find();
    }

    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<String> handleAccessDeniedException(AccessDeniedException ex) {
        log.error("Access Denied Exception caught in global handler: {}", ex.getMessage());
        return new ResponseEntity<>(ex.getMessage(), HttpStatus.FORBIDDEN);
    }

    @ExceptionHandler(com.englishcoach.reading.exception.OcrProcessingException.class)
    public ResponseEntity<Map<String, Object>> handleOcrProcessingException(com.englishcoach.reading.exception.OcrProcessingException ex) {
        log.error("OcrProcessingException caught: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                "error", "Service Unavailable",
                "message", "Dịch vụ nhận dạng văn bản hiện không khả dụng. Vui lòng thử lại sau.",
                "status", HttpStatus.SERVICE_UNAVAILABLE.value()
        ));
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, Object>> handleIllegalArgumentException(RuntimeException ex) {
        log.warn("Argument/State Exception caught in global handler: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of(
                "error", "Bad Request",
                "message", sanitizeClientMessage(ex.getMessage(), SAFE_BAD_REQUEST_MESSAGE),
                "status", HttpStatus.BAD_REQUEST.value()
        ));
    }

    @ExceptionHandler(org.springframework.web.bind.MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, Object>> handleMethodArgumentNotValidException(org.springframework.web.bind.MethodArgumentNotValidException ex) {
        java.util.Map<String, String> errors = new java.util.HashMap<>();
        ex.getBindingResult().getFieldErrors().forEach(error ->
                errors.put(error.getField(), error.getDefaultMessage()));
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of(
                "error", "Bad Request",
                "message", "Validation failed",
                "status", HttpStatus.BAD_REQUEST.value(),
                "fieldErrors", errors
        ));
    }

    @ExceptionHandler(org.springframework.web.servlet.resource.NoResourceFoundException.class)
    public ResponseEntity<String> handleNoResourceFoundException(org.springframework.web.servlet.resource.NoResourceFoundException ex) {
        log.warn("Resource Not Found: {}", ex.getMessage());
        return new ResponseEntity<>(ex.getMessage(), HttpStatus.NOT_FOUND);
    }

    @ExceptionHandler(org.springframework.web.HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Map<String, Object>> handleHttpRequestMethodNotSupportedException(org.springframework.web.HttpRequestMethodNotSupportedException ex) {
        log.warn("Method Not Allowed: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED).body(Map.of(
                "error", "Method Not Allowed",
                "message", ex.getMessage(),
                "status", HttpStatus.METHOD_NOT_ALLOWED.value()
        ));
    }

    @ExceptionHandler(org.springframework.web.server.ResponseStatusException.class)
    public ResponseEntity<Map<String, Object>> handleResponseStatusException(org.springframework.web.server.ResponseStatusException ex) {
        log.warn("ResponseStatusException: {} {}", ex.getStatusCode(), ex.getReason());
        return ResponseEntity.status(ex.getStatusCode()).body(Map.of(
                "error", ex.getStatusCode().toString(),
                "message", sanitizeClientMessage(ex.getReason(), ""),
                "status", ex.getStatusCode().value()
        ));
    }

    /**
     * A request the application cannot read (a missing parameter or part, a wrong type, an unreadable or
     * non-multipart body, an unsupported content type) is the caller's mistake: 400 / 415 with a fixed text, never
     * 500, and never the parser's own message (it can quote the request).
     */
    @ExceptionHandler({
            org.springframework.web.bind.ServletRequestBindingException.class,
            org.springframework.web.multipart.support.MissingServletRequestPartException.class,
            org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class,
            org.springframework.http.converter.HttpMessageNotReadableException.class,
            org.springframework.web.multipart.MultipartException.class,
            org.springframework.web.method.annotation.HandlerMethodValidationException.class
    })
    public ResponseEntity<Map<String, Object>> handleUnreadableRequest(Exception ex) {
        log.warn("Bad request: {}", ex.getClass().getSimpleName());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of(
                "error", "Bad Request",
                "message", "The request is missing a required value or is not in the expected format.",
                "status", HttpStatus.BAD_REQUEST.value()
        ));
    }

    @ExceptionHandler(org.springframework.web.HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<Map<String, Object>> handleUnsupportedMediaType(Exception ex) {
        return ResponseEntity.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).body(Map.of(
                "error", "Unsupported Media Type",
                "message", "The request body's content type is not supported here.",
                "status", HttpStatus.UNSUPPORTED_MEDIA_TYPE.value()
        ));
    }

    /**
     * No database connection could be had in time (every pooled connection busy beyond spring.datasource.hikari
     * .connection-timeout, or the database unreachable). That is overload or an outage, not a fault of the request:
     * answer a short "busy, try again" instead of a 500 after a long wait, so the client can retry and the request
     * threads are not all parked behind the pool. One line per occurrence, no stack trace (it would flood the log
     * exactly when the server is busiest).
     */
    @ExceptionHandler({org.springframework.dao.DataAccessResourceFailureException.class,
            org.springframework.transaction.CannotCreateTransactionException.class})
    public ResponseEntity<Map<String, Object>> handleDatabaseUnavailable(Exception ex) {
        log.warn("Database connection unavailable, answered 503: {}", ex.getClass().getSimpleName());
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header("Retry-After", "5")
                .body(Map.of(
                        "code", "SERVICE_BUSY",
                        "error", "Service Unavailable",
                        "message", "English Coach đang bận, vui lòng thử lại sau vài giây. / English Coach is busy, please try again in a few seconds.",
                        "status", HttpStatus.SERVICE_UNAVAILABLE.value()
                ));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<String> handleGeneralException(Exception ex) {
        // The cause stays in the server log under a reference; the caller gets the reference, never the message of an
        // internal exception (it can carry SQL, file paths or another learner's data).
        String reference = java.util.UUID.randomUUID().toString().substring(0, 8);
        log.error("Unhandled Exception caught [ref {}]: {}", reference, ex.getMessage(), ex);
        return new ResponseEntity<>("An internal error occurred (ref " + reference + ")", HttpStatus.INTERNAL_SERVER_ERROR);
    }
}
