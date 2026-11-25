package com.englishcoach.auth.service;

import com.englishcoach.auth.entity.AuthSession;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthSessionRepository;
import com.englishcoach.common.security.AppJwtService;
import com.englishcoach.common.security.AuthSecurityProperties;
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
public class AuthSessionService {

    private final AuthSessionRepository sessionRepository;
    private final AppJwtService appJwtService;
    private final AuthSecurityProperties securityProperties;
    private final SecureRandom secureRandom = new SecureRandom();

    public static String digest(String grantToken) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(grantToken.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 unavailable", e);
        }
    }

    @Transactional
    public PendingSessionResult createPendingSession(User user, String authMethod) {
        byte[] randomBytes = new byte[32];
        secureRandom.nextBytes(randomBytes);
        String rawSessionGrant = HexFormat.of().formatHex(randomBytes);
        String grantDigest = digest(rawSessionGrant);

        Instant now = Instant.now();
        Instant pendingExpiresAt = now.plus(securityProperties.getSessionPendingLifetimeMinutes(), ChronoUnit.MINUTES);
        Instant idleExpiresAt = now.plus(securityProperties.getSessionIdleLifetimeHours(), ChronoUnit.HOURS);
        Instant absoluteExpiresAt = now.plus(securityProperties.getSessionAbsoluteLifetimeDays(), ChronoUnit.DAYS);

        AuthSession session = AuthSession.builder()
                .user(user)
                .sessionGrantDigest(grantDigest)
                .state("PENDING")
                .authMethod(authMethod)
                .pendingExpiresAt(pendingExpiresAt)
                .idleExpiresAt(idleExpiresAt)
                .absoluteExpiresAt(absoluteExpiresAt)
                .authenticatedAt(now)
                .build();

        sessionRepository.save(session);
        return new PendingSessionResult(session.getId(), rawSessionGrant);
    }

    @Transactional
    public SessionActivationResult activateSession(String rawSessionGrant) {
        if (rawSessionGrant == null || rawSessionGrant.isBlank()) {
            throw new IllegalArgumentException("Session grant is required");
        }

        String grantDigest = digest(rawSessionGrant);
        AuthSession session = sessionRepository.findBySessionGrantDigest(grantDigest)
                .orElseThrow(() -> new IllegalArgumentException("Invalid session grant"));

        User sessionUser = session.getUser();
        if (sessionUser == null || !"ACTIVE".equalsIgnoreCase(sessionUser.getAccountStatus())) {
            throw new IllegalStateException("User account is not active");
        }

        Instant now = Instant.now();

        if ("PENDING".equals(session.getState())) {
            if (session.getPendingExpiresAt() != null && now.isAfter(session.getPendingExpiresAt())) {
                session.setState("REVOKED");
                session.setRevokedAt(now);
                session.setRevokedReason("PENDING_ACTIVATION_TIMEOUT");
                sessionRepository.save(session);
                throw new IllegalStateException("Pending session expired");
            }
            session.setState("ACTIVE");
            session.setActivatedAt(now);
        } else if (!"ACTIVE".equals(session.getState())) {
            throw new IllegalStateException("Session is not active (state=" + session.getState() + ")");
        }

        if (now.isAfter(session.getAbsoluteExpiresAt())) {
            session.setState("REVOKED");
            session.setRevokedAt(now);
            session.setRevokedReason("ABSOLUTE_LIFETIME_EXPIRED");
            sessionRepository.save(session);
            throw new IllegalStateException("Session absolute lifetime expired");
        }

        if (now.isAfter(session.getIdleExpiresAt())) {
            session.setState("REVOKED");
            session.setRevokedAt(now);
            session.setRevokedReason("IDLE_TIMEOUT_EXPIRED");
            sessionRepository.save(session);
            throw new IllegalStateException("Session idle timeout expired");
        }

        // Update touch times
        session.setLastSeenAt(now);
        session.setIdleExpiresAt(now.plus(securityProperties.getSessionIdleLifetimeHours(), ChronoUnit.HOURS));
        sessionRepository.save(session);

        String accessToken = appJwtService.generateAccessToken(session.getUser(), session.getId());
        return new SessionActivationResult(session.getId(), session.getUser(), accessToken);
    }

    @Transactional
    public void revokeSession(String rawSessionGrant, String reason) {
        if (rawSessionGrant == null || rawSessionGrant.isBlank()) return;
        String grantDigest = digest(rawSessionGrant);
        sessionRepository.findBySessionGrantDigest(grantDigest).ifPresent(s -> {
            s.setState("REVOKED");
            s.setRevokedAt(Instant.now());
            s.setRevokedReason(reason != null ? reason : "USER_LOGOUT");
            sessionRepository.save(s);
        });
    }

    @Transactional
    public void revokeSessionById(UUID sessionId, String reason) {
        if (sessionId == null) return;
        sessionRepository.findById(sessionId).ifPresent(s -> {
            s.setState("REVOKED");
            s.setRevokedAt(Instant.now());
            s.setRevokedReason(reason != null ? reason : "USER_LOGOUT");
            sessionRepository.save(s);
        });
    }

    @Transactional
    public void revokeAllUserSessions(Long userId, String reason) {
        if (userId == null) return;
        sessionRepository.revokeAllActiveSessionsForUser(userId, Instant.now(), reason != null ? reason : "USER_SECURITY_RESET");
    }

    @Transactional
    public boolean validateAndTouchActiveSession(UUID sessionId, Long userId) {
        if (sessionId == null || userId == null) return false;
        var opt = sessionRepository.findById(sessionId);
        if (opt.isEmpty()) return false;
        var session = opt.get();
        if (session.getUser() == null || !session.getUser().getId().equals(userId)) return false;
        if (!"ACTIVE".equalsIgnoreCase(session.getUser().getAccountStatus())) return false;
        if (!"ACTIVE".equals(session.getState())) return false;
        
        Instant now = Instant.now();
        if (session.getAbsoluteExpiresAt() != null && now.isAfter(session.getAbsoluteExpiresAt())) {
            session.setState("REVOKED");
            session.setRevokedAt(now);
            session.setRevokedReason("ABSOLUTE_LIFETIME_EXPIRED");
            sessionRepository.save(session);
            return false;
        }
        if (session.getIdleExpiresAt() != null && now.isAfter(session.getIdleExpiresAt())) {
            session.setState("REVOKED");
            session.setRevokedAt(now);
            session.setRevokedReason("IDLE_TIMEOUT_EXPIRED");
            sessionRepository.save(session);
            return false;
        }

        session.setLastSeenAt(now);
        session.setIdleExpiresAt(now.plus(securityProperties.getSessionIdleLifetimeHours(), ChronoUnit.HOURS));
        sessionRepository.save(session);
        return true;
    }

    /**
     * How long a session's "last seen" may lag behind its real use. Every request still reads the session row, so a
     * revoked, expired or foreign session is refused at once; only the WRITE that slides the idle window is skipped
     * while the stored time is younger than this. The stored idle deadline is therefore at most this much earlier than
     * it used to be: a session can only end sooner, never later.
     */
    static final java.time.Duration TOUCH_INTERVAL = java.time.Duration.ofSeconds(240);

    /** A session row with its account, read in one statement by {@link #loadForRequest}. */
    public record RequestSession(AuthSession session, User user) {}

    /**
     * The request path's single read: the session named by the token together with its account. Null when there is
     * no such session or it belongs to another account than the token claims; the caller then takes the original,
     * step-by-step path, which refuses it for the reason it always gave.
     */
    public RequestSession loadForRequest(UUID sessionId, Long claimedUserId) {
        if (sessionId == null || claimedUserId == null) return null;
        AuthSession session = sessionRepository.findWithUserById(sessionId).orElse(null);
        if (session == null || session.getUser() == null || !claimedUserId.equals(session.getUser().getId())) return null;
        return new RequestSession(session, session.getUser());
    }

    /**
     * The checks of {@link #validateAndTouchActiveSession} on a session that {@link #loadForRequest} has just read:
     * ACTIVE, inside its absolute and idle lifetimes (an expired one is revoked, as before), and the idle window slid
     * forward, at most once per {@link #TOUCH_INTERVAL}.
     */
    public boolean validateLoaded(RequestSession loaded) {
        if (loaded == null || loaded.session() == null || loaded.user() == null) return false;
        if (!"ACTIVE".equalsIgnoreCase(loaded.user().getAccountStatus())) return false;
        AuthSession session = loaded.session();
        if (!"ACTIVE".equals(session.getState())) return false;
        Instant now = Instant.now();
        if (session.getAbsoluteExpiresAt() != null && now.isAfter(session.getAbsoluteExpiresAt())) {
            sessionRepository.expireActive(session.getId(), now, "ABSOLUTE_LIFETIME_EXPIRED");
            return false;
        }
        if (session.getIdleExpiresAt() != null && now.isAfter(session.getIdleExpiresAt())) {
            sessionRepository.expireActive(session.getId(), now, "IDLE_TIMEOUT_EXPIRED");
            return false;
        }
        String pendingDeviceLabel = session.getDeviceLabel() == null ? DeviceLabels.ofCurrentRequest() : null;
        if (session.getLastSeenAt() == null
                || session.getLastSeenAt().isBefore(now.minus(TOUCH_INTERVAL))
                || pendingDeviceLabel != null) {
            // 0 rows: the session was revoked between the read and this write; refuse, exactly as a later read would
            return sessionRepository.touchActive(session.getId(), now,
                    now.plus(securityProperties.getSessionIdleLifetimeHours(), ChronoUnit.HOURS),
                    pendingDeviceLabel) == 1;
        }
        return true;
    }

    public record PendingSessionResult(UUID sessionId, String sessionGrant) {}
    public record SessionActivationResult(UUID sessionId, User user, String accessToken) {}
}
