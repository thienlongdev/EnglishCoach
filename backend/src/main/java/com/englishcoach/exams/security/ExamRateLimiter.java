package com.englishcoach.exams.security;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.exams.exception.ExamRateLimitedException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Exams Phase 9F — per-learner throttling of the expensive / record-creating Exams operations, delegated to the EXISTING
 * application rate-limit store ({@link LoginThrottleService#checkAndIncrementRateLimit}: {@code public.auth_rate_limit_buckets},
 * fixed one-minute windows) — no second limiter, no Redis. Key = the authenticated user id, never an IP or a client value.
 *
 * <p>Deliberately NOT throttled: autosave (bounded by the batch size, the attempt revision and the row lock; a rejected
 * autosave would risk losing answers) and submit (idempotent; a duplicate returns the existing submission). Limits are
 * far above legitimate use. A failure of the limiter store never blocks a learner (fail open, logged): throttling is
 * abuse protection, not an authorization rule.
 */
@Slf4j
@Component
public class ExamRateLimiter {

    public enum Operation {
        CREATE_ATTEMPT(20),
        CREATE_PRACTICE_ATTEMPT(30),
        PRACTICE_AGAIN(30),
        PLAYBACK_GRANT(120),
        ANALYTICS(30);

        public final int perMinute;

        Operation(int perMinute) {
            this.perMinute = perMinute;
        }

        String kind() {
            return "EXAMS_" + name();
        }
    }

    private final LoginThrottleService store;

    @Autowired
    public ExamRateLimiter(@Autowired(required = false) LoginThrottleService store) {
        this.store = store;
    }

    /** A limiter that never throttles (unit tests / tooling without the shared store). */
    public static ExamRateLimiter disabled() {
        return new ExamRateLimiter(null);
    }

    /** Throws {@link ExamRateLimitedException} (429 {@code RATE_LIMITED}) when the learner exceeded the operation's limit. */
    public void check(Operation operation, Long userId) {
        if (store == null || userId == null) return;
        boolean allowed;
        try {
            allowed = store.checkAndIncrementRateLimit(operation.kind(), "user:" + userId, operation.perMinute, 1);
        } catch (RuntimeException e) {
            log.warn("Exams rate-limit store unavailable for {} ({}); request allowed", operation, e.getClass().getSimpleName());
            return;
        }
        if (!allowed) {
            log.warn("Exams rate limit exceeded: operation={} user={}", operation, userId);
            throw new ExamRateLimitedException(operation.name());
        }
    }
}
