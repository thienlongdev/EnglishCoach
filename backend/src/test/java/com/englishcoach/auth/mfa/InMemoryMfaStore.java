package com.englishcoach.auth.mfa;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/** The contract of {@link MfaStore} in memory, with the same conditional semantics as the SQL of {@link JdbcMfaStore}. */
class InMemoryMfaStore implements MfaStore {

    final List<WebAuthnCredential> credentials = new ArrayList<>();
    final Map<Long, TotpFactor> totp = new HashMap<>();
    final Map<Long, Map<String, Instant>> recovery = new HashMap<>();
    final Map<UUID, Object[]> challenges = new HashMap<>();   // challenge, expiresAt, consumed
    final Map<UUID, Object[]> sessions = new HashMap<>();     // userId, state, mfaVerifiedAt, method, stepUpAt
    final Set<String> resets = new HashSet<>();

    void session(UUID id, long userId) {
        sessions.put(id, new Object[]{userId, "ACTIVE", null, null, null});
    }

    @Override
    public List<WebAuthnCredential> webAuthnCredentials(long userId) {
        return credentials.stream().filter(c -> c.userId() == userId).toList();
    }

    @Override
    public Optional<WebAuthnCredential> webAuthnCredential(long userId, String credentialId) {
        return credentials.stream().filter(c -> c.userId() == userId && c.credentialId().equals(credentialId)).findFirst();
    }

    @Override
    public boolean insertWebAuthnCredential(WebAuthnCredential c) {
        if (credentials.stream().anyMatch(x -> x.credentialId().equals(c.credentialId()))) return false;
        credentials.add(new WebAuthnCredential(UUID.randomUUID(), c.userId(), c.credentialId(), c.attestedCredentialData(),
                c.signCount(), c.transports(), c.backupEligible(), c.backupState(), c.label(), c.createdAt(), null));
        return true;
    }

    @Override
    public void updateWebAuthnUse(UUID id, long signCount, boolean backupState, Instant usedAt) {
        credentials.replaceAll(c -> c.id().equals(id) ? new WebAuthnCredential(c.id(), c.userId(), c.credentialId(),
                c.attestedCredentialData(), signCount, c.transports(), c.backupEligible(), backupState, c.label(),
                c.createdAt(), usedAt) : c);
    }

    @Override
    public boolean deleteWebAuthnCredential(long userId, UUID id) {
        return credentials.removeIf(c -> c.userId() == userId && c.id().equals(id));
    }

    @Override
    public Optional<TotpFactor> totp(long userId) {
        return Optional.ofNullable(totp.get(userId));
    }

    @Override
    public boolean upsertPendingTotp(long userId, byte[] secretCiphertext, short keyVersion) {
        TotpFactor existing = totp.get(userId);
        if (existing != null && existing.confirmedAt() != null) return false;
        totp.put(userId, new TotpFactor(userId, secretCiphertext, keyVersion, null, 0));
        return true;
    }

    @Override
    public boolean confirmTotp(long userId, long usedStep, Instant now) {
        TotpFactor existing = totp.get(userId);
        if (existing == null || existing.confirmedAt() != null) return false;
        totp.put(userId, new TotpFactor(userId, existing.secretCiphertext(), existing.keyVersion(), now, usedStep));
        return true;
    }

    @Override
    public boolean advanceTotpStep(long userId, long usedStep) {
        TotpFactor existing = totp.get(userId);
        if (existing == null || existing.confirmedAt() == null || existing.lastUsedStep() >= usedStep) return false;
        totp.put(userId, new TotpFactor(userId, existing.secretCiphertext(), existing.keyVersion(), existing.confirmedAt(), usedStep));
        return true;
    }

    @Override
    public boolean reencryptTotp(long userId, byte[] expected, byte[] ciphertext, short keyVersion) {
        TotpFactor existing = totp.get(userId);
        if (existing == null || !java.util.Arrays.equals(existing.secretCiphertext(), expected)) return false;
        totp.put(userId, new TotpFactor(userId, ciphertext, keyVersion, existing.confirmedAt(), existing.lastUsedStep()));
        return true;
    }

    @Override
    public boolean deleteTotp(long userId) {
        return totp.remove(userId) != null;
    }

    @Override
    public void replaceRecoveryCodes(long userId, List<String> digests) {
        Map<String, Instant> codes = new HashMap<>();
        digests.forEach(d -> codes.put(d, null));
        recovery.put(userId, codes);
    }

    @Override
    public boolean consumeRecoveryCode(long userId, String digest, Instant now) {
        Map<String, Instant> codes = recovery.get(userId);
        if (codes == null || !codes.containsKey(digest) || codes.get(digest) != null) return false;
        codes.put(digest, now);
        return true;
    }

    @Override
    public int unusedRecoveryCodes(long userId) {
        Map<String, Instant> codes = recovery.get(userId);
        return codes == null ? 0 : (int) codes.values().stream().filter(v -> v == null).count();
    }

    @Override
    public void deleteRecoveryCodes(long userId) {
        recovery.remove(userId);
    }

    @Override
    public void insertChallenge(Challenge challenge, Instant expiresAt) {
        challenges.put(challenge.id(), new Object[]{challenge, expiresAt, Boolean.FALSE});
    }

    @Override
    public Optional<Challenge> consumeChallenge(UUID id, long userId, UUID sessionId, String purpose, Instant now) {
        Object[] row = challenges.get(id);
        if (row == null) return Optional.empty();
        Challenge challenge = (Challenge) row[0];
        if (challenge.userId() != userId || !challenge.sessionId().equals(sessionId) || !challenge.purpose().equals(purpose)
                || Boolean.TRUE.equals(row[2]) || !((Instant) row[1]).isAfter(now)) return Optional.empty();
        row[2] = Boolean.TRUE;
        return Optional.of(challenge);
    }

    @Override
    public void deleteExpiredChallenges(Instant now) {
        challenges.values().removeIf(row -> ((Instant) row[1]).isBefore(now.minusSeconds(3600)));
    }

    @Override
    public boolean markSessionVerified(UUID sessionId, long userId, String method, Instant now) {
        Object[] row = sessions.get(sessionId);
        if (row == null || (long) row[0] != userId || !"ACTIVE".equals(row[1])) return false;
        if (row[2] == null) row[2] = now;
        row[3] = method;
        row[4] = now;
        return true;
    }

    @Override
    public int revokeOtherSessions(long userId, UUID keepSessionId, String reason, Instant now) {
        int revoked = 0;
        for (var entry : sessions.entrySet()) {
            Object[] row = entry.getValue();
            if ((long) row[0] == userId && !entry.getKey().equals(keepSessionId) && "ACTIVE".equals(row[1])) {
                row[1] = "REVOKED";
                revoked++;
            }
        }
        return revoked;
    }

    @Override
    public boolean recordEmergencyReset(String tokenDigest, Long targetUserId) {
        return resets.add(tokenDigest);
    }

    @Override
    public void deleteAllFactors(long userId) {
        credentials.removeIf(c -> c.userId() == userId);
        totp.remove(userId);
        recovery.remove(userId);
        challenges.values().removeIf(row -> ((Challenge) row[0]).userId() == userId);
    }

    Instant mfaVerifiedAt(UUID sessionId) {
        return (Instant) sessions.get(sessionId)[2];
    }

    Instant stepUpAt(UUID sessionId) {
        return (Instant) sessions.get(sessionId)[4];
    }

    String state(UUID sessionId) {
        return (String) sessions.get(sessionId)[1];
    }
}
