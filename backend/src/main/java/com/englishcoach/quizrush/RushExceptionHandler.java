package com.englishcoach.quizrush;

import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
import org.springframework.core.annotation.Order;
import org.springframework.core.Ordered;
import java.util.Map;

@RestControllerAdvice(basePackageClasses=RushController.class)
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RushExceptionHandler {
    @ExceptionHandler(RushException.class) public ResponseEntity<?> reject(RushException ex){
        return ResponseEntity.status(ex.status).cacheControl(CacheControl.noStore()).body(Map.of("error",ex.getMessage()));
    }
    @ExceptionHandler({org.springframework.web.bind.MethodArgumentNotValidException.class,org.springframework.http.converter.HttpMessageNotReadableException.class})
    public ResponseEntity<?> invalid(){return ResponseEntity.badRequest().body(Map.of("error","INVALID_REQUEST"));}
    @ExceptionHandler(Exception.class) public ResponseEntity<?> unavailable(){
        return ResponseEntity.status(503).cacheControl(CacheControl.noStore()).body(Map.of("error","RACE_UNAVAILABLE"));
    }
}
