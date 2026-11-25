package com.englishcoach.auth.service;

import com.englishcoach.auth.entity.AuthSession;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthSessionRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.security.LogMask;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * "Phiên đăng nhập": a user sees their own live sessions and ends one or all of the others; the official
 * administrator ends every session of another account (ASVS 5.0 V7.5.2 / V7.4.5).
 *
 * Ending a session takes effect on the next request of that session: every API request and every STOMP frame re-reads
 * the session row, and the browser's renewal fails because the grant is revoked. Ending OTHER sessions needs a recent
 * sign-in on the current one (re-authentication, {@link #RECENT_SIGN_IN}), so a stolen session cannot lock the owner
 * out; ending one's own current session is plain sign-out. Answers never carry a grant digest, an address or a raw
 * User-Agent.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class AccountSessionService {

    static final Duration RECENT_SIGN_IN = Duration.ofMinutes(30);

    private final AuthSessionRepository sessions;
    private final UserRepository users;
    private final SecurityAuditService audit;
    private final Clock clock = Clock.systemUTC();

    /** Who is asking: the account, the session of this request and when that session signed in. */
    public record Caller(Long userId, UUID sessionId, Instant authenticatedAt, String ip, String userAgent) {}

    public List<Map<String, Object>> list(Caller caller) {
        return describe(sessions.findLiveForUser(caller.userId(), clock.instant()), caller.sessionId());
    }

    public Map<String, Object> revokeOne(Caller caller, UUID sessionId) {
        Instant now = clock.instant();
        boolean own = sessionId.equals(caller.sessionId());
        if (!own) requireRecentSignIn(caller, now);
        if (sessions.revokeOwned(sessionId, caller.userId(), now, own ? "USER_LOGOUT" : "USER_REVOKED_SESSION") != 1) {
            // another account's session and an already ended one look the same
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Session not found");
        }
        record(caller, "SESSION_REVOKED_BY_USER", caller.userId(), own ? "CURRENT" : "OTHER", 1);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("revoked", 1);
        out.put("currentEnded", own);
        return out;
    }

    public Map<String, Object> revokeOthers(Caller caller) {
        Instant now = clock.instant();
        requireRecentSignIn(caller, now);
        int n = sessions.revokeOthers(caller.userId(), caller.sessionId(), now, "USER_REVOKED_OTHER_SESSIONS");
        record(caller, "SESSIONS_REVOKED_BY_USER", caller.userId(), "OTHERS", n);
        return Map.of("revoked", n, "currentEnded", false);
    }

    // ------------------------------------------------------------------ administrator

    /** The account behind an e-mail address with its live sessions (the caller is the verified administrator). */
    public Map<String, Object> adminLookup(String email) {
        User user = byEmail(email);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("userId", user.getId());
        out.put("email", LogMask.email(user.getEmail()));
        out.put("name", user.getName());
        out.put("sessions", describe(sessions.findLiveForUser(user.getId(), clock.instant()), null));
        return out;
    }

    /** Ends every session of {@code targetUserId}; the administrator's own current session is kept. */
    @org.springframework.transaction.annotation.Transactional
    public Map<String, Object> adminRevokeAll(Caller admin, Long targetUserId) {
        User target = users.findById(targetUserId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
        Instant now = clock.instant();
        int n = target.getId().equals(admin.userId())
                ? sessions.revokeOthers(target.getId(), admin.sessionId(), now, "ADMIN_REVOKED_SESSIONS")
                : sessions.revokeAllActiveSessionsForUser(target.getId(), now, "ADMIN_REVOKED_SESSIONS");
        record(admin, "ADMIN_SESSIONS_REVOKED", target.getId(), "ALL", n);
        log.info("[Security] Administrator {} ended {} session(s) of user {}", admin.userId(), n, target.getId());
        return Map.of("revoked", n);
    }

    private User byEmail(String email) {
        String normalized = email == null ? "" : email.trim().toLowerCase(Locale.ROOT);
        if (normalized.isEmpty() || normalized.length() > 320) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "E-mail required");
        }
        return users.findByEmailNormalized(normalized)
                .or(() -> users.findByEmail(normalized))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
    }

    private void requireRecentSignIn(Caller caller, Instant now) {
        if (caller.authenticatedAt() == null || caller.authenticatedAt().isBefore(now.minus(RECENT_SIGN_IN))) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "REAUTH_REQUIRED");
        }
    }

    private static List<Map<String, Object>> describe(List<AuthSession> live, UUID current) {
        return live.stream().map(s -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", s.getId());
            m.put("device", s.getDeviceLabel());
            m.put("method", s.getAuthMethod());
            m.put("signedInAt", s.getAuthenticatedAt() != null ? s.getAuthenticatedAt() : s.getCreatedAt());
            m.put("lastSeenAt", s.getLastSeenAt() != null ? s.getLastSeenAt() : s.getActivatedAt());
            m.put("secondFactor", s.getMfaVerifiedAt() != null);
            m.put("current", s.getId().equals(current));
            return m;
        }).toList();
    }

    private void record(Caller caller, String event, Long target, String scope, int count) {
        audit.recordEvent(event, "SUCCESS", caller.userId(), target, null, caller.ip(), caller.userAgent(), scope,
                "{\"sessions\":" + count + "}");
    }
}
