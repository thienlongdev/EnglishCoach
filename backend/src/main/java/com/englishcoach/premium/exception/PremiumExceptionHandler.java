package com.englishcoach.premium.exception;

import com.englishcoach.premium.dto.PremiumErrorResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@Slf4j
@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
public class PremiumExceptionHandler {

    @ExceptionHandler(PremiumRequiredException.class)
    public ResponseEntity<PremiumErrorResponse> handlePremiumRequiredException(PremiumRequiredException ex) {
        log.info("Premium access gate denied request: featureKey={}, trialRemaining={}",
                ex.getFeatureKey(), ex.getTrialRemaining());

        PremiumErrorResponse body = PremiumErrorResponse.builder()
                .errorCode("PREMIUM_REQUIRED")
                .message(ex.getMessage())
                .featureKey(ex.getFeatureKey())
                .trialRemaining(ex.getTrialRemaining())
                .upgradePath(ex.getUpgradePath())
                .resetsAt(ex.getResetsAt())
                .build();

        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(body);
    }

    @ExceptionHandler(PremiumLimitReachedException.class)
    public ResponseEntity<PremiumErrorResponse> handlePremiumLimitReachedException(PremiumLimitReachedException ex) {
        log.info("Premium fair-use limit reached: featureKey={}, limit={}, remaining={}",
                ex.getFeatureKey(), ex.getMonthlyLimit(), ex.getMonthlyRemaining());

        PremiumErrorResponse body = PremiumErrorResponse.builder()
                .errorCode("PREMIUM_LIMIT_REACHED")
                .message(ex.getMessage())
                .featureKey(ex.getFeatureKey())
                .monthlyRemaining(ex.getMonthlyRemaining())
                .upgradePath(ex.getUpgradePath())
                .build();

        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(body);
    }
}
