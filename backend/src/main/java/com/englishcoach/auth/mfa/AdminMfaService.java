package com.englishcoach.auth.mfa;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.policy.OfficialAdminPolicy;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.SecurityAuditService;
import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.AuthSessionContext.AdminAccess;
import com.englishcoach.common.security.DerivedKeys;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The administrator's second factor: enrolment, verification, recovery and step-up.
 *
 * <p>Rules that hold for every method here:
 * <ul>
 *   <li>only the official administrator account (stored role + e-mail) has second factors;</li>
 *   <li>the FIRST factor may be enrolled only by a session that signed in recently
 *       ({@link #BOOTSTRAP_WINDOW}); every later change of factors needs a fresh second-factor proof (step-up);</li>
 *   <li>a successful verification marks the SESSION (not the account, not the browser): another session of the same
 *       account stays unverified;</li>
 *   <li>any change of factors signs every other session of the account out;</li>
 *   <li>failures are counted and bounded ({@link MfaAttemptLimiter}); every outcome is audited without the code,
 *       the secret or the recovery code.</li>
 * </ul>
 */
@Service
@Slf4j
public class AdminMfaService {

    /** How recently the session must have signed in to enrol the very first factor. */
    static final Duration BOOTSTRAP_WINDOW = Duration.ofMinutes(30);
    static final Duration CHALLENGE_TTL = Duration.ofMinutes(5);
    static final int RECOVERY_CODE_COUNT = 10;
    /**
     * 25 characters of a 32-letter alphabet: 125 bits. A lookup secret of 112 bits or more may be stored under a
     * plain cryptographic hash (it cannot be guessed, online or from a copy of the digests); a shorter one would
     * need a slow password hash.
     */
    static final int RECOVERY_CODE_LENGTH = 25;
    static final int MAX_WEBAUTHN_CREDENTIALS = 8;
    private static final String RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    static final String PURPOSE_REGISTER = "WEBAUTHN_REGISTER";
    static final String PURPOSE_ASSERT = "WEBAUTHN_ASSERT";

    private static final int LOCK_MFA_FACTORS = 0x4543_4D46;

    private final MfaStore store;
    private final AdminMfaGate gate;
    private final MfaAttemptLimiter limiter;
    private final MfaSecretCipher cipher;
    private final WebAuthnVerifier webAuthn;
    private final UserRepository users;
    private final SecurityAuditService audit;
    private final AuthSecurityProperties properties;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();
    private final byte[] handleKey;
    private final Object factorRemovalMonitor = new Object();

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.jdbc.core.JdbcTemplate jdbc;

    private void lockFactorMutations(long userId) {
        if (jdbc != null) {
            jdbc.query("SELECT pg_advisory_xact_lock(?, ?)", rs -> null,
                    LOCK_MFA_FACTORS, (int) (userId ^ (userId >>> 32)));
        }
    }

    @org.springframework.beans.factory.annotation.Autowired
    public AdminMfaService(MfaStore store, AdminMfaGate gate, MfaAttemptLimiter limiter, MfaSecretCipher cipher,
                           WebAuthnVerifier webAuthn, UserRepository users, SecurityAuditService audit,
                           AuthSecurityProperties properties) {
        this(store, gate, limiter, cipher, webAuthn, users, audit, properties, Clock.systemUTC());
    }

    AdminMfaService(MfaStore store, AdminMfaGate gate, MfaAttemptLimiter limiter, MfaSecretCipher cipher,
                    WebAuthnVerifier webAuthn, UserRepository users, SecurityAuditService audit,
                    AuthSecurityProperties properties, Clock clock) {
        this.store = store;
        this.gate = gate;
        this.limiter = limiter;
        this.cipher = cipher;
        this.webAuthn = webAuthn;
        this.users = users;
        this.audit = audit;
        this.properties = properties;
        this.clock = clock;
        this.handleKey = DerivedKeys.derive(properties.getJwtSecret(), DerivedKeys.MFA_CHALLENGE);
    }

    /** Who is asking: the account and the session of the current request, as the request path read them. */
    public record Caller(long userId, UUID sessionId, Instant authenticatedAt, Instant mfaVerifiedAt,
                         Instant stepUpAt, String ipAddress, String userAgent) {}

    public static class MfaException extends RuntimeException {
        private final HttpStatus status;
        private final String code;

        public MfaException(HttpStatus status, String code, String message) {
            super(message);
            this.status = status;
            this.code = code;
        }

        public HttpStatus status() {
            return status;
        }

        public String code() {
            return code;
        }
    }

    // ------------------------------------------------------------------ status

    public Map<String, Object> status(Caller caller) {
        User user = administrator(caller);
        boolean enrolled = gate.enrolled(user.getId());
        AdminAccess access = gate.accessFor(user.getId(), caller.mfaVerifiedAt());
        Instant now = clock.instant();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enrolled", enrolled);
        out.put("required", properties.isAdminMfaRequired());
        out.put("adminAccess", access.name());
        out.put("sessionVerified", caller.mfaVerifiedAt() != null);
        out.put("stepUpFresh", stepUpFresh(caller, now));
        out.put("stepUpMinutes", properties.getAdminStepUpMinutes());
        out.put("canEnrollFirstFactor", !enrolled && recentlySignedIn(caller, now));
        out.put("webauthn", store.webAuthnCredentials(user.getId()).stream().map(c -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.id().toString());
            m.put("label", c.label());
            m.put("createdAt", c.createdAt());
            m.put("lastUsedAt", c.lastUsedAt());
            m.put("syncedPasskey", c.backupEligible());
            return m;
        }).toList());
        var totp = store.totp(user.getId());
        out.put("totpEnrolled", totp.map(t -> t.confirmedAt() != null).orElse(false));
        out.put("recoveryCodesRemaining", store.unusedRecoveryCodes(user.getId()));
        return out;
    }

    // ------------------------------------------------------------------ TOTP enrolment

    public Map<String, Object> startTotpEnrollment(Caller caller) {
        User user = administrator(caller);
        requireMayChangeFactors(caller, user);
        byte[] secret = TotpCodes.newSecret();
        if (!store.upsertPendingTotp(user.getId(), cipher.encrypt(secret, user.getId()), cipher.currentVersion())) {
            throw new MfaException(HttpStatus.CONFLICT, "TOTP_ALREADY_ENROLLED",
                    "An authenticator app is already enrolled. Remove it before enrolling another.");
        }
        record(caller, "MFA_TOTP_ENROLL_STARTED", "SUCCESS", null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("secret", TotpCodes.base32(secret));
        out.put("otpauthUri", TotpCodes.provisioningUri("English Coach", user.getEmail(), secret));
        out.put("digits", TotpCodes.DIGITS);
        out.put("periodSeconds", TotpCodes.STEP_SECONDS);
        return out;
    }

    public Map<String, Object> confirmTotpEnrollment(Caller caller, String code) {
        User user = administrator(caller);
        requireMayChangeFactors(caller, user);
        Instant now = clock.instant();
        requireNotBlocked(caller, now);
        var pending = store.totp(user.getId()).filter(t -> t.confirmedAt() == null)
                .orElseThrow(() -> new MfaException(HttpStatus.CONFLICT, "NO_PENDING_ENROLLMENT",
                        "Start the authenticator app enrolment again."));
        boolean wasEnrolled = gate.enrolled(user.getId());
        long step = TotpCodes.matchingStep(cipher.decrypt(pending.secretCiphertext(), pending.keyVersion(), user.getId()), code,
                now.getEpochSecond(), pending.lastUsedStep());
        if (step < 0 || !store.confirmTotp(user.getId(), step, now)) {
            failed(caller, "MFA_TOTP_ENROLL_CONFIRM", "INVALID_CODE", now);
            throw invalidCode();
        }
        return factorAdded(caller, user, "TOTP", wasEnrolled, now);
    }

    @org.springframework.transaction.annotation.Transactional
    public void removeTotp(Caller caller) {
        User user = administrator(caller);
        requireStepUp(caller);
        synchronized (factorRemovalMonitor) {
            lockFactorMutations(user.getId());
            requireNotLastFactor(user, store.webAuthnCredentials(user.getId()).size());
            if (!store.deleteTotp(user.getId())) {
                throw new MfaException(HttpStatus.NOT_FOUND, "NOT_FOUND", "No authenticator app is enrolled.");
            }
            requireNotLastFactor(user, store.webAuthnCredentials(user.getId()).size());
            factorRemoved(caller, user, "TOTP");
        }
    }

    // ------------------------------------------------------------------ WebAuthn enrolment

    public Map<String, Object> startWebAuthnRegistration(Caller caller) {
        User user = administrator(caller);
        requireMayChangeFactors(caller, user);
        var existing = store.webAuthnCredentials(user.getId());
        if (existing.size() >= MAX_WEBAUTHN_CREDENTIALS) {
            throw new MfaException(HttpStatus.CONFLICT, "TOO_MANY_CREDENTIALS", "Remove a passkey before adding another.");
        }
        Instant now = clock.instant();
        byte[] challenge = newChallenge();
        UUID challengeId = UUID.randomUUID();
        store.insertChallenge(new MfaStore.Challenge(challengeId, user.getId(), caller.sessionId(), PURPOSE_REGISTER,
                b64(challenge)), now.plus(CHALLENGE_TTL));
        store.deleteExpiredChallenges(now);

        Map<String, Object> publicKey = new LinkedHashMap<>();
        publicKey.put("rp", Map.of("id", webAuthn.rpId(), "name", "English Coach"));
        publicKey.put("user", Map.of("id", b64(userHandle(user.getId())), "name", user.getEmail(),
                "displayName", user.getName() != null && !user.getName().isBlank() ? user.getName() : user.getEmail()));
        publicKey.put("challenge", b64(challenge));
        publicKey.put("pubKeyCredParams", WebAuthnVerifier.ALGORITHMS.stream()
                .map(p -> Map.of("type", "public-key", "alg", p.getAlg().getValue())).toList());
        publicKey.put("timeout", CHALLENGE_TTL.toMillis());
        publicKey.put("attestation", "none");
        publicKey.put("authenticatorSelection", Map.of("residentKey", "discouraged", "requireResidentKey", false,
                "userVerification", "required"));
        publicKey.put("excludeCredentials", descriptors(existing));
        return Map.of("challengeId", challengeId.toString(), "publicKey", publicKey);
    }

    public Map<String, Object> finishWebAuthnRegistration(Caller caller, String challengeId, String label,
                                                          String credentialJson) {
        User user = administrator(caller);
        requireMayChangeFactors(caller, user);
        Instant now = clock.instant();
        var challenge = store.consumeChallenge(parseId(challengeId), user.getId(), caller.sessionId(),
                PURPOSE_REGISTER, now).orElseThrow(AdminMfaService::challengeExpired);
        boolean wasEnrolled = gate.enrolled(user.getId());
        WebAuthnVerifier.Registered registered;
        try {
            registered = webAuthn.verifyRegistration(credentialJson, unb64(challenge.challenge()));
        } catch (WebAuthnVerifier.WebAuthnRejectedException e) {
            log.warn("[MFA] WebAuthn registration refused for user {}: {}", user.getId(), e.getMessage());
            record(caller, "MFA_WEBAUTHN_ENROLL", "FAILURE", "VERIFICATION_FAILED");
            throw new MfaException(HttpStatus.BAD_REQUEST, "WEBAUTHN_REJECTED",
                    "The passkey could not be verified. Try again.");
        }
        boolean inserted = store.insertWebAuthnCredential(new MfaStore.WebAuthnCredential(null, user.getId(),
                registered.credentialId(), registered.attestedCredentialData(), registered.signCount(),
                registered.transports(), registered.backupEligible(), registered.backupState(), cleanLabel(label),
                now, null));
        if (!inserted) {
            throw new MfaException(HttpStatus.CONFLICT, "CREDENTIAL_EXISTS", "This passkey is already registered.");
        }
        return factorAdded(caller, user, "WEBAUTHN", wasEnrolled, now);
    }

    @org.springframework.transaction.annotation.Transactional
    public void removeWebAuthnCredential(Caller caller, String id) {
        User user = administrator(caller);
        requireStepUp(caller);
        UUID credentialId = parseId(id);
        synchronized (factorRemovalMonitor) {
            lockFactorMutations(user.getId());
            var credentials = store.webAuthnCredentials(user.getId());
            boolean exists = credentials.stream().anyMatch(c -> credentialId.equals(c.id()));
            if (!exists) {
                throw new MfaException(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such passkey.");
            }
            int others = credentials.size() - 1;
            boolean totp = store.totp(user.getId()).map(t -> t.confirmedAt() != null).orElse(false);
            requireNotLastFactor(user, others + (totp ? 1 : 0));
            if (!store.deleteWebAuthnCredential(user.getId(), credentialId)) {
                throw new MfaException(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such passkey.");
            }
            int remainingWebAuthn = store.webAuthnCredentials(user.getId()).size();
            boolean remainingTotp = store.totp(user.getId()).map(t -> t.confirmedAt() != null).orElse(false);
            requireNotLastFactor(user, remainingWebAuthn + (remainingTotp ? 1 : 0));
            factorRemoved(caller, user, "WEBAUTHN");
        }
    }

    // ------------------------------------------------------------------ verification and step-up

    public Map<String, Object> startWebAuthnAssertion(Caller caller) {
        User user = administrator(caller);
        var credentials = store.webAuthnCredentials(user.getId());
        if (credentials.isEmpty()) {
            throw new MfaException(HttpStatus.CONFLICT, "NO_PASSKEY", "No passkey is enrolled.");
        }
        Instant now = clock.instant();
        byte[] challenge = newChallenge();
        UUID challengeId = UUID.randomUUID();
        store.insertChallenge(new MfaStore.Challenge(challengeId, user.getId(), caller.sessionId(), PURPOSE_ASSERT,
                b64(challenge)), now.plus(CHALLENGE_TTL));
        Map<String, Object> publicKey = new LinkedHashMap<>();
        publicKey.put("challenge", b64(challenge));
        publicKey.put("rpId", webAuthn.rpId());
        publicKey.put("timeout", CHALLENGE_TTL.toMillis());
        publicKey.put("userVerification", "required");
        publicKey.put("allowCredentials", descriptors(credentials));
        return Map.of("challengeId", challengeId.toString(), "publicKey", publicKey);
    }

    /**
     * Proves a second factor for the caller's session: it becomes verified (administrator authority from the next
     * request on) and stepped up for {@code admin-step-up-minutes}.
     *
     * @param method WEBAUTHN, TOTP or RECOVERY_CODE
     */
    public Map<String, Object> verify(Caller caller, String method, String code, String challengeId,
                                      String credentialJson) {
        User user = administrator(caller);
        if (!gate.enrolled(user.getId())) {
            throw new MfaException(HttpStatus.CONFLICT, "NOT_ENROLLED", "No second factor is enrolled.");
        }
        Instant now = clock.instant();
        requireNotBlocked(caller, now);
        String used = method == null ? "" : method.trim().toUpperCase();
        boolean ok = switch (used) {
            case "TOTP" -> verifyTotp(user, code, now);
            case "RECOVERY_CODE" -> code != null
                    && store.consumeRecoveryCode(user.getId(), recoveryDigest(user.getId(), code), now);
            case "WEBAUTHN" -> verifyWebAuthn(caller, user, challengeId, credentialJson, now);
            default -> throw new MfaException(HttpStatus.BAD_REQUEST, "UNKNOWN_METHOD", "Unknown second-factor method.");
        };
        if (!ok) {
            failed(caller, "MFA_VERIFY", used, now);
            throw invalidCode();
        }
        if (!store.markSessionVerified(caller.sessionId(), user.getId(), used, now)) {
            throw new MfaException(HttpStatus.UNAUTHORIZED, "SESSION_ENDED", "The session has ended. Sign in again.");
        }
        record(caller, "MFA_VERIFIED", "SUCCESS", used);
        if ("RECOVERY_CODE".equals(used)) {
            log.warn("[MFA] A recovery code was used for user {} ({} left)", user.getId(),
                    store.unusedRecoveryCodes(user.getId()));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("verified", true);
        out.put("method", used);
        out.put("stepUpUntil", now.plus(Duration.ofMinutes(properties.getAdminStepUpMinutes())));
        out.put("recoveryCodesRemaining", store.unusedRecoveryCodes(user.getId()));
        return out;
    }

    private boolean verifyTotp(User user, String code, Instant now) {
        var totp = store.totp(user.getId()).filter(t -> t.confirmedAt() != null).orElse(null);
        if (totp == null) return false;
        byte[] seed = cipher.decrypt(totp.secretCiphertext(), totp.keyVersion(), user.getId());
        long step = TotpCodes.matchingStep(seed, code, now.getEpochSecond(), totp.lastUsedStep());
        // The conditional write is the replay guard: of two requests with one code only one advances the step.
        boolean accepted = step >= 0 && store.advanceTotpStep(user.getId(), step);
        if (accepted && totp.keyVersion() != cipher.currentVersion()) {
            // Key rotation without re-enrolment: the seed moves to the newest key the first time it is used.
            if (store.reencryptTotp(user.getId(), totp.secretCiphertext(), cipher.encrypt(seed, user.getId()),
                    cipher.currentVersion())) {
                log.info("[MFA] Authenticator seed of user {} re-encrypted under key version {}", user.getId(),
                        cipher.currentVersion());
            }
        }
        Arrays.fill(seed, (byte) 0);
        return accepted;
    }

    private boolean verifyWebAuthn(Caller caller, User user, String challengeId, String credentialJson, Instant now) {
        var challenge = store.consumeChallenge(parseId(challengeId), user.getId(), caller.sessionId(), PURPOSE_ASSERT,
                now).orElseThrow(AdminMfaService::challengeExpired);
        try {
            var stored = store.webAuthnCredential(user.getId(), webAuthn.credentialIdOf(credentialJson)).orElse(null);
            if (stored == null) return false;
            var asserted = webAuthn.verifyAssertion(credentialJson, unb64(challenge.challenge()), stored);
            store.updateWebAuthnUse(stored.id(), asserted.signCount(), asserted.backupState(), now);
            return true;
        } catch (WebAuthnVerifier.WebAuthnRejectedException e) {
            log.warn("[MFA] WebAuthn assertion refused for user {}: {}", user.getId(), e.getMessage());
            return false;
        }
    }

    public Map<String, Object> regenerateRecoveryCodes(Caller caller) {
        User user = administrator(caller);
        if (!gate.enrolled(user.getId())) {
            throw new MfaException(HttpStatus.CONFLICT, "NOT_ENROLLED", "Enrol a second factor first.");
        }
        requireStepUp(caller);
        List<String> codes = issueRecoveryCodes(user.getId());
        record(caller, "MFA_RECOVERY_CODES_REGENERATED", "SUCCESS", null);
        return Map.of("recoveryCodes", codes);
    }

    // ------------------------------------------------------------------ step-up for sensitive actions

    /** True when this session proved a second factor within the configured freshness window. */
    public boolean stepUpFresh(Caller caller, Instant now) {
        return caller.stepUpAt() != null
                && caller.stepUpAt().isAfter(now.minus(Duration.ofMinutes(properties.getAdminStepUpMinutes())));
    }

    public void requireStepUp(Caller caller) {
        if (!stepUpFresh(caller, clock.instant())) {
            throw new MfaException(HttpStatus.FORBIDDEN, "STEP_UP_REQUIRED",
                    "Confirm your second factor to continue.");
        }
    }

    // ------------------------------------------------------------------ internals

    private User administrator(Caller caller) {
        if (caller == null || caller.sessionId() == null) {
            throw new MfaException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "Sign in again.");
        }
        User user = users.findById(caller.userId()).orElse(null);
        if (user == null || !OfficialAdminPolicy.isOfficialAdmin(user.getEmail(), user.getRole())) {
            throw new MfaException(HttpStatus.FORBIDDEN, "NOT_AVAILABLE",
                    "Second factors are available to the administrator account only.");
        }
        return user;
    }

    private boolean recentlySignedIn(Caller caller, Instant now) {
        return caller.authenticatedAt() != null && caller.authenticatedAt().isAfter(now.minus(BOOTSTRAP_WINDOW));
    }

    /** First factor: a recent sign-in is enough. Any later change: a fresh second-factor proof. */
    private void requireMayChangeFactors(Caller caller, User user) {
        if (gate.enrolled(user.getId())) {
            requireStepUp(caller);
        } else if (!recentlySignedIn(caller, clock.instant())) {
            throw new MfaException(HttpStatus.FORBIDDEN, "REAUTH_REQUIRED",
                    "Sign out and sign in again, then enrol your second factor within 30 minutes.");
        }
    }

    private void requireNotLastFactor(User user, int remainingAfterRemoval) {
        if (remainingAfterRemoval <= 0 && properties.isAdminMfaRequired()) {
            throw new MfaException(HttpStatus.CONFLICT, "LAST_FACTOR",
                    "A second factor is required: enrol another one before removing this one.");
        }
    }

    private void requireNotBlocked(Caller caller, Instant now) {
        if (limiter.blocked(caller.userId(), now)) {
            record(caller, "MFA_VERIFY", "FAILURE", "LOCKED");
            throw new MfaException(HttpStatus.TOO_MANY_REQUESTS, "MFA_LOCKED",
                    "Too many failed attempts. Wait fifteen minutes and try again.");
        }
    }

    private void failed(Caller caller, String event, String reason, Instant now) {
        limiter.recordFailure(caller.userId(), now);
        record(caller, event, "FAILURE", reason);
    }

    private Map<String, Object> factorAdded(Caller caller, User user, String method, boolean wasEnrolled, Instant now) {
        gate.evict(user.getId());
        store.markSessionVerified(caller.sessionId(), user.getId(), method, now);
        int revoked = store.revokeOtherSessions(user.getId(), caller.sessionId(), "MFA_FACTOR_CHANGED", now);
        record(caller, "MFA_FACTOR_ENROLLED", "SUCCESS", method);
        log.info("[MFA] {} enrolled for user {}; {} other session(s) revoked", method, user.getId(), revoked);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enrolled", true);
        out.put("method", method);
        // Shown once, at the first enrolment; later only by an explicit regeneration.
        if (!wasEnrolled) out.put("recoveryCodes", issueRecoveryCodes(user.getId()));
        return out;
    }

    private void factorRemoved(Caller caller, User user, String method) {
        gate.evict(user.getId());
        if (!gate.enrolled(user.getId())) store.deleteRecoveryCodes(user.getId());
        store.revokeOtherSessions(user.getId(), caller.sessionId(), "MFA_FACTOR_CHANGED", clock.instant());
        record(caller, "MFA_FACTOR_REMOVED", "SUCCESS", method);
        log.info("[MFA] {} removed for user {}", method, user.getId());
    }

    private List<String> issueRecoveryCodes(long userId) {
        List<String> codes = new ArrayList<>();
        List<String> digests = new ArrayList<>();
        for (int i = 0; i < RECOVERY_CODE_COUNT; i++) {
            StringBuilder code = new StringBuilder();
            for (int c = 0; c < RECOVERY_CODE_LENGTH; c++) {
                if (c > 0 && c % 5 == 0) code.append('-');
                code.append(RECOVERY_ALPHABET.charAt(random.nextInt(RECOVERY_ALPHABET.length())));
            }
            codes.add(code.toString());
            digests.add(recoveryDigest(userId, code.toString()));
        }
        store.replaceRecoveryCodes(userId, digests);
        return codes;
    }

    /** Digest of a recovery code as typed (case, spaces and dashes do not matter). */
    static String recoveryDigest(long userId, String code) {
        String normalized = code.toUpperCase().replaceAll("[^A-Z0-9]", "");
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(sha.digest(("ec-recovery-v1:" + userId + ":" + normalized)
                    .getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private List<Map<String, Object>> descriptors(List<MfaStore.WebAuthnCredential> credentials) {
        return credentials.stream().map(c -> {
            Map<String, Object> d = new LinkedHashMap<>();
            d.put("type", "public-key");
            d.put("id", c.credentialId());
            if (c.transports() != null && !c.transports().isBlank()) {
                d.put("transports", Arrays.asList(c.transports().split(",")));
            }
            return d;
        }).toList();
    }

    private byte[] newChallenge() {
        byte[] challenge = new byte[32];
        random.nextBytes(challenge);
        return challenge;
    }

    /** A stable, opaque WebAuthn user handle: not the account id, not the address. */
    private byte[] userHandle(long userId) {
        return Arrays.copyOf(DerivedKeys.hmac(handleKey, ("user-handle:" + userId).getBytes(StandardCharsets.UTF_8)), 16);
    }

    private static String cleanLabel(String label) {
        String cleaned = label == null ? "" : label.replaceAll("[\\p{Cntrl}<>]", "").trim();
        if (cleaned.isEmpty()) cleaned = "Passkey";
        return cleaned.length() > 80 ? cleaned.substring(0, 80) : cleaned;
    }

    private static UUID parseId(String id) {
        try {
            return UUID.fromString(id);
        } catch (RuntimeException e) {
            throw new MfaException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Invalid identifier.");
        }
    }

    private static MfaException invalidCode() {
        return new MfaException(HttpStatus.BAD_REQUEST, "INVALID_CODE", "That did not verify. Try again.");
    }

    private static MfaException challengeExpired() {
        return new MfaException(HttpStatus.BAD_REQUEST, "CHALLENGE_EXPIRED", "The request expired. Try again.");
    }

    private void record(Caller caller, String event, String outcome, String reason) {
        audit.recordEvent(event, outcome, caller.userId(), caller.userId(),
                caller.sessionId() != null ? caller.sessionId().toString() : null, caller.ipAddress(),
                caller.userAgent(), reason, null);
    }

    private static String b64(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static byte[] unb64(String text) {
        return Base64.getUrlDecoder().decode(text);
    }
}
