package com.englishcoach.auth.service;

import com.englishcoach.auth.entity.AuthRateLimitBucket;
import com.englishcoach.auth.entity.AuthSecurityState;
import com.englishcoach.auth.repository.AuthRateLimitBucketRepository;
import com.englishcoach.auth.repository.AuthSecurityStateRepository;
import com.englishcoach.common.security.AuthSecurityProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

@Service
@RequiredArgsConstructor
@Slf4j
public class LoginThrottleService {

    private final AuthRateLimitBucketRepository rateLimitBucketRepository;
    private final AuthSecurityStateRepository securityStateRepository;
    private final SecurityAuditService auditService;
    private final AuthSecurityProperties securityProperties;

    /** Present in the application; absent when a test builds this service by hand (then {@link #countRequest} falls back). */
    private org.springframework.jdbc.core.JdbcTemplate jdbc;

    private Clock clock = Clock.systemUTC();

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setJdbc(org.springframework.jdbc.core.JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    void setClock(Clock clock) {
        this.clock = clock != null ? clock : Clock.systemUTC();
    }

    static Instant alignedWindowStart(Instant now, int windowMinutes) {
        long bucketSec = Math.max(1, windowMinutes) * 60L;
        return Instant.ofEpochSecond(Math.floorDiv(now.getEpochSecond(), bucketSec) * bucketSec);
    }

    /**
     * Atomically creates or increments the bucket and checks its cap. Game commands use the caller's
     * transaction. Authentication uses the independently committed entry point below.
     */
    public boolean countRequest(String kind, String key, int maxRequests, int windowMinutes) {
        if (jdbc == null) return countUsingRepository(kind, key, maxRequests, windowMinutes);
        int safeWindowMinutes = Math.max(1, windowMinutes);
        Instant windowStart = alignedWindowStart(clock.instant(), safeWindowMinutes);
        Instant expiresAt = windowStart.plus(safeWindowMinutes, ChronoUnit.MINUTES);
        var counted = jdbc.queryForList("""
                INSERT INTO public.auth_rate_limit_buckets AS b (kind, bucket_key, window_start, request_count, expires_at)
                VALUES (?, ?, ?, 1, ?)
                ON CONFLICT (kind, bucket_key, window_start) DO UPDATE SET request_count = b.request_count + 1
                WHERE b.request_count < ?
                RETURNING request_count
                """, Integer.class, kind, key, java.sql.Timestamp.from(windowStart), java.sql.Timestamp.from(expiresAt), maxRequests);
        if (counted.isEmpty()) {
            log.warn("[Throttle] Rate limit exceeded for kind={} key={}", kind, key);
            return false;
        }
        return true;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public boolean checkAndIncrementRateLimit(String kind, String key, int maxRequests, int windowMinutes) {
        return countRequest(kind, key, maxRequests, windowMinutes);
    }

    private boolean countUsingRepository(String kind, String key, int maxRequests, int windowMinutes) {
        int safeWindowMinutes = Math.max(1, windowMinutes);
        Instant now = clock.instant();
        Instant windowStart = alignedWindowStart(now, safeWindowMinutes);
        Instant expiresAt = windowStart.plus(safeWindowMinutes, ChronoUnit.MINUTES);

        AuthRateLimitBucket bucket = rateLimitBucketRepository
                .findByKindAndBucketKeyAndWindowStart(kind, key, windowStart)
                .orElse(null);

        if (bucket == null) {
            bucket = AuthRateLimitBucket.builder()
                    .kind(kind)
                    .bucketKey(key)
                    .windowStart(windowStart)
                    .requestCount(1)
                    .expiresAt(expiresAt)
                    .build();
            rateLimitBucketRepository.save(bucket);
            return true;
        }

        if (bucket.getRequestCount() >= maxRequests) {
            log.warn("[Throttle] Rate limit exceeded for kind={} key={}", kind, key);
            return false;
        }

        bucket.setRequestCount(bucket.getRequestCount() + 1);
        rateLimitBucketRepository.save(bucket);
        return true;
    }

    @Transactional(readOnly = true)
    public boolean isAccountLocked(Long userId) {
        if (userId == null) return false;
        return securityStateRepository.findById(userId)
                .map(state -> state.getLockedUntil() != null && state.getLockedUntil().isAfter(Instant.now()))
                .orElse(false);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordFailedLogin(Long userId, String ipAddress) {
        if (userId == null) return;

        // An entity built here with its @Version set counts as detached: saving it failed with an optimistic lock error
        // (HTTP 500 for every wrong password on an account without a row), and without a user it could not be persisted either.
        securityStateRepository.ensureRow(userId);
        AuthSecurityState state = securityStateRepository.findByUserIdForUpdate(userId).orElse(null);
        if (state == null) return;

        int count = state.getFailedLoginCount() + 1;
        state.setFailedLoginCount(count);

        if (count >= securityProperties.getMaxFailedLogins()) {
            Instant lockedUntil = Instant.now().plus(securityProperties.getLockoutDurationMinutes(), ChronoUnit.MINUTES);
            state.setLockedUntil(lockedUntil);
            log.warn("[Security] Account {} temporarily locked until {} after {} failed logins", userId, lockedUntil, count);
            auditService.recordEvent("ACCOUNT_TEMP_LOCKED", "FAILURE", null, userId,
                    null, ipAddress, null, "TOO_MANY_FAILED_LOGINS", "{\"failedCount\":" + count + "}");
        }

        securityStateRepository.save(state);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordSuccessfulLogin(Long userId, String ipAddress) {
        if (userId == null) return;

        securityStateRepository.findByUserIdForUpdate(userId).ifPresent(state -> {
            if (state.getFailedLoginCount() > 0 || state.getLockedUntil() != null) {
                state.setFailedLoginCount(0);
                state.setLockedUntil(null);
                state.setNextAllowedAt(null);
                securityStateRepository.save(state);
            }
        });
    }
}
