package com.englishcoach.auth.service;

import com.englishcoach.auth.entity.AuthActionToken;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthActionTokenRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Slf4j
public class AuthActionTokenService {

    private final AuthActionTokenRepository actionTokenRepository;
    private final SecureRandom secureRandom = new SecureRandom();

    public static String digest(String rawToken) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(rawToken.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 unavailable", e);
        }
    }

    @Transactional
    public String createActionToken(User user, String purpose, long durationMinutes,
                                    String boundEmailNormalized, UUID boundSessionId,
                                    String metadataJson, Long generation) {
        return createActionToken(user, purpose, durationMinutes, boundEmailNormalized, boundSessionId,
                metadataJson, generation, true);
    }

    /**
     * {@code revokePrevious = false} keeps the user's earlier unused tokens of this purpose valid until they expire.
     * Used for EMAIL_VERIFICATION only: every such token went to the same inbox, a resent mail may arrive after the
     * first one, and consuming any of them revokes the rest ({@link #revokeRemaining}).
     */
    @Transactional
    public String createActionToken(User user, String purpose, long durationMinutes,
                                    String boundEmailNormalized, UUID boundSessionId,
                                    String metadataJson, Long generation, boolean revokePrevious) {
        byte[] randomBytes = new byte[32];
        secureRandom.nextBytes(randomBytes);
        String rawToken = HexFormat.of().formatHex(randomBytes);
        String tokenDigest = digest(rawToken);

        if (revokePrevious) {
            // Invalidate any active tokens for this user and purpose
            actionTokenRepository.revokeActiveTokensForUserAndPurpose(user.getId(), purpose, Instant.now());
        }

        AuthActionToken actionToken = AuthActionToken.builder()
                .tokenDigest(tokenDigest)
                .user(user)
                .purpose(purpose)
                .boundEmailNormalized(boundEmailNormalized)
                .boundSessionId(boundSessionId)
                .metadata(metadataJson)
                .generation(generation != null ? generation : 0L)
                .expiresAt(Instant.now().plus(durationMinutes, ChronoUnit.MINUTES))
                .build();

        actionTokenRepository.save(actionToken);
        return rawToken;
    }

    @Transactional
    public AuthActionToken consumeActionToken(String rawToken, String expectedPurpose) {
        if (rawToken == null || rawToken.isBlank()) {
            throw new IllegalArgumentException("Action token is required");
        }

        String tokenDigest = digest(rawToken);
        AuthActionToken token = actionTokenRepository.findByTokenDigest(tokenDigest)
                .orElseThrow(() -> new IllegalArgumentException("Invalid or expired action token"));

        if (!token.getPurpose().equalsIgnoreCase(expectedPurpose)) {
            throw new IllegalArgumentException("Token purpose mismatch");
        }

        if (token.getUsedAt() != null) {
            throw new IllegalArgumentException("Action token has already been used");
        }

        if (token.getRevokedAt() != null) {
            throw new IllegalArgumentException("Action token has been revoked");
        }

        if (Instant.now().isAfter(token.getExpiresAt())) {
            throw new IllegalArgumentException("Action token has expired");
        }

        User tokenUser = token.getUser();
        if (tokenUser != null) {
            if ("DISABLED".equalsIgnoreCase(tokenUser.getAccountStatus())) {
                throw new IllegalArgumentException("Action token is no longer valid");
            }
            if ("PASSWORD_RESET".equalsIgnoreCase(expectedPurpose) || "GOOGLE_LINK".equalsIgnoreCase(expectedPurpose)) {
                long tokenGeneration = token.getGeneration() != null ? token.getGeneration() : 0L;
                long userGeneration = tokenUser.getCredentialVersion() != null ? tokenUser.getCredentialVersion() : 0L;
                if (tokenGeneration != userGeneration) {
                    throw new IllegalArgumentException("Action token has been superseded");
                }
            }
        }

        Instant now = Instant.now();
        if (token.getId() != null) {
            int updated = actionTokenRepository.markUsedIfUnused(token.getId(), now);
            if (updated != 1) {
                throw new IllegalArgumentException("Action token has already been used");
            }
            token.setUsedAt(now);
            return token;
        }
        token.setUsedAt(now);
        return actionTokenRepository.save(token);
    }

    /** Revokes the user's other unused tokens of this purpose (after one of them was consumed). */
    @Transactional
    public void revokeRemaining(Long userId, String purpose) {
        actionTokenRepository.revokeActiveTokensForUserAndPurpose(userId, purpose, Instant.now());
    }

    /** Revokes all unused tokens for the user across the specified purposes (e.g. upon password change). */
    @Transactional
    public void revokeActiveTokens(Long userId, java.util.Collection<String> purposes) {
        if (userId == null || purposes == null || purposes.isEmpty()) {
            return;
        }
        Instant now = Instant.now();
        for (String purpose : purposes) {
            if (purpose != null && !purpose.isBlank()) {
                actionTokenRepository.revokeActiveTokensForUserAndPurpose(userId, purpose, now);
            }
        }
    }

    /**
     * The user of a REAL token of this purpose that can no longer be consumed (used, revoked or expired), so a page can
     * say "already verified" for an old link instead of "invalid". Empty for an unknown value; the caller decides from
     * the user's state, and nothing is changed.
     */
    @Transactional(readOnly = true)
    public java.util.Optional<User> findUserOfSpentToken(String rawToken, String expectedPurpose) {
        if (rawToken == null || rawToken.isBlank()) return java.util.Optional.empty();
        return actionTokenRepository.findByTokenDigest(digest(rawToken))
                .filter(t -> t.getPurpose().equalsIgnoreCase(expectedPurpose))
                .filter(t -> t.getUsedAt() != null || t.getRevokedAt() != null || Instant.now().isAfter(t.getExpiresAt()))
                .map(AuthActionToken::getUser);
    }
}
