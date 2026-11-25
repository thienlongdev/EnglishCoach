package com.englishcoach.auth.mfa;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Persistence of second factors (V92). Every write that decides something is a single conditional statement. */
public interface MfaStore {

    record WebAuthnCredential(UUID id, long userId, String credentialId, byte[] attestedCredentialData,
                              long signCount, String transports, boolean backupEligible, boolean backupState,
                              String label, Instant createdAt, Instant lastUsedAt) {}

    record TotpFactor(long userId, byte[] secretCiphertext, short keyVersion, Instant confirmedAt, long lastUsedStep) {}

    record Challenge(UUID id, long userId, UUID sessionId, String purpose, String challenge) {}

    // --- WebAuthn credentials ---
    List<WebAuthnCredential> webAuthnCredentials(long userId);

    Optional<WebAuthnCredential> webAuthnCredential(long userId, String credentialId);

    /** False when that credential id is already registered (to this or any account). */
    boolean insertWebAuthnCredential(WebAuthnCredential credential);

    void updateWebAuthnUse(UUID id, long signCount, boolean backupState, Instant usedAt);

    boolean deleteWebAuthnCredential(long userId, UUID id);

    // --- TOTP ---
    Optional<TotpFactor> totp(long userId);

    /** Starts (or restarts) an enrolment; never replaces a CONFIRMED factor. False when one is confirmed. */
    boolean upsertPendingTotp(long userId, byte[] secretCiphertext, short keyVersion);

    boolean confirmTotp(long userId, long usedStep, Instant now);

    /** Records the step of an accepted code; false when that step (or a later one) was already used. */
    boolean advanceTotpStep(long userId, long usedStep);

    boolean deleteTotp(long userId);

    /** Replaces the stored ciphertext only if it is still {@code expected} (re-encryption under a newer key). */
    boolean reencryptTotp(long userId, byte[] expected, byte[] ciphertext, short keyVersion);

    // --- Recovery codes ---
    void replaceRecoveryCodes(long userId, List<String> digests);

    /** Spends one code; false when it does not exist or was already used. */
    boolean consumeRecoveryCode(long userId, String digest, Instant now);

    int unusedRecoveryCodes(long userId);

    void deleteRecoveryCodes(long userId);

    // --- Challenges ---
    void insertChallenge(Challenge challenge, Instant expiresAt);

    /** The challenge when it belongs to this account and session, has this purpose, is unexpired and unused; it is used up by this call. */
    Optional<Challenge> consumeChallenge(UUID id, long userId, UUID sessionId, String purpose, Instant now);

    void deleteExpiredChallenges(Instant now);

    // --- Sessions ---
    /** Marks an ACTIVE session as second-factor verified (first time) and stepped up now. */
    boolean markSessionVerified(UUID sessionId, long userId, String method, Instant now);

    int revokeOtherSessions(long userId, UUID keepSessionId, String reason, Instant now);

    // --- Emergency reset ---
    /** True the first time this digest is presented; the reset then removes every factor of the account. */
    boolean recordEmergencyReset(String tokenDigest, Long targetUserId);

    void deleteAllFactors(long userId);
}
