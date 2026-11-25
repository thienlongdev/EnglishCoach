package com.englishcoach.exams.exception;

import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.validation.ExamContentValidationService;

import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@Slf4j
// Feature-specific Premium refusals must reach PremiumExceptionHandler before the Exams catch-all.
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
@RestControllerAdvice(basePackages = "com.englishcoach.exams")
public class ExamExceptionHandler {

    public static class ExamNotFoundException extends RuntimeException {
        public ExamNotFoundException(String message) {
            super(message);
        }
    }

    public static class ExamForbiddenException extends IllegalArgumentException {
        public ExamForbiddenException(String message) {
            super(message);
        }
    }

    public record ExamErrorResponse(
            String code,
            String message,
            String requestId,
            boolean retryable,
            Instant serverTime,
            Long currentRevision,
            Map<String, String> fieldErrors,
            com.englishcoach.exams.model.ExamAttemptRecords.ActiveSimulationAttemptSummary activeAttempt
    ) {
        public ExamErrorResponse(
                String code,
                String message,
                String requestId,
                boolean retryable,
                Instant serverTime,
                Long currentRevision,
                Map<String, String> fieldErrors
        ) {
            this(code, message, requestId, retryable, serverTime, currentRevision, fieldErrors, null);
        }
    }

    @ExceptionHandler(ExamActiveSimulationConflictException.class)
    public ResponseEntity<ExamErrorResponse> handleActiveSimulationConflict(ExamActiveSimulationConflictException e) {
        log.warn("Active simulation conflict: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT).body(new ExamErrorResponse(
                e.getCode(),
                e.getMessage(),
                UUID.randomUUID().toString(),
                false,
                Instant.now(),
                null,
                null,
                e.getActiveAttempt()
        ));
    }

    @ExceptionHandler(ExamNotFoundException.class)
    public ResponseEntity<ExamErrorResponse> handleNotFound(ExamNotFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(new ExamErrorResponse(
                "NOT_FOUND",
                safeMessage(e.getMessage()),
                UUID.randomUUID().toString(),
                false,
                Instant.now(),
                null,
                null
        ));
    }

    @ExceptionHandler(ExamForbiddenException.class)
    public ResponseEntity<ExamErrorResponse> handleForbidden(ExamForbiddenException e) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(new ExamErrorResponse(
                "FORBIDDEN",
                safeMessage(e.getMessage()),
                UUID.randomUUID().toString(),
                false,
                Instant.now(),
                null,
                null
        ));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ExamErrorResponse> handleIllegalArgument(IllegalArgumentException e) {
        log.warn("Invalid exam request argument: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(new ExamErrorResponse(
                "BAD_REQUEST",
                safeMessage(e.getMessage()),
                UUID.randomUUID().toString(),
                false,
                Instant.now(),
                null,
                null
        ));
    }

    @ExceptionHandler(ExamConcurrencyException.class)
    public ResponseEntity<ExamErrorResponse> handleConcurrency(ExamConcurrencyException e) {
        log.warn("Exam concurrency or revision conflict: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT).body(new ExamErrorResponse(
                e.getCode(),
                safeMessage(e.getMessage()),
                UUID.randomUUID().toString(),
                true,
                Instant.now(),
                e.getCurrentRevision(),
                null
        ));
    }

    @ExceptionHandler(ExamWriteClosedException.class)
    public ResponseEntity<ExamErrorResponse> handleWriteClosed(ExamWriteClosedException e) {
        log.info("Exam write refused ({}): {}", e.getCode(), e.getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT).body(new ExamErrorResponse(
                e.getCode(),
                WRITE_CLOSED_MESSAGE_VI,
                UUID.randomUUID().toString(),
                false,
                Instant.now(),
                e.getCurrentRevision(),
                null
        ));
    }

    /** Exams Phase 9F: throttled request — stable code, learner-safe text, no limiter internals. */
    @ExceptionHandler(ExamRateLimitedException.class)
    public ResponseEntity<ExamErrorResponse> handleRateLimited(ExamRateLimitedException e) {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                .header("Retry-After", "60")
                .body(new ExamErrorResponse(
                        RATE_LIMITED_CODE,
                        RATE_LIMITED_MESSAGE_VI,
                        UUID.randomUUID().toString(),
                        true,
                        Instant.now(),
                        null,
                        null
                ));
    }

    public static final String WRITE_CLOSED_MESSAGE_VI = "Bài thi đã đóng — câu trả lời mới không còn được ghi nhận.";
    public static final String RATE_LIMITED_CODE = "RATE_LIMITED";
    public static final String RATE_LIMITED_MESSAGE_VI = "Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.";
    public static final String GENERIC_INVALID_MESSAGE = "The request could not be processed.";

    /**
     * Exams Phase 9F: an exception message is returned to the caller only when it is one of our own stable messages; a
     * message that carries Java class names, SQL, file-system paths or framework internals is replaced by a generic text
     * (the original stays in the server log).
     */
    static String safeMessage(String message) {
        if (message == null || message.isBlank()) return GENERIC_INVALID_MESSAGE;
        String m = message;
        if (m.length() > 400
                || m.contains("No enum constant") || m.contains("java.") || m.contains("javax.") || m.contains("com.englishcoach")
                || m.contains("org.springframework") || m.contains("org.postgresql") || m.contains("SQL")
                || m.matches("(?s).*\\b(SELECT|INSERT|UPDATE|DELETE)\\b.*\\b(FROM|INTO|SET|WHERE)\\b.*")
                || m.matches("(?s).*[A-Za-z]:\\\\.*") || m.contains("/home/") || m.contains("/mnt/") || m.contains("/app/")
                || m.contains("file:") || m.contains("Exception") || m.contains("For input string")) {
            return GENERIC_INVALID_MESSAGE;
        }
        return m;
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<ExamErrorResponse> handleIllegalState(IllegalStateException e) {
        log.warn("Exam state or concurrency conflict: {}", e.getMessage());
        HttpStatus status = HttpStatus.CONFLICT;
        String code = "STATE_CONFLICT";
        String message = safeMessage(e.getMessage());
        if (e.getMessage() != null && e.getMessage().startsWith(ExamContentValidationService.UNDER_REVIEW_CODE)) {
            // Content validation gate: learner-facing text only, never the internal diagnostics.
            code = ExamContentValidationService.UNDER_REVIEW_CODE;
            message = ExamContentValidationService.UNDER_REVIEW_MESSAGE_VI;
        } else if (e.getMessage() != null && e.getMessage().startsWith(ExamPracticeService.SCOPE_UNAVAILABLE_CODE)) {
            // Exams Phase 6: scope readiness reason codes stay internal (admin diagnostics only).
            code = ExamPracticeService.SCOPE_UNAVAILABLE_CODE;
            message = ExamPracticeService.SCOPE_UNAVAILABLE_MESSAGE_VI;
        } else if (e.getMessage() != null && e.getMessage().startsWith(ExamPracticeService.SOURCE_UNAVAILABLE_CODE)) {
            code = ExamPracticeService.SOURCE_UNAVAILABLE_CODE;
            message = ExamPracticeService.SOURCE_UNAVAILABLE_MESSAGE_VI;
        } else if (e.getMessage() != null && e.getMessage().startsWith(ExamPracticeService.REVIEW_NOT_AVAILABLE_CODE)) {
            code = ExamPracticeService.REVIEW_NOT_AVAILABLE_CODE;
        } else if (e.getMessage() != null && e.getMessage().startsWith(ExamPracticeService.IN_PROGRESS_CODE)) {
            code = ExamPracticeService.IN_PROGRESS_CODE;
        } else if (e.getMessage() != null && e.getMessage().startsWith("ASSET_NOT_IN_ATTEMPT_SCOPE")) {
            status = HttpStatus.FORBIDDEN;
            code = "ASSET_NOT_IN_ATTEMPT_SCOPE";
        } else if (e.getMessage() != null && e.getMessage().contains("ACTIVE_SIMULATION_CONFLICT")) {
            status = HttpStatus.CONFLICT;
            code = "ACTIVE_SIMULATION_CONFLICT";
        } else if (e.getMessage() != null && e.getMessage().contains("SCOPE_NOT_RUNNABLE")) {
            status = HttpStatus.CONFLICT;
            code = "SCOPE_NOT_RUNNABLE";
        } else if (e.getMessage() != null && e.getMessage().contains("RIGHTS_DENIED")) {
            status = HttpStatus.FORBIDDEN;
            code = "RIGHTS_DENIED";
        } else if (e.getMessage() != null && e.getMessage().contains("CONCURRENT")) {
            code = "CONCURRENCY_CONFLICT";
        } else if (e.getMessage() != null && (e.getMessage().contains("PERMISSION") || e.getMessage().contains("FORBIDDEN"))) {
            status = HttpStatus.FORBIDDEN;
            code = "FORBIDDEN";
        }
        return ResponseEntity.status(status).body(new ExamErrorResponse(
                code,
                message,
                UUID.randomUUID().toString(),
                status == HttpStatus.CONFLICT,
                Instant.now(),
                null,
                null
        ));
    }

    /** Exams Phase 9F: malformed body / parameter / path value ⇒ 400 with a generic text (never a parser or class name). */
    @ExceptionHandler({org.springframework.http.converter.HttpMessageNotReadableException.class,
            org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class,
            org.springframework.web.bind.MissingServletRequestParameterException.class})
    public ResponseEntity<ExamErrorResponse> handleMalformedRequest(Exception e) {
        log.warn("Malformed exam request: {}", e.getClass().getSimpleName());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(new ExamErrorResponse(
                "BAD_REQUEST",
                GENERIC_INVALID_MESSAGE,
                UUID.randomUUID().toString(),
                false,
                Instant.now(),
                null,
                null
        ));
    }

    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ExamErrorResponse> handleAccessDenied(AccessDeniedException e) {
        log.warn("Access denied on exams endpoint: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(new ExamErrorResponse(
                "FORBIDDEN",
                "You do not have permission to perform this action",
                UUID.randomUUID().toString(),
                false,
                Instant.now(),
                null,
                null
        ));
    }

    @ExceptionHandler(AuthenticationException.class)
    public ResponseEntity<ExamErrorResponse> handleAuthentication(AuthenticationException e) {
        log.warn("Authentication failed on exams endpoint: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(new ExamErrorResponse(
                "UNAUTHORIZED",
                "Authentication required for Exams operations",
                UUID.randomUUID().toString(),
                false,
                Instant.now(),
                null,
                null
        ));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ExamErrorResponse> handleGeneralException(Exception e) {
        String reqId = UUID.randomUUID().toString();
        log.error("Unhandled exam exception [requestId={}]", reqId, e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(new ExamErrorResponse(
                "INTERNAL_ERROR",
                "An unexpected server error occurred. Please try again.",
                reqId,
                true,
                Instant.now(),
                null,
                null
        ));
    }
}
