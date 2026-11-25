package com.englishcoach.auth.mfa;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;

/**
 * Bounds guessing of a second factor. A six-digit code has a million values: without a bound an attacker who holds
 * the first factor could try them all. Failures are counted per account in the application's one rate-limit store
 * ({@code auth_rate_limit_buckets}) in two windows: {@value #MAX_PER_QUARTER_HOUR} in a quarter of an hour and
 * {@value #MAX_PER_DAY} in a day; at either bound every further attempt is refused without being checked. Only
 * failures count, so the administrator's own correct codes never lock the account.
 */
@Component
@RequiredArgsConstructor
public class MfaAttemptLimiter {

    static final int MAX_PER_QUARTER_HOUR = 6;
    static final int MAX_PER_DAY = 20;
    private static final String KIND_QUARTER = "MFA_FAIL_15M";
    private static final String KIND_DAY = "MFA_FAIL_DAY";

    private final JdbcTemplate jdbc;

    public boolean blocked(long userId, Instant now) {
        Integer over = jdbc.queryForObject("""
                SELECT count(*) FROM public.auth_rate_limit_buckets
                WHERE bucket_key = ? AND ((kind = ? AND window_start = ? AND request_count >= ?)
                                       OR (kind = ? AND window_start = ? AND request_count >= ?))
                """, Integer.class, key(userId),
                KIND_QUARTER, Timestamp.from(quarterStart(now)), MAX_PER_QUARTER_HOUR,
                KIND_DAY, Timestamp.from(dayStart(now)), MAX_PER_DAY);
        return over != null && over > 0;
    }

    public void recordFailure(long userId, Instant now) {
        count(KIND_QUARTER, userId, quarterStart(now), quarterStart(now).plus(15, ChronoUnit.MINUTES));
        count(KIND_DAY, userId, dayStart(now), dayStart(now).plus(1, ChronoUnit.DAYS));
    }

    private void count(String kind, long userId, Instant windowStart, Instant expiresAt) {
        jdbc.update("""
                INSERT INTO public.auth_rate_limit_buckets AS b (kind, bucket_key, window_start, request_count, expires_at)
                VALUES (?, ?, ?, 1, ?)
                ON CONFLICT (kind, bucket_key, window_start) DO UPDATE SET request_count = b.request_count + 1
                """, kind, key(userId), Timestamp.from(windowStart), Timestamp.from(expiresAt));
    }

    private static String key(long userId) {
        return "u:" + userId;
    }

    static Instant quarterStart(Instant now) {
        long seconds = now.getEpochSecond();
        return Instant.ofEpochSecond(seconds - Math.floorMod(seconds, 900));
    }

    static Instant dayStart(Instant now) {
        return now.truncatedTo(ChronoUnit.DAYS);
    }
}
