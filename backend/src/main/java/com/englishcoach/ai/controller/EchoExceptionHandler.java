package com.englishcoach.ai.controller;

import com.englishcoach.ai.service.EchoPolicy;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.util.Map;

/** Echo-local boundary: never return provider/database exception messages or validation payloads. */
@RestControllerAdvice(basePackages = {"com.englishcoach.ai.controller", "com.englishcoach.echocoach.controller"})
@Order(Ordered.HIGHEST_PRECEDENCE)
public class EchoExceptionHandler {
    /** Daily Echo Coach allowance used up: say so (and when it renews) instead of the generic busy message. */
    @ExceptionHandler(com.englishcoach.ai.service.CoachDailyLimitException.class)
    public ResponseEntity<Map<String,Object>> dailyLimit(com.englishcoach.ai.service.CoachDailyLimitException error) {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).headers(error.getHeaders()).contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("status", 429, "code", "COACH_DAILY_LIMIT", "limit", error.limit(),
                        "resetsAt", String.valueOf(error.resetsAt()),
                        "message", "Bạn đã dùng hết " + error.limit() + " tin nhắn Echo Coach miễn phí hôm nay. Lượt mới có vào 0:00."));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String,Object>> handle(Exception error) {
        HttpStatusCode status = error instanceof ResponseStatusException e ? e.getStatusCode()
                : error instanceof org.springframework.web.bind.MethodArgumentNotValidException
                || error instanceof org.springframework.http.converter.HttpMessageNotReadableException ? HttpStatus.BAD_REQUEST : HttpStatus.INTERNAL_SERVER_ERROR;
        int codeVal = status.value();
        String code = codeVal == 429 ? "rate_limited" : codeVal == 422 ? "length" : codeVal == 400 ? "invalid_request" : "service_busy";
        // a preset content type: an error of the event-stream endpoint must stay this status (it used to fail the
        // negotiation, became a 401 on the error dispatch and made the client replay the message)
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON)
                .body(Map.of(
                        "status", codeVal,
                        "code", code,
                        "message", EchoPolicy.localizedErrorMessage(code, true),
                        "messageVi", EchoPolicy.localizedErrorMessage(code, true),
                        "messageEn", EchoPolicy.localizedErrorMessage(code, false)));
    }
}
