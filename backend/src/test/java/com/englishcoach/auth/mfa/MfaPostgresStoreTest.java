package com.englishcoach.auth.mfa;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * V92 executed unchanged on PostgreSQL 17 (on top of the session and rate-limit tables exactly as V11 creates
 * them), then the SQL store and the attempt limiter on it: every "once only" rule is a single conditional
 * statement, proven here with sixteen concurrent callers.
 */
class MfaPostgresStoreTest {

    private static final String MIGRATIONS = "src/main/resources/db/migration/exams/";
    private static PostgreSQLContainer<?> postgres;
    private static HikariDataSource dataSource;
    private static JdbcTemplate jdbc;
    private static JdbcMfaStore store;

    @BeforeAll
    static void start() throws Exception {
        postgres = new PostgreSQLContainer<>("postgres:17");
        postgres.start();
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(postgres.getJdbcUrl());
        config.setUsername(postgres.getUsername());
        config.setPassword(postgres.getPassword());
        config.setMaximumPoolSize(16);
        dataSource = new HikariDataSource(config);
        jdbc = new JdbcTemplate(dataSource);
        jdbc.execute("CREATE TABLE public.users (id BIGSERIAL PRIMARY KEY)");
        // The two tables V92 builds on, cut out of V11 verbatim.
        String v11 = Files.readString(Path.of(MIGRATIONS + "V11__auth_expand.sql"));
        jdbc.execute(between(v11, "-- 5. Create public.auth_sessions", "-- 6."));
        jdbc.execute(between(v11, "-- 7. Create public.auth_rate_limit_buckets", "-- 8."));
        String v92 = Files.readString(Path.of(MIGRATIONS + "V92__auth_admin_second_factor.sql"));
        jdbc.execute(v92);
        jdbc.execute(v92);   // every statement is IF NOT EXISTS: a second run changes nothing and fails nothing
        jdbc.update("INSERT INTO public.users (id) VALUES (1), (2), (3)");
        store = new JdbcMfaStore(jdbc);
    }

    @AfterAll
    static void stop() {
        if (dataSource != null) dataSource.close();
        if (postgres != null) postgres.stop();
    }

    private static String between(String text, String from, String to) {
        int start = text.indexOf(from);
        return text.substring(start, text.indexOf(to, start));
    }

    private static UUID session(long userId, String state) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO public.auth_sessions (id, user_id, session_grant_digest, state, idle_expires_at, absolute_expires_at)
                VALUES (?, ?, ?, ?, now() + interval '1 day', now() + interval '7 days')
                """, id, userId, UUID.randomUUID().toString().replace("-", "") + UUID.randomUUID().toString().replace("-", ""), state);
        return id;
    }

    /** How many of sixteen simultaneous callers got {@code true}. */
    private static int winners(Callable<Boolean> attempt) throws Exception {
        int callers = 16;
        ExecutorService pool = Executors.newFixedThreadPool(callers);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Boolean>> results = new ArrayList<>();
        for (int i = 0; i < callers; i++) {
            results.add(pool.submit(() -> {
                go.await();
                return attempt.call();
            }));
        }
        go.countDown();
        int won = 0;
        for (Future<Boolean> result : results) if (result.get()) won++;
        pool.shutdown();
        return won;
    }

    @Test
    @DisplayName("V92 is additive: old session rows keep working, the new columns are empty, the new tables exist")
    void migrationIsAdditive() {
        UUID id = session(1, "ACTIVE");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.auth_sessions WHERE id = ? AND mfa_verified_at IS NULL "
                + "AND mfa_method IS NULL AND step_up_at IS NULL", Integer.class, id)).isEqualTo(1);
        for (String table : new String[]{"auth_mfa_webauthn_credentials", "auth_mfa_totp", "auth_mfa_recovery_codes",
                "auth_mfa_challenges", "auth_mfa_emergency_resets"}) {
            assertThat(jdbc.queryForObject("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' "
                    + "AND table_name = ?", Integer.class, table)).as(table).isEqualTo(1);
        }
        // no secret column is a plain-text column: the TOTP seed is bytea ciphertext, recovery codes are digests
        assertThat(jdbc.queryForList("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' "
                + "AND table_name LIKE 'auth_mfa_%'", String.class))
                .contains("secret_ciphertext", "code_digest", "attested_credential_data")
                .doesNotContain("secret", "code", "private_key", "recovery_code");
    }

    @Test
    @DisplayName("A recovery code, a TOTP time step and a challenge are each spent by exactly one of sixteen concurrent callers")
    void onceOnlyUnderConcurrency() throws Exception {
        Instant now = Instant.now();
        store.replaceRecoveryCodes(1, List.of("a".repeat(64), "b".repeat(64)));
        assertThat(winners(() -> store.consumeRecoveryCode(1, "a".repeat(64), Instant.now()))).isEqualTo(1);
        assertThat(store.unusedRecoveryCodes(1)).isEqualTo(1);
        assertThat(store.consumeRecoveryCode(2, "b".repeat(64), now)).as("another account's code").isFalse();

        assertThat(store.upsertPendingTotp(1, new byte[]{1, 2, 3}, (short) 1)).isTrue();
        assertThat(store.upsertPendingTotp(1, new byte[]{4, 5, 6}, (short) 1)).as("a pending enrolment may restart").isTrue();
        assertThat(winners(() -> store.confirmTotp(1, 100, Instant.now()))).isEqualTo(1);
        assertThat(store.upsertPendingTotp(1, new byte[]{9}, (short) 1)).as("a confirmed factor is never overwritten").isFalse();
        assertThat(store.totp(1).orElseThrow().secretCiphertext()).containsExactly(4, 5, 6);
        assertThat(winners(() -> store.advanceTotpStep(1, 101))).isEqualTo(1);
        assertThat(store.advanceTotpStep(1, 101)).isFalse();
        assertThat(store.advanceTotpStep(1, 100)).as("an earlier step").isFalse();
        assertThat(store.advanceTotpStep(1, 102)).isTrue();

        UUID sessionId = session(1, "ACTIVE");
        UUID challengeId = UUID.randomUUID();
        store.insertChallenge(new MfaStore.Challenge(challengeId, 1, sessionId, "WEBAUTHN_ASSERT", "challenge-text"),
                now.plus(5, ChronoUnit.MINUTES));
        assertThat(store.consumeChallenge(challengeId, 2, sessionId, "WEBAUTHN_ASSERT", now)).as("another account").isEmpty();
        assertThat(store.consumeChallenge(challengeId, 1, UUID.randomUUID(), "WEBAUTHN_ASSERT", now)).as("another session").isEmpty();
        assertThat(store.consumeChallenge(challengeId, 1, sessionId, "WEBAUTHN_REGISTER", now)).as("another ceremony").isEmpty();
        assertThat(store.consumeChallenge(challengeId, 1, sessionId, "WEBAUTHN_ASSERT", now.plus(6, ChronoUnit.MINUTES))).as("expired").isEmpty();
        assertThat(winners(() -> store.consumeChallenge(challengeId, 1, sessionId, "WEBAUTHN_ASSERT", Instant.now()).isPresent())).isEqualTo(1);
        assertThatThrownBy(() -> store.insertChallenge(new MfaStore.Challenge(UUID.randomUUID(), 1, sessionId, "LOGIN", "x"), now))
                .as("only the two WebAuthn ceremonies are challenges").isInstanceOf(RuntimeException.class);
    }

    @Test
    @DisplayName("A credential id is registered once, to one account; use updates only the counter, backup state and time")
    void webAuthnCredentials() {
        var credential = new MfaStore.WebAuthnCredential(null, 2, "cred-" + UUID.randomUUID(), new byte[]{7, 7, 7}, 0,
                "internal,usb", true, false, "Laptop", Instant.now(), null);
        assertThat(store.insertWebAuthnCredential(credential)).isTrue();
        assertThat(store.insertWebAuthnCredential(credential)).as("same account again").isFalse();
        assertThat(store.insertWebAuthnCredential(new MfaStore.WebAuthnCredential(null, 3, credential.credentialId(),
                new byte[]{1}, 0, null, false, false, "Other", Instant.now(), null))).as("another account").isFalse();
        var stored = store.webAuthnCredential(2, credential.credentialId()).orElseThrow();
        assertThat(store.webAuthnCredential(3, credential.credentialId())).isEmpty();
        Instant used = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        store.updateWebAuthnUse(stored.id(), 9, true, used);
        var after = store.webAuthnCredentials(2).get(0);
        assertThat(after.signCount()).isEqualTo(9);
        assertThat(after.backupState()).isTrue();
        assertThat(after.lastUsedAt()).isEqualTo(used);
        assertThat(after.attestedCredentialData()).containsExactly(7, 7, 7);
        assertThat(after.label()).isEqualTo("Laptop");
        assertThat(store.deleteWebAuthnCredential(3, stored.id())).as("another account cannot delete it").isFalse();
        assertThat(store.deleteWebAuthnCredential(2, stored.id())).isTrue();
    }

    @Test
    @DisplayName("Verifying marks only an ACTIVE session of that account; a factor change revokes the account's other sessions only")
    void sessionMarksAndRevocation() {
        UUID mine = session(3, "ACTIVE"), other = session(3, "ACTIVE"), pending = session(3, "PENDING"),
                revoked = session(3, "REVOKED"), foreign = session(2, "ACTIVE");
        Instant first = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        assertThat(store.markSessionVerified(mine, 3, "TOTP", first)).isTrue();
        assertThat(store.markSessionVerified(mine, 3, "WEBAUTHN", first.plusSeconds(60))).isTrue();
        var row = jdbc.queryForMap("SELECT mfa_verified_at, mfa_method, step_up_at FROM public.auth_sessions WHERE id = ?", mine);
        assertThat(((java.sql.Timestamp) row.get("mfa_verified_at")).toInstant()).as("first verification time is kept").isEqualTo(first);
        assertThat(((java.sql.Timestamp) row.get("step_up_at")).toInstant()).isEqualTo(first.plusSeconds(60));
        assertThat(row.get("mfa_method")).isEqualTo("WEBAUTHN");
        assertThat(store.markSessionVerified(mine, 2, "TOTP", first)).as("another account's claim on this session").isFalse();
        assertThat(store.markSessionVerified(revoked, 3, "TOTP", first)).as("a revoked session").isFalse();

        assertThat(store.revokeOtherSessions(3, mine, "MFA_FACTOR_CHANGED", Instant.now())).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT state FROM public.auth_sessions WHERE id = ?", String.class, mine)).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("SELECT state FROM public.auth_sessions WHERE id = ?", String.class, other)).isEqualTo("REVOKED");
        assertThat(jdbc.queryForObject("SELECT state FROM public.auth_sessions WHERE id = ?", String.class, pending)).isEqualTo("REVOKED");
        assertThat(jdbc.queryForObject("SELECT state FROM public.auth_sessions WHERE id = ?", String.class, foreign)).isEqualTo("ACTIVE");
    }

    @Test
    @DisplayName("Attempt limiter: six failures in a quarter of an hour, or twenty in a day, block that account and only that account")
    void attemptLimiter() {
        MfaAttemptLimiter limiter = new MfaAttemptLimiter(jdbc);
        Instant now = Instant.parse("2026-10-15T08:07:00Z");
        for (int i = 0; i < 5; i++) limiter.recordFailure(2, now.plusSeconds(i));
        assertThat(limiter.blocked(2, now)).isFalse();
        limiter.recordFailure(2, now);
        assertThat(limiter.blocked(2, now)).isTrue();
        assertThat(limiter.blocked(3, now)).as("another account").isFalse();
        assertThat(limiter.blocked(2, Instant.parse("2026-10-15T08:15:00Z"))).as("the next quarter of an hour").isFalse();
        // five failures in each of three more quarters: 6 + 15 = 21 in the day
        for (String quarter : new String[]{"2026-10-15T09:00:00Z", "2026-10-15T10:00:00Z", "2026-10-15T11:00:00Z"}) {
            for (int i = 0; i < 5; i++) limiter.recordFailure(2, Instant.parse(quarter));
        }
        assertThat(limiter.blocked(2, Instant.parse("2026-10-15T20:00:00Z"))).as("the daily bound").isTrue();
        assertThat(limiter.blocked(2, Instant.parse("2026-10-16T00:00:01Z"))).as("the next day").isFalse();
    }

    @Test
    @DisplayName("Emergency reset is recorded once per value and removes every factor of the account; deleting an account removes its factors")
    void emergencyResetAndCascade() {
        assertThat(store.recordEmergencyReset("d".repeat(64), 1L)).isTrue();
        assertThat(store.recordEmergencyReset("d".repeat(64), 1L)).isFalse();

        jdbc.update("INSERT INTO public.users (id) VALUES (50)");
        store.insertWebAuthnCredential(new MfaStore.WebAuthnCredential(null, 50, "cred-50", new byte[]{1}, 0, null,
                false, false, "k", Instant.now(), null));
        store.upsertPendingTotp(50, new byte[]{1}, (short) 1);
        store.replaceRecoveryCodes(50, List.of("e".repeat(64)));
        store.deleteAllFactors(50);
        assertThat(store.webAuthnCredentials(50)).isEmpty();
        assertThat(store.totp(50)).isEmpty();
        assertThat(store.unusedRecoveryCodes(50)).isZero();

        store.upsertPendingTotp(50, new byte[]{1}, (short) 1);
        store.replaceRecoveryCodes(50, List.of("f".repeat(64)));
        jdbc.update("DELETE FROM public.users WHERE id = 50");
        assertThat(jdbc.queryForObject("SELECT (SELECT count(*) FROM public.auth_mfa_totp WHERE user_id = 50) + "
                + "(SELECT count(*) FROM public.auth_mfa_recovery_codes WHERE user_id = 50)", Integer.class)).isZero();
    }
}
