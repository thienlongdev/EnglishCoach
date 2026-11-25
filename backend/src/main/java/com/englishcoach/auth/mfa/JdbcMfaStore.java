package com.englishcoach.auth.mfa;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
@RequiredArgsConstructor
public class JdbcMfaStore implements MfaStore {

    private final JdbcTemplate jdbc;

    private static final RowMapper<WebAuthnCredential> CREDENTIAL = (rs, n) -> new WebAuthnCredential(
            rs.getObject("id", UUID.class), rs.getLong("user_id"), rs.getString("credential_id"),
            rs.getBytes("attested_credential_data"), rs.getLong("sign_count"), rs.getString("transports"),
            rs.getBoolean("backup_eligible"), rs.getBoolean("backup_state"), rs.getString("label"),
            instant(rs.getTimestamp("created_at")), instant(rs.getTimestamp("last_used_at")));

    private static Instant instant(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant();
    }

    @Override
    public List<WebAuthnCredential> webAuthnCredentials(long userId) {
        return jdbc.query("SELECT * FROM public.auth_mfa_webauthn_credentials WHERE user_id = ? ORDER BY created_at",
                CREDENTIAL, userId);
    }

    @Override
    public Optional<WebAuthnCredential> webAuthnCredential(long userId, String credentialId) {
        return jdbc.query("SELECT * FROM public.auth_mfa_webauthn_credentials WHERE user_id = ? AND credential_id = ?",
                CREDENTIAL, userId, credentialId).stream().findFirst();
    }

    @Override
    public boolean insertWebAuthnCredential(WebAuthnCredential c) {
        return jdbc.update("""
                INSERT INTO public.auth_mfa_webauthn_credentials
                    (user_id, credential_id, attested_credential_data, sign_count, transports, backup_eligible, backup_state, label)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (credential_id) DO NOTHING
                """, c.userId(), c.credentialId(), c.attestedCredentialData(), c.signCount(), c.transports(),
                c.backupEligible(), c.backupState(), c.label()) == 1;
    }

    @Override
    public void updateWebAuthnUse(UUID id, long signCount, boolean backupState, Instant usedAt) {
        jdbc.update("UPDATE public.auth_mfa_webauthn_credentials SET sign_count = ?, backup_state = ?, last_used_at = ? WHERE id = ?",
                signCount, backupState, Timestamp.from(usedAt), id);
    }

    @Override
    public boolean deleteWebAuthnCredential(long userId, UUID id) {
        return jdbc.update("DELETE FROM public.auth_mfa_webauthn_credentials WHERE user_id = ? AND id = ?", userId, id) == 1;
    }

    @Override
    public Optional<TotpFactor> totp(long userId) {
        return jdbc.query("SELECT user_id, secret_ciphertext, key_version, confirmed_at, last_used_step FROM public.auth_mfa_totp WHERE user_id = ?",
                (rs, n) -> new TotpFactor(rs.getLong("user_id"), rs.getBytes("secret_ciphertext"), rs.getShort("key_version"),
                        instant(rs.getTimestamp("confirmed_at")), rs.getLong("last_used_step")), userId)
                .stream().findFirst();
    }

    @Override
    public boolean upsertPendingTotp(long userId, byte[] secretCiphertext, short keyVersion) {
        return jdbc.update("""
                INSERT INTO public.auth_mfa_totp AS t (user_id, secret_ciphertext, key_version)
                VALUES (?, ?, ?)
                ON CONFLICT (user_id) DO UPDATE
                    SET secret_ciphertext = EXCLUDED.secret_ciphertext, key_version = EXCLUDED.key_version,
                        last_used_step = 0, created_at = now()
                    WHERE t.confirmed_at IS NULL
                """, userId, secretCiphertext, keyVersion) == 1;
    }

    @Override
    public boolean confirmTotp(long userId, long usedStep, Instant now) {
        return jdbc.update("UPDATE public.auth_mfa_totp SET confirmed_at = ?, last_used_step = ? WHERE user_id = ? AND confirmed_at IS NULL",
                Timestamp.from(now), usedStep, userId) == 1;
    }

    @Override
    public boolean advanceTotpStep(long userId, long usedStep) {
        return jdbc.update("UPDATE public.auth_mfa_totp SET last_used_step = ? WHERE user_id = ? AND confirmed_at IS NOT NULL AND last_used_step < ?",
                usedStep, userId, usedStep) == 1;
    }

    @Override
    public boolean reencryptTotp(long userId, byte[] expected, byte[] ciphertext, short keyVersion) {
        return jdbc.update("UPDATE public.auth_mfa_totp SET secret_ciphertext = ?, key_version = ? WHERE user_id = ? AND secret_ciphertext = ?",
                ciphertext, keyVersion, userId, expected) == 1;
    }

    @Override
    public boolean deleteTotp(long userId) {
        return jdbc.update("DELETE FROM public.auth_mfa_totp WHERE user_id = ?", userId) == 1;
    }

    @Override
    @Transactional
    public void replaceRecoveryCodes(long userId, List<String> digests) {
        jdbc.update("DELETE FROM public.auth_mfa_recovery_codes WHERE user_id = ?", userId);
        jdbc.batchUpdate("INSERT INTO public.auth_mfa_recovery_codes (user_id, code_digest) VALUES (?, ?)",
                digests.stream().map(d -> new Object[]{userId, d}).toList());
    }

    @Override
    public boolean consumeRecoveryCode(long userId, String digest, Instant now) {
        return jdbc.update("UPDATE public.auth_mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_digest = ? AND used_at IS NULL",
                Timestamp.from(now), userId, digest) == 1;
    }

    @Override
    public int unusedRecoveryCodes(long userId) {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM public.auth_mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL", Integer.class, userId);
        return count == null ? 0 : count;
    }

    @Override
    public void deleteRecoveryCodes(long userId) {
        jdbc.update("DELETE FROM public.auth_mfa_recovery_codes WHERE user_id = ?", userId);
    }

    @Override
    public void insertChallenge(Challenge c, Instant expiresAt) {
        jdbc.update("INSERT INTO public.auth_mfa_challenges (id, user_id, session_id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
                c.id(), c.userId(), c.sessionId(), c.purpose(), c.challenge(), Timestamp.from(expiresAt));
    }

    @Override
    public Optional<Challenge> consumeChallenge(UUID id, long userId, UUID sessionId, String purpose, Instant now) {
        return jdbc.query("""
                UPDATE public.auth_mfa_challenges SET consumed_at = ?
                WHERE id = ? AND user_id = ? AND session_id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
                RETURNING id, user_id, session_id, purpose, challenge
                """, (rs, n) -> new Challenge(rs.getObject("id", UUID.class), rs.getLong("user_id"),
                        rs.getObject("session_id", UUID.class), rs.getString("purpose"), rs.getString("challenge")),
                Timestamp.from(now), id, userId, sessionId, purpose, Timestamp.from(now)).stream().findFirst();
    }

    @Override
    public void deleteExpiredChallenges(Instant now) {
        jdbc.update("DELETE FROM public.auth_mfa_challenges WHERE expires_at < ?", Timestamp.from(now.minusSeconds(3600)));
    }

    @Override
    public boolean markSessionVerified(UUID sessionId, long userId, String method, Instant now) {
        return jdbc.update("""
                UPDATE public.auth_sessions
                SET mfa_verified_at = COALESCE(mfa_verified_at, ?), mfa_method = ?, step_up_at = ?
                WHERE id = ? AND user_id = ? AND state = 'ACTIVE'
                """, Timestamp.from(now), method, Timestamp.from(now), sessionId, userId) == 1;
    }

    @Override
    public int revokeOtherSessions(long userId, UUID keepSessionId, String reason, Instant now) {
        return jdbc.update("""
                UPDATE public.auth_sessions SET state = 'REVOKED', revoked_at = ?, revoked_reason = ?
                WHERE user_id = ? AND state IN ('ACTIVE', 'PENDING') AND id <> ?
                """, Timestamp.from(now), reason, userId, keepSessionId);
    }

    @Override
    public boolean recordEmergencyReset(String tokenDigest, Long targetUserId) {
        return jdbc.update("INSERT INTO public.auth_mfa_emergency_resets (token_digest, target_user_id) VALUES (?, ?) ON CONFLICT (token_digest) DO NOTHING",
                tokenDigest, targetUserId) == 1;
    }

    @Override
    @Transactional
    public void deleteAllFactors(long userId) {
        jdbc.update("DELETE FROM public.auth_mfa_webauthn_credentials WHERE user_id = ?", userId);
        jdbc.update("DELETE FROM public.auth_mfa_totp WHERE user_id = ?", userId);
        jdbc.update("DELETE FROM public.auth_mfa_recovery_codes WHERE user_id = ?", userId);
        jdbc.update("DELETE FROM public.auth_mfa_challenges WHERE user_id = ?", userId);
    }
}
