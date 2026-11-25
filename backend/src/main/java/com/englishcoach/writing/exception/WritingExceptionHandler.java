package com.englishcoach.writing.exception;

import com.englishcoach.common.exception.GlobalExceptionHandler;
import com.englishcoach.writing.dto.WritingErrorResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.time.Instant;
import java.util.UUID;

@Slf4j
@Order(Ordered.HIGHEST_PRECEDENCE)
@RestControllerAdvice(basePackages = "com.englishcoach.writing")
public class WritingExceptionHandler {

    @ExceptionHandler(WritingNotFoundException.class)
    public ResponseEntity<WritingErrorResponse> handleNotFound(WritingNotFoundException ex) {
        return buildResponse(HttpStatus.NOT_FOUND, "NOT_FOUND", ex.getMessage(), false);
    }

    @ExceptionHandler(WritingConflictException.class)
    public ResponseEntity<WritingErrorResponse> handleConflict(WritingConflictException ex) {
        return buildResponse(HttpStatus.CONFLICT, "CONFLICT", ex.getMessage(), true);
    }

    @ExceptionHandler(WritingForbiddenException.class)
    public ResponseEntity<WritingErrorResponse> handleForbidden(WritingForbiddenException ex) {
        return buildResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", ex.getMessage(), false);
    }

    @ExceptionHandler(WritingDisabledException.class)
    public ResponseEntity<WritingErrorResponse> handleDisabled(WritingDisabledException ex) {
        return buildResponse(HttpStatus.SERVICE_UNAVAILABLE, "WRITING_DISABLED", ex.getMessage(), false);
    }

    private static final String SAFE_AI_SERVICE_ERROR_MESSAGE =
            "Dịch vụ AI đánh giá viết tạm thời không khả dụng. Bản nháp của bạn đã được lưu, vui lòng thử lại sau.";

    @ExceptionHandler(WritingAiServiceException.class)
    public ResponseEntity<WritingErrorResponse> handleAiService(WritingAiServiceException ex) {
        // EC-SEC-2026-037: Log full upstream diagnostics server-side; never expose internal AI URLs or RestTemplate messages.
        log.error("Writing AI service failure: {}", ex.getMessage(), ex);
        return buildResponse(HttpStatus.BAD_GATEWAY, "AI_SERVICE_ERROR", SAFE_AI_SERVICE_ERROR_MESSAGE, true);
    }

    @ExceptionHandler(WritingValidationException.class)
    public ResponseEntity<WritingErrorResponse> handleValidation(WritingValidationException ex) {
        WritingErrorResponse response = WritingErrorResponse.builder()
                .code("VALIDATION_ERROR")
                .message(ex.getMessage())
                .requestId(UUID.randomUUID().toString())
                .retryable(false)
                .timestamp(Instant.now())
                .fieldErrors(ex.getFieldErrors())
                .build();
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(response);
    }

    @ExceptionHandler(org.springframework.web.bind.MethodArgumentNotValidException.class)
    public ResponseEntity<WritingErrorResponse> handleMethodArgumentNotValid(org.springframework.web.bind.MethodArgumentNotValidException ex) {
        java.util.Map<String, String> errors = new java.util.HashMap<>();
        ex.getBindingResult().getFieldErrors().forEach(error ->
                errors.put(error.getField(), error.getDefaultMessage()));

        WritingErrorResponse response = WritingErrorResponse.builder()
                .code("VALIDATION_ERROR")
                .message("Validation failed: input is invalid or blank")
                .requestId(UUID.randomUUID().toString())
                .retryable(false)
                .timestamp(Instant.now())
                .fieldErrors(errors)
                .build();
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(response);
    }

    @ExceptionHandler(org.springframework.http.converter.HttpMessageNotReadableException.class)
    public ResponseEntity<WritingErrorResponse> handleMessageNotReadable(org.springframework.http.converter.HttpMessageNotReadableException ex) {
        return buildResponse(HttpStatus.BAD_REQUEST, "MALFORMED_REQUEST", "Malformed JSON request body", false);
    }

    private ResponseEntity<WritingErrorResponse> buildResponse(HttpStatus status, String code, String message, boolean retryable) {
        String safeMessage = GlobalExceptionHandler.sanitizeClientMessage(message, SAFE_AI_SERVICE_ERROR_MESSAGE);
        WritingErrorResponse response = WritingErrorResponse.builder()
                .code(code)
                .message(safeMessage)
                .requestId(UUID.randomUUID().toString())
                .retryable(retryable)
                .timestamp(Instant.now())
                .build();
        return ResponseEntity.status(status).body(response);
    }
}
