package com.englishcoach.auth.mfa;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.mfa.AdminMfaService.Caller;
import com.englishcoach.auth.mfa.AdminMfaService.MfaException;
import com.englishcoach.auth.policy.OfficialAdminPolicy;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.auth.service.SecurityAuditService;
import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.AuthSessionContext.AdminAccess;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import static com.englishcoach.auth.mfa.SoftwareAuthenticator.AT;
import static com.englishcoach.auth.mfa.SoftwareAuthenticator.UP;
import static com.englishcoach.auth.mfa.SoftwareAuthenticator.UV;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The administrator's second factor end to end at the service: enrolment, verification, replay, recovery, lockout,
 * step-up, removal and the emergency reset, on the in-memory store (same conditional semantics as the SQL).
 */
class AdminMfaServiceTest {

    private static final long ADMIN = 1L, LEARNER = 7L;
    private static final String RP_ID = "englishcoach.io.vn", ORIGIN = "https://englishcoach.io.vn";

    /** A clock the test moves. */
    static final class MovingClock extends Clock {
        Instant now = Instant.parse("2026-10-15T08:00:10Z");

        @Override public ZoneId getZone() { return ZoneId.of("UTC"); }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
        void advance(Duration duration) { now = now.plus(duration); }
    }

    /** The limiter's thresholds without a database. */
    static final class CountingLimiter extends MfaAttemptLimiter {
        final Map<Long, Integer> failures = new HashMap<>();

        CountingLimiter() { super(null); }
        @Override public boolean blocked(long userId, Instant now) { return failures.getOrDefault(userId, 0) >= MAX_PER_QUARTER_HOUR; }
        @Override public void recordFailure(long userId, Instant now) { failures.merge(userId, 1, Integer::sum); }
    }

    private final InMemoryMfaStore store = new InMemoryMfaStore();
    private final MovingClock clock = new MovingClock();
    private final CountingLimiter limiter = new CountingLimiter();
    private final AuthSecurityProperties properties = new AuthSecurityProperties();
    private final UserRepository users = mock(UserRepository.class);
    private final SecurityAuditService audit = mock(SecurityAuditService.class);
    private AdminMfaGate gate;
    private MfaSecretCipher cipher;
    private AdminMfaService service;

    private final UUID sessionA = UUID.randomUUID(), sessionB = UUID.randomUUID(), learnerSession = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        properties.setJwtSecret("unit-test-application-signing-secret-0123456789");
        gate = new AdminMfaGate(store, properties);
        cipher = new MfaSecretCipher(properties);
        service = new AdminMfaService(store, gate, limiter, cipher, new WebAuthnVerifier(RP_ID, Set.of(ORIGIN)), users,
                audit, properties, clock);
        User admin = User.builder().id(ADMIN).email(OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL).name("Owner")
                .password("x").role(Role.ROLE_ADMIN).build();
        when(users.findById(ADMIN)).thenReturn(Optional.of(admin));
        when(users.findByEmailNormalized(OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL)).thenReturn(Optional.of(admin));
        when(users.findById(LEARNER)).thenReturn(Optional.of(User.builder().id(LEARNER).email("learner@example.test")
                .name("L").password("x").role(Role.ROLE_USER).build()));
        store.session(sessionA, ADMIN);
        store.session(sessionB, ADMIN);
        store.session(learnerSession, LEARNER);
    }

    /** The caller as the request path would build it: session facts read from the store, signed in at the given time. */
    private Caller caller(UUID session, long userId, Instant signedInAt) {
        return new Caller(userId, session, signedInAt, store.mfaVerifiedAt(session), store.stepUpAt(session),
                "203.0.113.5", "JUnit");
    }

    private Caller admin(UUID session) {
        return caller(session, ADMIN, clock.instant().minusSeconds(60));
    }

    private String totpNow(String base32Secret) {
        return TotpCodes.codeAt(base32Decode(base32Secret), TotpCodes.stepAt(clock.instant().getEpochSecond()));
    }

    /** Enrols an authenticator app from session A and returns [secret, recovery codes]. */
    @SuppressWarnings("unchecked")
    private Object[] enrolTotp() {
        String secret = (String) service.startTotpEnrollment(admin(sessionA)).get("secret");
        Map<String, Object> result = service.confirmTotpEnrollment(admin(sessionA), totpNow(secret));
        return new Object[]{secret, (List<String>) result.get("recoveryCodes")};
    }

    private static void assertRefused(org.assertj.core.api.ThrowableAssert.ThrowingCallable call, HttpStatus status, String code) {
        assertThatThrownBy(call).isInstanceOfSatisfying(MfaException.class, e -> {
            assertThat(e.code()).isEqualTo(code);
            assertThat(e.status()).isEqualTo(status);
        });
    }

    // ---------------------------------------------------------------- who and when

    @Test
    @DisplayName("Second factors belong to the administrator account only; a learner gets nothing, not even a status")
    void onlyTheAdministratorAccount() {
        Caller learner = caller(learnerSession, LEARNER, clock.instant());
        assertRefused(() -> service.status(learner), HttpStatus.FORBIDDEN, "NOT_AVAILABLE");
        assertRefused(() -> service.startTotpEnrollment(learner), HttpStatus.FORBIDDEN, "NOT_AVAILABLE");
        assertRefused(() -> service.startWebAuthnRegistration(learner), HttpStatus.FORBIDDEN, "NOT_AVAILABLE");
        assertRefused(() -> service.verify(learner, "TOTP", "000000", null, null), HttpStatus.FORBIDDEN, "NOT_AVAILABLE");
        assertRefused(() -> service.status(new Caller(ADMIN, null, clock.instant(), null, null, "ip", "ua")),
                HttpStatus.UNAUTHORIZED, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("The first factor can be enrolled only by a session that signed in within the last 30 minutes")
    void firstFactorNeedsRecentSignIn() {
        Caller stale = caller(sessionA, ADMIN, clock.instant().minus(Duration.ofMinutes(31)));
        assertThat(service.status(stale).get("canEnrollFirstFactor")).isEqualTo(false);
        assertRefused(() -> service.startTotpEnrollment(stale), HttpStatus.FORBIDDEN, "REAUTH_REQUIRED");
        assertRefused(() -> service.startWebAuthnRegistration(stale), HttpStatus.FORBIDDEN, "REAUTH_REQUIRED");
        assertThat(service.status(admin(sessionA)).get("canEnrollFirstFactor")).isEqualTo(true);
        assertThat(service.startTotpEnrollment(admin(sessionA))).containsKey("secret");
    }

    @Test
    @DisplayName("Before enrolment the policy admits the administrator only while enrolment is not yet required")
    void gateBeforeEnrolment() {
        assertThat(gate.accessFor(ADMIN, null)).isEqualTo(AdminAccess.GRANTED);
        properties.setAdminMfaRequired(true);
        assertThat(gate.accessFor(ADMIN, null)).isEqualTo(AdminAccess.ENROLLMENT_REQUIRED);
        assertThat(service.status(admin(sessionA))).containsEntry("adminAccess", "ENROLLMENT_REQUIRED")
                .containsEntry("enrolled", false).containsEntry("required", true);
        // enrolling is still possible: that is how the requirement is met
        assertThat(service.startTotpEnrollment(admin(sessionA))).containsKey("otpauthUri");
    }

    // ---------------------------------------------------------------- authenticator app

    @Test
    @DisplayName("TOTP enrolment: a wrong code enrols nothing; the right one enrols, verifies this session, signs the others out, and shows recovery codes once")
    void totpEnrolment() {
        Map<String, Object> started = service.startTotpEnrollment(admin(sessionA));
        String secret = (String) started.get("secret");
        assertThat(secret).matches("[A-Z2-7]{32}");
        assertThat((String) started.get("otpauthUri")).startsWith("otpauth://totp/English%20Coach%3A").contains("secret=" + secret);
        // at rest: encrypted, bound to the account; the plain secret is nowhere in the row
        byte[] stored = store.totp(ADMIN).orElseThrow().secretCiphertext();
        assertThat(stored).hasSize(12 + 20 + 16).isNotEqualTo(base32Decode(secret));
        short version = store.totp(ADMIN).orElseThrow().keyVersion();
        assertThat(cipher.decrypt(stored, version, ADMIN)).isEqualTo(base32Decode(secret));
        assertThatThrownBy(() -> cipher.decrypt(stored, version, LEARNER)).isInstanceOf(IllegalStateException.class);

        assertRefused(() -> service.confirmTotpEnrollment(admin(sessionA), "000000".equals(totpNow(secret)) ? "111111" : "000000"),
                HttpStatus.BAD_REQUEST, "INVALID_CODE");
        assertThat(gate.enrolled(ADMIN)).isFalse();
        assertThat(limiter.failures.get(ADMIN)).isEqualTo(1);

        Map<String, Object> enrolled = service.confirmTotpEnrollment(admin(sessionA), totpNow(secret));
        @SuppressWarnings("unchecked") List<String> codes = (List<String>) enrolled.get("recoveryCodes");
        assertThat(codes).hasSize(10).allMatch(c -> c.matches("[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){4}")).doesNotHaveDuplicates();
        assertThat(AdminMfaService.RECOVERY_CODE_LENGTH * 5).as("bits of entropy per recovery code").isGreaterThanOrEqualTo(112);
        assertThat(store.recovery.get(ADMIN).keySet()).noneMatch(codes::contains).allMatch(d -> d.matches("[0-9a-f]{64}"));
        assertThat(gate.enrolled(ADMIN)).isTrue();
        assertThat(store.mfaVerifiedAt(sessionA)).isEqualTo(clock.instant());
        assertThat(store.state(sessionB)).isEqualTo("REVOKED");
        assertThat(store.state(learnerSession)).isEqualTo("ACTIVE");
        // from now on a session of this account is an administrator only after the second factor
        assertThat(gate.accessFor(ADMIN, null)).isEqualTo(AdminAccess.MFA_REQUIRED);
        assertThat(gate.accessFor(ADMIN, clock.instant())).isEqualTo(AdminAccess.GRANTED);
        // a second authenticator app cannot silently replace the first
        clock.advance(Duration.ofSeconds(1));
        assertRefused(() -> service.startTotpEnrollment(admin(sessionA)), HttpStatus.CONFLICT, "TOTP_ALREADY_ENROLLED");
    }

    @Test
    @DisplayName("TOTP verification marks the session; the same code never works twice, on this or any other session")
    void totpVerifyAndReplay() {
        String secret = (String) enrolTotp()[0];
        UUID fresh = UUID.randomUUID();
        store.session(fresh, ADMIN);
        clock.advance(Duration.ofSeconds(30));
        String code = totpNow(secret);
        Map<String, Object> verified = service.verify(admin(fresh), "totp", code, null, null);
        assertThat(verified).containsEntry("verified", true).containsEntry("method", "TOTP");
        assertThat(store.mfaVerifiedAt(fresh)).isEqualTo(clock.instant());
        // replay of the observed code: by the same session and by another one
        assertRefused(() -> service.verify(admin(fresh), "TOTP", code, null, null), HttpStatus.BAD_REQUEST, "INVALID_CODE");
        UUID attacker = UUID.randomUUID();
        store.session(attacker, ADMIN);
        assertRefused(() -> service.verify(admin(attacker), "TOTP", code, null, null), HttpStatus.BAD_REQUEST, "INVALID_CODE");
        assertThat(store.mfaVerifiedAt(attacker)).isNull();
        // the next time step's code is a new code
        clock.advance(Duration.ofSeconds(30));
        assertThat(service.verify(admin(attacker), "TOTP", totpNow(secret), null, null)).containsEntry("verified", true);
        assertRefused(() -> service.verify(admin(fresh), "PUSH", "1", null, null), HttpStatus.BAD_REQUEST, "UNKNOWN_METHOD");
    }

    @Test
    @DisplayName("Key separation: a seed under the derived key moves to the dedicated key on first use and then survives a token-secret rotation")
    void seedMovesToDedicatedKey() {
        String secret = (String) enrolTotp()[0];
        assertThat(store.totp(ADMIN).orElseThrow().keyVersion()).isEqualTo(MfaSecretCipher.DERIVED_KEY_VERSION);
        // release with the dedicated key: the old seed is still readable and is re-encrypted after one accepted code
        properties.setMfaEncryptionKey("dedicated-mfa-encryption-key-for-tests-0123456789");
        cipher = new MfaSecretCipher(properties);
        service = new AdminMfaService(store, gate, limiter, cipher, new WebAuthnVerifier(RP_ID, Set.of(ORIGIN)), users,
                audit, properties, clock);
        UUID fresh = UUID.randomUUID();
        store.session(fresh, ADMIN);
        clock.advance(Duration.ofSeconds(30));
        assertThat(service.verify(admin(fresh), "TOTP", totpNow(secret), null, null)).containsEntry("verified", true);
        var moved = store.totp(ADMIN).orElseThrow();
        assertThat(moved.keyVersion()).isEqualTo(MfaSecretCipher.DEDICATED_KEY_VERSION);
        assertThat(cipher.decrypt(moved.secretCiphertext(), moved.keyVersion(), ADMIN)).isEqualTo(base32Decode(secret));
        // the token-signing secret is rotated: the seed does not depend on it any more
        properties.setJwtSecret("rotated-application-signing-secret-9876543210-abcdef");
        MfaSecretCipher afterRotation = new MfaSecretCipher(properties);
        assertThat(afterRotation.decrypt(moved.secretCiphertext(), moved.keyVersion(), ADMIN)).isEqualTo(base32Decode(secret));
        // and the derived key can no longer open it
        assertThatThrownBy(() -> afterRotation.decrypt(moved.secretCiphertext(), MfaSecretCipher.DERIVED_KEY_VERSION, ADMIN))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("Guessing is bounded: after six failures every attempt is refused, the right code included")
    void lockoutAfterRepeatedFailures() {
        String secret = (String) enrolTotp()[0];
        UUID fresh = UUID.randomUUID();
        store.session(fresh, ADMIN);
        clock.advance(Duration.ofSeconds(60));
        String right = totpNow(secret);
        String wrong = right.equals("000000") ? "111111" : "000000";
        for (int i = 0; i < 6; i++) {
            assertRefused(() -> service.verify(admin(fresh), "TOTP", wrong, null, null), HttpStatus.BAD_REQUEST, "INVALID_CODE");
        }
        assertRefused(() -> service.verify(admin(fresh), "TOTP", right, null, null), HttpStatus.TOO_MANY_REQUESTS, "MFA_LOCKED");
        assertRefused(() -> service.verify(admin(fresh), "RECOVERY_CODE", "AAAAA-AAAAA-AAAAA", null, null), HttpStatus.TOO_MANY_REQUESTS, "MFA_LOCKED");
        assertThat(store.mfaVerifiedAt(fresh)).isNull();
    }

    // ---------------------------------------------------------------- recovery codes

    @Test
    @DisplayName("A recovery code works once, however it is typed; regeneration needs a fresh proof and voids the old codes")
    void recoveryCodes() {
        @SuppressWarnings("unchecked") List<String> codes = (List<String>) enrolTotp()[1];
        UUID fresh = UUID.randomUUID();
        store.session(fresh, ADMIN);
        String code = codes.get(0);
        String typed = " " + code.toLowerCase().replace("-", " ") + " ";
        assertThat(service.verify(admin(fresh), "RECOVERY_CODE", typed, null, null))
                .containsEntry("verified", true).containsEntry("recoveryCodesRemaining", 9);
        UUID other = UUID.randomUUID();
        store.session(other, ADMIN);
        assertRefused(() -> service.verify(admin(other), "RECOVERY_CODE", code, null, null), HttpStatus.BAD_REQUEST, "INVALID_CODE");
        // a learner's digest space is separate: the same text under another account is another digest
        assertThat(AdminMfaService.recoveryDigest(ADMIN, code)).isNotEqualTo(AdminMfaService.recoveryDigest(LEARNER, code));

        // regeneration: only with a fresh second-factor proof
        assertRefused(() -> service.regenerateRecoveryCodes(admin(other)), HttpStatus.FORBIDDEN, "STEP_UP_REQUIRED");
        @SuppressWarnings("unchecked") List<String> renewed = (List<String>) service.regenerateRecoveryCodes(admin(fresh)).get("recoveryCodes");
        assertThat(renewed).hasSize(10).doesNotContainAnyElementsOf(codes);
        assertRefused(() -> service.verify(admin(other), "RECOVERY_CODE", codes.get(1), null, null), HttpStatus.BAD_REQUEST, "INVALID_CODE");
        assertThat(service.verify(admin(other), "RECOVERY_CODE", renewed.get(3), null, null)).containsEntry("verified", true);
    }

    // ---------------------------------------------------------------- step-up

    @Test
    @DisplayName("Step-up is freshness: a proof counts for ten minutes, then sensitive actions and factor changes need it again")
    void stepUpFreshness() {
        String secret = (String) enrolTotp()[0];
        assertThat(service.stepUpFresh(admin(sessionA), clock.instant())).isTrue();
        service.requireStepUp(admin(sessionA));
        clock.advance(Duration.ofMinutes(9));
        service.requireStepUp(admin(sessionA));
        clock.advance(Duration.ofMinutes(2));
        assertRefused(() -> service.requireStepUp(admin(sessionA)), HttpStatus.FORBIDDEN, "STEP_UP_REQUIRED");
        assertThat(service.status(admin(sessionA))).containsEntry("stepUpFresh", false).containsEntry("sessionVerified", true);
        // adding a passkey, removing the app, renewing codes: all are factor changes
        assertRefused(() -> service.startWebAuthnRegistration(admin(sessionA)), HttpStatus.FORBIDDEN, "STEP_UP_REQUIRED");
        assertRefused(() -> service.removeTotp(admin(sessionA)), HttpStatus.FORBIDDEN, "STEP_UP_REQUIRED");
        assertRefused(() -> service.regenerateRecoveryCodes(admin(sessionA)), HttpStatus.FORBIDDEN, "STEP_UP_REQUIRED");
        // a session that never passed the factor is never stepped up, however recently it signed in
        UUID unverified = UUID.randomUUID();
        store.session(unverified, ADMIN);
        assertRefused(() -> service.startWebAuthnRegistration(caller(unverified, ADMIN, clock.instant())), HttpStatus.FORBIDDEN, "STEP_UP_REQUIRED");
        // proving the factor again restores it
        service.verify(admin(sessionA), "TOTP", totpNow(secret), null, null);
        service.requireStepUp(admin(sessionA));
        assertThat(service.startWebAuthnRegistration(admin(sessionA))).containsKey("challengeId");
    }

    // ---------------------------------------------------------------- passkeys

    @SuppressWarnings("unchecked")
    private static byte[] challengeOf(Map<String, Object> options) {
        return Base64.getUrlDecoder().decode((String) ((Map<String, Object>) options.get("publicKey")).get("challenge"));
    }

    @Test
    @DisplayName("Passkey enrolment and sign-in: challenge bound to account + session, usable once, five minutes; forged responses fail")
    @SuppressWarnings("unchecked")
    void webAuthnEnrolmentAndAssertion() {
        SoftwareAuthenticator key = new SoftwareAuthenticator();
        Map<String, Object> options = service.startWebAuthnRegistration(admin(sessionA));
        Map<String, Object> publicKey = (Map<String, Object>) options.get("publicKey");
        assertThat((Map<String, Object>) publicKey.get("rp")).containsEntry("id", RP_ID);
        assertThat(publicKey).containsEntry("attestation", "none");
        assertThat((Map<String, Object>) publicKey.get("authenticatorSelection")).containsEntry("userVerification", "required");
        assertThat((String) ((Map<String, Object>) publicKey.get("user")).get("id")).doesNotContain("1").hasSizeGreaterThan(20);
        String challengeId = (String) options.get("challengeId");
        String response = key.register(challengeOf(options), ORIGIN, RP_ID, UP | UV | AT, 0);

        // the challenge belongs to session A: another session of the same account cannot finish it
        assertRefused(() -> service.finishWebAuthnRegistration(admin(sessionB), challengeId, "Stolen", response),
                HttpStatus.BAD_REQUEST, "CHALLENGE_EXPIRED");
        Map<String, Object> enrolled = service.finishWebAuthnRegistration(admin(sessionA), challengeId, " My <b>key</b> ", response);
        assertThat((List<String>) enrolled.get("recoveryCodes")).hasSize(10);
        assertThat(store.credentials).singleElement().satisfies(c -> {
            assertThat(c.label()).isEqualTo("My bkey/b");
            assertThat(c.credentialId()).isEqualTo(key.credentialIdBase64());
        });
        // the challenge is spent
        assertRefused(() -> service.finishWebAuthnRegistration(admin(sessionA), challengeId, "Again", response),
                HttpStatus.BAD_REQUEST, "CHALLENGE_EXPIRED");

        // sign-in on a new session
        UUID fresh = UUID.randomUUID();
        store.session(fresh, ADMIN);
        Map<String, Object> assertOptions = service.startWebAuthnAssertion(admin(fresh));
        assertThat((List<Map<String, Object>>) ((Map<String, Object>) assertOptions.get("publicKey")).get("allowCredentials"))
                .singleElement().satisfies(d -> assertThat(d).containsEntry("id", key.credentialIdBase64()));
        String assertionChallenge = (String) assertOptions.get("challengeId");
        // a response from a phishing origin, with the genuine key: refused, and the challenge is spent by the attempt
        assertRefused(() -> service.verify(admin(fresh), "WEBAUTHN", null, assertionChallenge,
                key.assertion(challengeOf(assertOptions), "https://evil.example", RP_ID, UP | UV, 1, false)),
                HttpStatus.BAD_REQUEST, "INVALID_CODE");
        assertThat(store.mfaVerifiedAt(fresh)).isNull();
        assertRefused(() -> service.verify(admin(fresh), "WEBAUTHN", null, assertionChallenge,
                key.assertion(challengeOf(assertOptions), ORIGIN, RP_ID, UP | UV, 1, false)),
                HttpStatus.BAD_REQUEST, "CHALLENGE_EXPIRED");

        Map<String, Object> second = service.startWebAuthnAssertion(admin(fresh));
        assertThat(service.verify(admin(fresh), "WEBAUTHN", null, (String) second.get("challengeId"),
                key.assertion(challengeOf(second), ORIGIN, RP_ID, UP | UV, 1, false))).containsEntry("verified", true);
        assertThat(store.mfaVerifiedAt(fresh)).isNotNull();
        assertThat(store.credentials.get(0).signCount()).isEqualTo(1);
        assertThat(store.credentials.get(0).lastUsedAt()).isEqualTo(clock.instant());

        // a challenge older than five minutes is dead
        Map<String, Object> third = service.startWebAuthnAssertion(admin(fresh));
        clock.advance(Duration.ofMinutes(5).plusSeconds(1));
        assertRefused(() -> service.verify(admin(fresh), "WEBAUTHN", null, (String) third.get("challengeId"),
                key.assertion(challengeOf(third), ORIGIN, RP_ID, UP | UV, 2, false)), HttpStatus.BAD_REQUEST, "CHALLENGE_EXPIRED");
        // an unknown authenticator answering a genuine challenge
        Map<String, Object> fourth = service.startWebAuthnAssertion(admin(fresh));
        assertRefused(() -> service.verify(admin(fresh), "WEBAUTHN", null, (String) fourth.get("challengeId"),
                new SoftwareAuthenticator().assertion(challengeOf(fourth), ORIGIN, RP_ID, UP | UV, 1, false)),
                HttpStatus.BAD_REQUEST, "INVALID_CODE");
        // the same authenticator cannot be enrolled twice
        service.verify(admin(fresh), "RECOVERY_CODE", ((List<String>) enrolled.get("recoveryCodes")).get(0), null, null);
        Map<String, Object> again = service.startWebAuthnRegistration(admin(fresh));
        assertThat((List<?>) ((Map<String, Object>) again.get("publicKey")).get("excludeCredentials")).hasSize(1);
        assertRefused(() -> service.finishWebAuthnRegistration(admin(fresh), (String) again.get("challengeId"), "dup",
                key.register(challengeOf(again), ORIGIN, RP_ID, UP | UV | AT, 0)), HttpStatus.CONFLICT, "CREDENTIAL_EXISTS");
    }

    // ---------------------------------------------------------------- removal and emergency reset

    @Test
    @DisplayName("Removing the last factor is refused once a factor is required; otherwise it also discards the recovery codes")
    void removingFactors() {
        enrolTotp();
        properties.setAdminMfaRequired(true);
        assertRefused(() -> service.removeTotp(admin(sessionA)), HttpStatus.CONFLICT, "LAST_FACTOR");
        assertThat(gate.enrolled(ADMIN)).isTrue();
        properties.setAdminMfaRequired(false);
        service.removeTotp(admin(sessionA));
        assertThat(gate.enrolled(ADMIN)).isFalse();
        assertThat(store.unusedRecoveryCodes(ADMIN)).isZero();
        assertThat(gate.accessFor(ADMIN, null)).isEqualTo(AdminAccess.GRANTED);
        assertRefused(() -> service.verify(admin(sessionA), "TOTP", "123456", null, null), HttpStatus.CONFLICT, "NOT_ENROLLED");
    }

    @Test
    @DisplayName("Emergency reset: a fresh long value removes the factors and every session, once; the same value never works again")
    void emergencyReset() {
        enrolTotp();
        AuthSessionService sessions = mock(AuthSessionService.class);
        AdminMfaEmergencyReset reset = new AdminMfaEmergencyReset(properties, store, gate, users, sessions, audit);

        reset.run(null);                                                   // nothing configured: nothing happens
        properties.setAdminMfaEmergencyResetToken("too-short");
        reset.run(null);
        assertThat(gate.enrolled(ADMIN)).isTrue();

        properties.setAdminMfaEmergencyResetToken("owner-wrote-this-fresh-random-value-0001");
        reset.run(null);
        assertThat(gate.enrolled(ADMIN)).isFalse();
        assertThat(store.unusedRecoveryCodes(ADMIN)).isZero();
        verify(sessions).revokeAllUserSessions(ADMIN, "MFA_EMERGENCY_RESET");
        verify(audit).recordEvent(eq("MFA_EMERGENCY_RESET"), eq("SUCCESS"), any(), eq(ADMIN), any(), anyString(), anyString(), anyString(), any());

        // the administrator enrols again; the value left in the environment at the next restart does nothing
        store.session(sessionB, ADMIN);
        String secret = (String) service.startTotpEnrollment(admin(sessionB)).get("secret");
        service.confirmTotpEnrollment(admin(sessionB), totpNow(secret));
        reset.run(null);
        assertThat(gate.enrolled(ADMIN)).isTrue();
        verify(sessions).revokeAllUserSessions(ADMIN, "MFA_EMERGENCY_RESET");   // still exactly once
    }

    @Test
    @DisplayName("Every outcome is audited with the event and method, never with a code, a secret or a recovery code")
    void auditCarriesNoSecret() {
        Object[] enrolled = enrolTotp();
        String secret = (String) enrolled[0];
        @SuppressWarnings("unchecked") List<String> codes = (List<String>) enrolled[1];
        UUID fresh = UUID.randomUUID();
        store.session(fresh, ADMIN);
        clock.advance(Duration.ofSeconds(30));
        String code = totpNow(secret);
        service.verify(admin(fresh), "TOTP", code, null, null);
        service.verify(admin(fresh), "RECOVERY_CODE", codes.get(0), null, null);
        ArgumentCaptor<String> texts = ArgumentCaptor.forClass(String.class);
        verify(audit, atLeastOnce()).recordEvent(texts.capture(), texts.capture(), any(), any(), texts.capture(),
                texts.capture(), texts.capture(), texts.capture(), texts.capture());
        assertThat(texts.getAllValues()).contains("MFA_FACTOR_ENROLLED", "MFA_VERIFIED", "TOTP", "RECOVERY_CODE");
        assertThat(String.join("|", texts.getAllValues().stream().filter(v -> v != null).toList()))
                .doesNotContain(secret).doesNotContain(code).doesNotContain(codes.get(0));
    }

    private static byte[] base32Decode(String text) {
        String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        int buffer = 0, bits = 0;
        for (char c : text.toCharArray()) {
            buffer = (buffer << 5) | alphabet.indexOf(c);
            bits += 5;
            if (bits >= 8) {
                out.write((buffer >> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        return out.toByteArray();
    }
}
