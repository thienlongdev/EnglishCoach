package com.englishcoach.extension;

import com.englishcoach.auth.entity.AuthSession;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthSessionRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.common.security.AppJwtService;
import com.englishcoach.common.security.AuthSecurityProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Connects the Echo Anywhere browser extension to an account without ever handing it a website credential.
 *
 * <ol>
 *   <li>The extension makes a PKCE pair (RFC 7636, S256) and opens {@code /echo-anywhere/connect} on the website.</li>
 *   <li>The signed-in learner presses "Kết nối": the page (cookie session + CSRF) asks {@link #createPairing} for a
 *       one-time code bound to that learner, the extension id and the challenge (2 minutes, single use, in memory).</li>
 *   <li>The page hands the code to that extension only ({@code chrome.runtime.sendMessage} to an allow-listed id); the
 *       extension redeems it with its verifier ({@link #redeem}).</li>
 * </ol>
 *
 * The extension then holds its OWN revocable session (an {@code auth_sessions} row, kind {@code ECHO_ANYWHERE}, shown in
 * the learner's session list as "Echo Anywhere · Chrome"), a 30-minute access token and a refresh grant that changes on
 * every refresh (a stolen old grant stops working at the next refresh). {@link EchoAnywhereScopeFilter} limits what such
 * a session may call. Nothing here reads, copies or exposes the website's cookies.
 */
@Service
@Slf4j
public class EchoAnywhereSessionService {

    static final Duration CODE_LIFETIME = Duration.ofMinutes(2);
    static final int MAX_PENDING_PER_USER = 5;
    private static final Pattern CHALLENGE = Pattern.compile("^[A-Za-z0-9_-]{43}$");
    private static final Pattern VERIFIER = Pattern.compile("^[A-Za-z0-9._~-]{43,128}$");
    private static final Pattern GRANT = Pattern.compile("^[0-9a-f]{64}$");

    private final AuthSessionRepository sessions;
    private final UserRepository users;
    private final AppJwtService jwt;
    private final AuthSecurityProperties securityProperties;
    private final EchoAnywhereConfig config;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();

    record Pending(Long userId, String extensionId, String challenge, String browser, Instant expiresAt) {}

    public record Pairing(String code, long expiresInSeconds) {}

    public record Tokens(String accessToken, String refreshToken, long expiresInSeconds, Long userId, String displayName) {}

    @org.springframework.beans.factory.annotation.Autowired
    public EchoAnywhereSessionService(AuthSessionRepository sessions, UserRepository users, AppJwtService jwt,
                                      AuthSecurityProperties securityProperties, EchoAnywhereConfig config) {
        this(sessions, users, jwt, securityProperties, config, Clock.systemUTC());
    }

    EchoAnywhereSessionService(AuthSessionRepository sessions, UserRepository users, AppJwtService jwt,
                               AuthSecurityProperties securityProperties, EchoAnywhereConfig config, Clock clock) {
        this.sessions = sessions;
        this.users = users;
        this.jwt = jwt;
        this.securityProperties = securityProperties;
        this.config = config;
        this.clock = clock;
    }

    /** Step 2: the learner approved the connection on the website. */
    public Pairing createPairing(Long userId, String extensionId, String codeChallenge, String browser) {
        if (userId == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        String ext = normaliseExtension(extensionId);
        if (codeChallenge == null || !CHALLENGE.matcher(codeChallenge).matches()) {
            throw bad("INVALID_CHALLENGE", "Yêu cầu kết nối không hợp lệ. Hãy mở lại từ tiện ích Echo Anywhere.");
        }
        Instant now = clock.instant();
        sweep(now);
        long mine = pending.values().stream().filter(p -> p.userId().equals(userId)).count();
        if (mine >= MAX_PENDING_PER_USER) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Bạn vừa tạo nhiều yêu cầu kết nối. Hãy thử lại sau ít phút.");
        }
        String code = randomUrlSafe(32);
        pending.put(digest(code), new Pending(userId, ext, codeChallenge, browserLabel(browser), now.plus(CODE_LIFETIME)));
        return new Pairing(code, CODE_LIFETIME.toSeconds());
    }

    /** Step 3: the extension redeems the code with its PKCE verifier. Single use; any mismatch burns the code. */
    @Transactional
    public Tokens redeem(String code, String codeVerifier, String extensionId) {
        String ext = normaliseExtension(extensionId);
        if (code == null || code.isBlank() || codeVerifier == null || !VERIFIER.matcher(codeVerifier).matches()) {
            throw bad("INVALID_GRANT", "Mã kết nối không hợp lệ hoặc đã hết hạn.");
        }
        Pending p = pending.remove(digest(code.trim()));
        Instant now = clock.instant();
        if (p == null || now.isAfter(p.expiresAt()) || !p.extensionId().equals(ext)
                || !MessageDigest.isEqual(s256(codeVerifier).getBytes(StandardCharsets.US_ASCII),
                p.challenge().getBytes(StandardCharsets.US_ASCII))) {
            throw bad("INVALID_GRANT", "Mã kết nối không hợp lệ hoặc đã hết hạn.");
        }
        User user = users.findById(p.userId()).orElseThrow(() -> bad("INVALID_GRANT", "Tài khoản không còn tồn tại."));
        if (!"ACTIVE".equalsIgnoreCase(user.getAccountStatus())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Tài khoản này hiện không thể kết nối.");
        }
        String grant = HexFormat.of().formatHex(randomBytes(32));
        AuthSession session = AuthSession.builder()
                .user(user)
                .sessionGrantDigest(AuthSessionService.digest(grant))
                .state("ACTIVE")
                .authMethod(EchoAnywhereConfig.AUTH_METHOD)
                .activatedAt(now)
                .lastSeenAt(now)
                .authenticatedAt(now)
                .idleExpiresAt(now.plus(config.sessionIdleDays(), ChronoUnit.DAYS))
                .absoluteExpiresAt(now.plus(config.sessionAbsoluteDays(), ChronoUnit.DAYS))
                .deviceLabel("Echo Anywhere · " + p.browser())
                .build();
        sessions.save(session);
        log.info("[ECHO_ANYWHERE] connected session={} user={}", session.getId(), user.getId());
        return tokens(session, user, grant);
    }

    /** A fresh access token; the refresh grant is replaced (rotation). */
    @Transactional
    public Tokens refresh(String refreshToken, String extensionId) {
        normaliseExtension(extensionId);
        if (refreshToken == null || !GRANT.matcher(refreshToken).matches()) {
            throw unauthorized();
        }
        AuthSession session = sessions.findBySessionGrantDigest(AuthSessionService.digest(refreshToken)).orElseThrow(this::unauthorized);
        Instant now = clock.instant();
        if (!EchoAnywhereConfig.AUTH_METHOD.equals(session.getAuthMethod()) || !"ACTIVE".equals(session.getState())) {
            throw unauthorized();
        }
        if (now.isAfter(session.getAbsoluteExpiresAt()) || now.isAfter(session.getIdleExpiresAt())) {
            session.setState("REVOKED");
            session.setRevokedAt(now);
            session.setRevokedReason(now.isAfter(session.getAbsoluteExpiresAt()) ? "ABSOLUTE_LIFETIME_EXPIRED" : "IDLE_TIMEOUT_EXPIRED");
            sessions.save(session);
            throw unauthorized();
        }
        User user = session.getUser();
        if (user == null || !"ACTIVE".equalsIgnoreCase(user.getAccountStatus())) throw unauthorized();
        String grant = HexFormat.of().formatHex(randomBytes(32));
        session.setSessionGrantDigest(AuthSessionService.digest(grant));
        session.setLastSeenAt(now);
        Instant idle = now.plus(config.sessionIdleDays(), ChronoUnit.DAYS);
        session.setIdleExpiresAt(idle.isAfter(session.getAbsoluteExpiresAt()) ? session.getAbsoluteExpiresAt() : idle);
        sessions.save(session);
        return tokens(session, user, grant);
    }

    /** The extension's own sign-out ("Ngắt kết nối"). Only a session of kind ECHO_ANYWHERE of the caller. */
    @Transactional
    public void revoke(UUID sessionId, Long userId) {
        if (sessionId == null || userId == null) return;
        sessions.findById(sessionId).ifPresent(s -> {
            if (s.getUser() != null && userId.equals(s.getUser().getId())
                    && EchoAnywhereConfig.AUTH_METHOD.equals(s.getAuthMethod()) && "ACTIVE".equals(s.getState())) {
                s.setState("REVOKED");
                s.setRevokedAt(clock.instant());
                s.setRevokedReason("EXTENSION_DISCONNECT");
                sessions.save(s);
            }
        });
    }

    private Tokens tokens(AuthSession session, User user, String grant) {
        String access = jwt.generateAccessToken(user, session.getId());
        long seconds = Math.max(60, securityProperties.getJwtLifetimeMinutes() * 60L);
        String name = user.getName() == null || user.getName().isBlank() ? "Học viên" : user.getName().trim();
        return new Tokens(access, grant, seconds, user.getId(), name.length() > 80 ? name.substring(0, 80) : name);
    }

    private String normaliseExtension(String extensionId) {
        if (!config.isAllowed(extensionId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Tiện ích này không phải bản Echo Anywhere chính thức.");
        }
        return extensionId.trim().toLowerCase(java.util.Locale.ROOT);
    }

    private void sweep(Instant now) {
        for (Iterator<Map.Entry<String, Pending>> it = pending.entrySet().iterator(); it.hasNext(); ) {
            if (now.isAfter(it.next().getValue().expiresAt())) it.remove();
        }
    }

    static String browserLabel(String browser) {
        return browser != null && browser.trim().equalsIgnoreCase("edge") ? "Edge" : "Chrome";
    }

    static String s256(String verifier) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    private static String digest(String code) {
        return AuthSessionService.digest(code);
    }

    private byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        random.nextBytes(b);
        return b;
    }

    private String randomUrlSafe(int n) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(randomBytes(n));
    }

    private ResponseStatusException unauthorized() {
        return new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Phiên Echo Anywhere đã hết hạn. Hãy kết nối lại.");
    }

    private static ResponseStatusException bad(String code, String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    int pendingCount() {
        return pending.size();
    }
}
