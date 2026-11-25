package com.englishcoach.hangman;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import java.util.Map;
@RestControllerAdvice(basePackageClasses=HangmanController.class)
@Order(Ordered.HIGHEST_PRECEDENCE)
public final class HangmanExceptionHandler {
 @ExceptionHandler(HangmanException.class) public ResponseEntity<?> domain(HangmanException e){return error(e.status,e.code);}
 @ExceptionHandler({MethodArgumentNotValidException.class,HttpMessageNotReadableException.class,MethodArgumentTypeMismatchException.class,IllegalArgumentException.class}) public ResponseEntity<?> invalid(Exception e){return error(400,"INVALID_COMMAND");}
 @ExceptionHandler(Exception.class) public ResponseEntity<?> unavailable(Exception e){return error(503,"GAME_UNAVAILABLE");}
 private ResponseEntity<?> error(int status,String code){return ResponseEntity.status(status).header("Cache-Control","no-store").body(Map.of("code",code));}
}
