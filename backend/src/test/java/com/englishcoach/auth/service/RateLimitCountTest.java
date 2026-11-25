package com.englishcoach.auth.service;

import com.englishcoach.auth.repository.AuthRateLimitBucketRepository;
import com.englishcoach.auth.repository.AuthSecurityStateRepository;
import com.englishcoach.common.security.AuthSecurityProperties;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * Phase 5: {@link LoginThrottleService#countRequest} is the bucket counter of {@code checkAndIncrementRateLimit} taken in
 * one statement. On real PostgreSQL 17 with the table exactly as V11 creates it: the same answers, the same stored
 * count, and no lost or failed request when many race for a new bucket.
 */
class RateLimitCountTest {

    static PostgreSQLContainer<?> postgres;
    static HikariDataSource ds;
    static JdbcTemplate jdbc;
    static LoginThrottleService throttle;

    @BeforeAll
    static void start() {
        postgres = new PostgreSQLContainer<>("postgres:17");
        postgres.start();
        HikariConfig hc = new HikariConfig();
        hc.setJdbcUrl(postgres.getJdbcUrl());
        hc.setUsername(postgres.getUsername());
        hc.setPassword(postgres.getPassword());
        hc.setMaximumPoolSize(12);
        ds = new HikariDataSource(hc);
        jdbc = new JdbcTemplate(ds);
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS public.auth_rate_limit_buckets (
                    kind VARCHAR(64) NOT NULL,
                    bucket_key VARCHAR(128) NOT NULL,
                    window_start TIMESTAMPTZ NOT NULL,
                    request_count INT NOT NULL DEFAULT 1,
                    expires_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (kind, bucket_key, window_start)
                );
                CREATE INDEX IF NOT EXISTS idx_auth_rate_limit_expires ON public.auth_rate_limit_buckets(expires_at);
                """);
        throttle = new LoginThrottleService(mock(AuthRateLimitBucketRepository.class), mock(AuthSecurityStateRepository.class),
                mock(SecurityAuditService.class), new AuthSecurityProperties());
        throttle.setJdbc(jdbc);
    }

    @AfterAll
    static void stop() {
        if (ds != null) ds.close();
        if (postgres != null) postgres.stop();
    }

    static int stored(String kind, String key) {
        Integer n = jdbc.queryForObject("SELECT COALESCE(sum(request_count), 0) FROM public.auth_rate_limit_buckets WHERE kind = ? AND bucket_key = ?",
                Integer.class, kind, key);
        return n == null ? 0 : n;
    }

    @Test
    void emailVerificationUsesTheSamePersistentCounterAsTheOtherDatabaseCallers() {
        String kind = "VERIFY_EMAIL_IP";
        String key = "staging-verification";
        assertTrue(throttle.checkAndIncrementRateLimit(kind, key, 20, 15));
        assertTrue(throttle.checkAndIncrementRateLimit(kind, key, 20, 15));
        assertEquals(2, stored(kind, key));
    }

    @Test
    void countsUpToTheLimitAndThenRefusesWithoutCounting() {
        for (int i = 1; i <= 5; i++) assertTrue(throttle.countRequest("GARDEN_COMMAND", "user:1", 5, 1), "request " + i);
        assertFalse(throttle.countRequest("GARDEN_COMMAND", "user:1", 5, 1));
        assertFalse(throttle.countRequest("GARDEN_COMMAND", "user:1", 5, 1));
        assertEquals(5, stored("GARDEN_COMMAND", "user:1"), "a refused request is not counted");
        // another key and another kind have their own buckets
        assertTrue(throttle.countRequest("GARDEN_COMMAND", "user:2", 5, 1));
        assertTrue(throttle.countRequest("GARDEN_ADMIN_QA", "user:1", 5, 1));
        assertEquals(1, jdbc.queryForObject("""
                SELECT count(*) FROM public.auth_rate_limit_buckets
                WHERE kind = 'GARDEN_COMMAND' AND bucket_key = 'user:1' AND expires_at = window_start + interval '1 minute'
                """, Integer.class), "one bucket per minute window, expiring with it");
    }

    @Test
    void racingRequestsForANewBucketAllCountAndNeverExceedTheLimit() throws Exception {
        // repeated so that at least one round does not straddle a minute boundary (two buckets would both be allowed)
        for (int round = 0; round < 3; round++) {
            String key = "user:race:" + round;
            var pool = Executors.newFixedThreadPool(12);
            List<Future<Boolean>> answers = new ArrayList<>();
            for (int i = 0; i < 40; i++) answers.add(pool.submit((Callable<Boolean>) () -> throttle.countRequest("GARDEN_COMMAND", key, 10, 1)));
            int allowed = 0;
            for (Future<Boolean> a : answers) if (a.get()) allowed++;
            pool.shutdown();
            int buckets = jdbc.queryForObject("SELECT count(*) FROM public.auth_rate_limit_buckets WHERE bucket_key = ?", Integer.class, key);
            assertEquals(10 * buckets, allowed, "exactly the limit is allowed per minute window, whatever the interleaving");
            assertEquals(allowed, stored("GARDEN_COMMAND", key));
        }
    }
}
