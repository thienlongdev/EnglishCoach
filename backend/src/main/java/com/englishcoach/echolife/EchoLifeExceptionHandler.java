package com.englishcoach.echolife;

import com.englishcoach.echolife.EchoLifeDtos.Conflict;
import com.englishcoach.echolife.EchoLifeGameDtos.GameConflict;
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

/** Stable error codes for the Echo Life endpoints; a stale write answers 409 with the current world. */
@RestControllerAdvice(basePackageClasses = EchoLifeController.class)
@Order(Ordered.HIGHEST_PRECEDENCE)
public class EchoLifeExceptionHandler {

    @ExceptionHandler(EchoLifeException.class)
    public ResponseEntity<Object> domain(EchoLifeException e) {
        Object body = e.current != null ? new Conflict(e.code, e.current)
                : e.currentGame != null ? new GameConflict(e.code, e.currentGame) : Map.of("code", e.code);
        var builder = ResponseEntity.status(e.status).cacheControl(CacheControl.noStore());
        if (e.status == 503 || e.status == 429) builder.header("Retry-After", "2");
        return builder.body(body);
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class,
            MethodArgumentTypeMismatchException.class, HandlerMethodValidationException.class})
    public ResponseEntity<Map<String, String>> invalid(Exception e) {
        return ResponseEntity.status(400).cacheControl(CacheControl.noStore()).body(Map.of("code", "INVALID_REQUEST"));
    }
}
