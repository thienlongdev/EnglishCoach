package com.englishcoach.flashcard.pvp.security;

import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.extension.EchoAnywhereConfig;
import com.englishcoach.flashcard.pvp.config.CardBlastPvPConstants;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.MessageDeliveryException;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

@Component
@Slf4j
public class StompAuthChannelInterceptor implements ChannelInterceptor {

    /** WebSocket session attribute: the application token the handshake's session cookie carried. */
    public static final String HANDSHAKE_COOKIE_TOKEN = "EC_HANDSHAKE_COOKIE_TOKEN";

    static final int MAX_CONCURRENT_SESSIONS_PER_USER = 6;
    static final int MAX_CONSECUTIVE_RECHECK_ERRORS = 2;
    static final int MAX_QUIZ_RUSH_MESSAGES_PER_SECOND_PER_USER = 96;
    static final int MAX_PAYLOAD_PVP_BYTES = 2 * 1024;
    static final int MAX_PAYLOAD_ECHO_LIFE_BYTES = 4 * 1024;
    static final int MAX_PAYLOAD_MESSENGER_BYTES = 16 * 1024;
    static final int MAX_PAYLOAD_DEFAULT_BYTES = 32 * 1024;
    private static final Set<String> ALLOWED_WS_AUTH_METHODS = Set.of("CREDENTIALS", "GOOGLE");

    private final JwtDecoder jwtDecoder;
    private final CustomJwtAuthenticationConverter customJwtAuthenticationConverter;
    private final CardBlastPvPService pvpService;

    public StompAuthChannelInterceptor(
            JwtDecoder jwtDecoder,
            CustomJwtAuthenticationConverter customJwtAuthenticationConverter,
            @org.springframework.context.annotation.Lazy CardBlastPvPService pvpService
    ) {
        this.jwtDecoder = jwtDecoder;
        this.customJwtAuthenticationConverter = customJwtAuthenticationConverter;
        this.pvpService = pvpService;
    }

    private static class RateTracker {
        long windowStartMs = System.currentTimeMillis();
        final AtomicInteger count = new AtomicInteger(0);
    }

    private final ConcurrentHashMap<String, RateTracker> sessionRates = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, RateTracker> rushSessionRates = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, RateTracker> rushUserRates = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, RateTracker> echoLifeRates = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long, Set<String>> activeUserSessions = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Long> sessionToUserId = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, String> sessionToRateKey = new ConcurrentHashMap<>();
    private static final int MAX_ECHO_LIFE_MESSAGES_PER_SECOND_PER_SESSION = 12;
    private static final int MAX_TRACKED_SESSIONS = 10_000;

    /**
     * A WebSocket outlives the request that opened it. Every {@link #SESSION_RECHECK_MS} a SEND or SUBSCRIBE of an
     * established connection re-reads its sign-in session (revoked by sign-out, "end other sessions", an
     * administrator, a password change; expired; account disabled): the connection is then refused like a new one.
     * Absent in hand-built test contexts (setter injection), where nothing changes.
     */
    static final long SESSION_RECHECK_MS = 30_000;
    private com.englishcoach.auth.service.AuthSessionService authSessionService;
    private UserRepository userRepository;
    private com.englishcoach.feedback.repository.FeedbackThreadRepository feedbackThreadRepository;
    private final ConcurrentHashMap<String, Long> sessionCheckedAt = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, AtomicInteger> sessionRecheckFailures = new ConcurrentHashMap<>();

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setFeedbackThreadRepository(com.englishcoach.feedback.repository.FeedbackThreadRepository feedbackThreadRepository) {
        this.feedbackThreadRepository = feedbackThreadRepository;
    }

    @org.springframework.context.event.EventListener
    public void onSessionDisconnect(org.springframework.web.socket.messaging.SessionDisconnectEvent event) {
        releaseSession(event.getSessionId());
    }

    private void releaseSession(String sid) {
        if (sid == null) return;
        sessionCheckedAt.remove(sid);
        sessionRecheckFailures.remove(sid);
        rushSessionRates.remove(sid);
        sessionRates.remove("s:" + sid);
        Long uid = sessionToUserId.remove(sid);
        boolean noRemainingSessions = true;
        if (uid != null) {
            Set<String> remaining = activeUserSessions.computeIfPresent(uid, (k, set) -> {
                set.remove(sid);
                return set.isEmpty() ? null : set;
            });
            noRemainingSessions = (remaining == null || remaining.isEmpty());
        }
        String rateKey = sessionToRateKey.remove(sid);
        if (rateKey != null && noRemainingSessions) {
            echoLifeRates.remove(rateKey);
            sessionRates.remove(rateKey);
            rushUserRates.remove(rateKey);
        }
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setAuthSessionService(@org.springframework.context.annotation.Lazy
                                      com.englishcoach.auth.service.AuthSessionService authSessionService) {
        this.authSessionService = authSessionService;
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setUserRepository(@org.springframework.context.annotation.Lazy UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    /** False when the connection's sign-in session has ended, account is inactive, or DB recheck failed twice consecutively. */
    boolean sessionStillLive(String stompSessionId, Principal principal) {
        if (authSessionService == null || stompSessionId == null) return true;
        var context = principal instanceof Authentication auth
                ? AuthSessionContext.of(auth) : null;
        if (context == null || context.sessionId() == null) return true; // a token without a session row
        long now = System.currentTimeMillis();
        Long last = sessionCheckedAt.get(stompSessionId);
        // Deterministic per-session jitter in [25s, 30s] prevents synchronized DB recheck stampedes while never exceeding 30s.
        long recheckInterval = SESSION_RECHECK_MS - Math.floorMod(stompSessionId.hashCode(), 5_000);
        if (last != null && now - last < recheckInterval) return true;
        boolean live;
        try {
            live = authSessionService.validateAndTouchActiveSession(context.sessionId(), context.userId());
            if (live && userRepository != null && context.userId() != null) {
                live = userRepository.findById(context.userId())
                        .map(u -> "ACTIVE".equalsIgnoreCase(u.getAccountStatus()))
                        .orElse(false);
            }
            sessionRecheckFailures.remove(stompSessionId);
        } catch (Exception e) {
            if (sessionRecheckFailures.size() > MAX_TRACKED_SESSIONS) sessionRecheckFailures.clear();
            int failures = sessionRecheckFailures
                    .computeIfAbsent(stompSessionId, k -> new AtomicInteger(0))
                    .incrementAndGet();
            log.warn("[STOMP AUTH] Session recheck error #{} for session {}: {}", failures, stompSessionId, e.getMessage());
            if (failures >= MAX_CONSECUTIVE_RECHECK_ERRORS) {
                sessionCheckedAt.remove(stompSessionId);
                sessionRecheckFailures.remove(stompSessionId);
                return false;
            }
            return true;
        }
        if (live) {
            if (sessionCheckedAt.size() > MAX_TRACKED_SESSIONS) sessionCheckedAt.clear();
            sessionCheckedAt.put(stompSessionId, now);
        } else {
            sessionCheckedAt.remove(stompSessionId);
            sessionRecheckFailures.remove(stompSessionId);
        }
        return live;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null) {
            return message;
        }

        StompCommand command = accessor.getCommand();
        String sessionId = accessor.getSessionId();

        if (StompCommand.DISCONNECT.equals(command)) {
            releaseSession(sessionId);
            return message;
        }

        // Authentication on CONNECT and STOMP (STOMP 1.2 synonym for CONNECT)
        if (StompCommand.CONNECT.equals(command) || StompCommand.STOMP.equals(command)) {
            if (sessionId != null && !consumeRate(sessionRates, "s:" + sessionId, CardBlastPvPConstants.MAX_MESSAGES_PER_SECOND_PER_SESSION, System.currentTimeMillis())) {
                return null;
            }
            String token = extractBearerToken(accessor);
            if ((token == null || token.isBlank()) && accessor.getSessionAttributes() != null) {
                // The browser path: the session cookie the handshake carried (never a token in a URL or in storage).
                // It is used once, for this frame, and not kept.
                Object cookieToken = accessor.getSessionAttributes().remove(HANDSHAKE_COOKIE_TOKEN);
                if (cookieToken instanceof String s && !s.isBlank()) token = s;
            }
            if (token == null || token.isBlank()) {
                log.warn("[STOMP AUTH] Rejected {}: no session cookie on the handshake and no token in the frame", command);
                throw new IllegalArgumentException("STOMP Authentication failed: missing token");
            }

            try {
                Jwt jwt = jwtDecoder.decode(token);
                if (isForbiddenAuthMethod(jwt.getClaimAsString("authMethod"))) {
                    log.warn("[STOMP AUTH] Rejected {}: forbidden token scope", command);
                    throw new MessageDeliveryException("Forbidden session scope for WebSocket");
                }
                AbstractAuthenticationToken authentication = customJwtAuthenticationConverter.convert(jwt);
                if (isForbiddenScope(authentication)) {
                    log.warn("[STOMP AUTH] Rejected {}: forbidden session scope for user {}", command, authentication != null ? authentication.getName() : "unknown");
                    throw new MessageDeliveryException("Forbidden session scope for WebSocket");
                }
                String userId = extractUserId(authentication);
                Long numericUserId = parseNumericUserId(authentication, userId);
                if (numericUserId != null && sessionId != null) {
                    AtomicBoolean registered = new AtomicBoolean(false);
                    activeUserSessions.compute(numericUserId, (uid, sessions) -> {
                        Set<String> set = sessions != null ? sessions : ConcurrentHashMap.newKeySet();
                        if (set.contains(sessionId)) {
                            registered.set(true);
                            return set;
                        }
                        if (set.size() >= MAX_CONCURRENT_SESSIONS_PER_USER) {
                            return set;
                        }
                        set.add(sessionId);
                        registered.set(true);
                        return set;
                    });
                    if (!registered.get()) {
                        log.warn("[STOMP CONN CAP] Rejected {} for user {}: exceeded max {} concurrent sessions",
                                command, numericUserId, MAX_CONCURRENT_SESSIONS_PER_USER);
                        throw new MessageDeliveryException("Too many concurrent WebSocket sessions");
                    }
                    if (sessionToUserId.size() > MAX_TRACKED_SESSIONS) {
                        sessionToUserId.entrySet().removeIf(e -> {
                            Set<String> active = activeUserSessions.get(e.getValue());
                            return active == null || !active.contains(e.getKey());
                        });
                    }
                    sessionToUserId.put(sessionId, numericUserId);
                }
                if (accessor.getSessionAttributes() != null && userId != null) {
                    accessor.getSessionAttributes().put("PVP_USER_ID", userId);
                }
                if (accessor.isMutable()) {
                    accessor.setUser(authentication);
                } else {
                    StompHeaderAccessor mutableAccessor = StompHeaderAccessor.wrap(message);
                    mutableAccessor.setUser(authentication);
                    if (mutableAccessor.getSessionAttributes() != null && userId != null) {
                        mutableAccessor.getSessionAttributes().put("PVP_USER_ID", userId);
                    }
                    message = org.springframework.messaging.support.MessageBuilder.createMessage(message.getPayload(), mutableAccessor.getMessageHeaders());
                }
                if (sessionId != null) {
                    sessionCheckedAt.put(sessionId, System.currentTimeMillis()); // just validated
                    sessionRecheckFailures.remove(sessionId);
                    if (userId != null && !userId.isBlank()) {
                        sessionToRateKey.put(sessionId, "u:" + userId);
                    }
                }
                log.info("[STOMP AUTH] User {} successfully authenticated via STOMP {}", authentication.getName(), command);
                return message;
            } catch (MessageDeliveryException ex) {
                throw ex;
            } catch (Exception ex) {
                log.warn("[STOMP AUTH] Invalid token on STOMP {}: {}", command, ex.getMessage());
                throw new IllegalArgumentException("STOMP Authentication failed: " + ex.getMessage());
            }
        }

        // Per-user rate limiting check: 30 msgs/s general, 64/s per-session & 96/s per-user Quiz Rush, 12/s per-user Echo Life.
        String rateKey = resolveRateKey(accessor, sessionId);
        if (rateKey != null) {
            if (sessionId != null && rateKey.startsWith("u:")) {
                if (sessionToRateKey.size() > MAX_TRACKED_SESSIONS) {
                    sessionToRateKey.clear();
                }
                sessionToRateKey.put(sessionId, rateKey);
            }
            long now = System.currentTimeMillis();
            String target = accessor.getDestination();
            boolean send = StompCommand.SEND.equals(command) && target != null;
            boolean rush = send && target.startsWith("/app/quiz-rush/");
            boolean echoLife = send && target.startsWith("/app/echo-life/");
            if (rush) {
                String sessionKey = sessionId != null ? sessionId : rateKey;
                boolean sessionAllowed = consumeRate(rushSessionRates, sessionKey, CardBlastPvPConstants.MAX_QUIZ_RUSH_MESSAGES_PER_SECOND_PER_SESSION, now);
                boolean userAllowed = consumeRate(rushUserRates, rateKey, MAX_QUIZ_RUSH_MESSAGES_PER_SECOND_PER_USER, now);
                if (!sessionAllowed || !userAllowed) {
                    return null;
                }
            } else if (echoLife) {
                if (!consumeRate(echoLifeRates, rateKey, MAX_ECHO_LIFE_MESSAGES_PER_SECOND_PER_SESSION, now)) {
                    return null;
                }
            } else {
                if (!consumeRate(sessionRates, rateKey, CardBlastPvPConstants.MAX_MESSAGES_PER_SECOND_PER_SESSION, now)) {
                    return null;
                }
            }
        }

        if ((StompCommand.SEND.equals(command) || StompCommand.SUBSCRIBE.equals(command))
                && accessor.getUser() != null) {
            if (isForbiddenScope(accessor.getUser())) {
                log.warn("[STOMP AUTH] Closing a connection carrying forbidden session scope");
                releaseSession(sessionId);
                throw new MessageDeliveryException("Forbidden session scope for WebSocket");
            }
            if (!sessionStillLive(sessionId, accessor.getUser())) {
                log.warn("[STOMP AUTH] Closing a connection whose sign-in session has ended");
                releaseSession(sessionId);
                throw new IllegalArgumentException("STOMP session ended: sign in again");
            }
        }

        // Clients submit application commands; only the server may publish broker state.
        if (StompCommand.SEND.equals(command)) {
            if (accessor.getUser() == null) {
                throw new IllegalArgumentException("STOMP command failed: unauthenticated");
            }
            String destination = accessor.getDestination();
            if (destination == null || !destination.startsWith("/app/")) {
                throw new IllegalArgumentException("STOMP command destination forbidden");
            }
            int payloadBytes = payloadByteLength(message.getPayload());
            int maxBytes = maxPayloadBytesFor(destination);
            if (payloadBytes > maxBytes) {
                log.warn("[STOMP PAYLOAD CAP] Rejected SEND to {} ({} bytes > {} bytes) for user {}",
                        destination, payloadBytes, maxBytes, extractUserId(accessor.getUser()));
                throw new MessageDeliveryException("STOMP payload exceeds destination limit");
            }
        }

        // Authorization on SUBSCRIBE
        if (StompCommand.SUBSCRIBE.equals(command)) {
            Principal principal = accessor.getUser();
            if (principal == null) {
                log.warn("[STOMP AUTH] Rejected SUBSCRIBE: unauthenticated user");
                throw new IllegalArgumentException("STOMP Subscription failed: unauthenticated");
            }

            String destination = accessor.getDestination();
            if (destination == null || destination.isBlank()) {
                throw new IllegalArgumentException("STOMP Subscription failed: missing destination");
            }

            String currentUserId = extractUserId(principal);
            if (currentUserId == null && accessor.getSessionAttributes() != null) {
                Object pvpUid = accessor.getSessionAttributes().get("PVP_USER_ID");
                if (pvpUid != null) {
                    currentUserId = String.valueOf(pvpUid);
                }
            }
            boolean allowed = false;

            if (destination.startsWith("/user/")) {
                // User destinations must match user's own queue (e.g. /user/queue/notifications or /user/queue/pvp)
                if (destination.equals("/user/queue/notifications") || destination.equals("/user/queue/pvp") || destination.startsWith("/user/queue/")) {
                    allowed = true;
                } else {
                    log.warn("[STOMP AUTH] Rejected SUBSCRIBE to forbidden user destination {} for user {}", destination, currentUserId);
                    return null;
                }
            } else if (destination.startsWith("/queue/")) {
                // Direct subscription to raw /queue/ is forbidden to prevent cross-session eavesdropping
                log.warn("[STOMP AUTH] Rejected direct SUBSCRIBE to raw queue {} for user {}", destination, currentUserId);
                return null;
            } else if (destination.equals("/topic/system-announcements") || destination.equals("/topic/notifications/broadcast")) {
                // Public non-sensitive broadcast headlines
                allowed = true;
            } else if (destination.startsWith("/topic/pvp/")) {
                String roomCode = destination.substring("/topic/pvp/".length());
                if (currentUserId != null && pvpService.isUserInRoom(roomCode, currentUserId)) {
                    allowed = true;
                } else {
                    log.warn("[STOMP AUTH] Rejected SUBSCRIBE to {} for unverified user {}", destination, currentUserId);
                    return null;
                }
            } else if (destination.equals("/topic/admin/feedback-badge")) {
                if (isAdmin(principal)) {
                    allowed = true;
                } else {
                    log.warn("[STOMP AUTH] Rejected SUBSCRIBE to {} for non-admin user", destination);
                    return null;
                }
            } else if (destination.startsWith("/topic/user/") && destination.endsWith("/feedback-badge")) {
                String targetUserId = destination.substring("/topic/user/".length(), destination.indexOf("/feedback-badge"));
                if (isAdmin(principal) || (currentUserId != null && currentUserId.equals(targetUserId))) {
                    allowed = true;
                } else {
                    log.warn("[STOMP AUTH] Rejected SUBSCRIBE to {} for user {}", destination, currentUserId);
                    return null;
                }
            } else if (destination.startsWith("/topic/feedback/")) {
                String rawThreadId = destination.substring("/topic/feedback/".length());
                if (isAdmin(principal)) {
                    allowed = true;
                } else if (feedbackThreadRepository != null) {
                    try {
                        long threadId = Long.parseLong(rawThreadId);
                        long callerId = currentUserId != null ? Long.parseLong(currentUserId) : -1L;
                        if (threadId > 0 && callerId > 0 && feedbackThreadRepository.existsByIdAndUserId(threadId, callerId)) {
                            allowed = true;
                        } else {
                            log.warn("[STOMP AUTH] Rejected SUBSCRIBE to {} for non-owner user {}", destination, currentUserId);
                            return null;
                        }
                    } catch (NumberFormatException ex) {
                        log.warn("[STOMP AUTH] Rejected SUBSCRIBE to malformed feedback topic {} for user {}", destination, currentUserId);
                        return null;
                    }
                } else {
                    // Hand-built test context without FeedbackThreadRepository (FeedbackChannelGuard enforces separately in Spring).
                    allowed = true;
                }
            }

            if (!allowed) {
                log.warn("[STOMP AUTH] Rejected SUBSCRIBE to unwhitelisted destination {} for user {}", destination, currentUserId);
                return null;
            }
        }

        return message;
    }

    private boolean consumeRate(ConcurrentHashMap<String, RateTracker> bucket, String key, int limit, long now) {
        if (bucket.size() > MAX_TRACKED_SESSIONS) {
            bucket.entrySet().removeIf(e -> now - e.getValue().windowStartMs > 60_000L);
        }
        RateTracker tracker = bucket.compute(key, (k, tr) -> {
            if (tr == null || (now - tr.windowStartMs) >= 1000) {
                RateTracker newTr = new RateTracker();
                newTr.windowStartMs = now;
                newTr.count.set(1);
                return newTr;
            } else {
                tr.count.incrementAndGet();
                return tr;
            }
        });
        int current = tracker.count.get();
        if (current > limit) {
            if (current == limit + 1) {
                log.warn("[STOMP RATE LIMIT] Dropping messages for {}: more than {} msgs/s", key, limit);
            }
            return false;
        }
        return true;
    }

    private String resolveRateKey(StompHeaderAccessor accessor, String sessionId) {
        String userId = extractUserId(accessor.getUser());
        if ((userId == null || userId.isBlank()) && accessor.getSessionAttributes() != null) {
            Object pvpUid = accessor.getSessionAttributes().get("PVP_USER_ID");
            if (pvpUid != null) {
                userId = String.valueOf(pvpUid);
            }
        }
        if (userId != null && !userId.isBlank()) {
            return "u:" + userId;
        }
        return sessionId != null ? "s:" + sessionId : null;
    }

    private static int maxPayloadBytesFor(String destination) {
        if (destination.startsWith("/app/pvp/")) return MAX_PAYLOAD_PVP_BYTES;
        if (destination.startsWith("/app/echo-life/")) return MAX_PAYLOAD_ECHO_LIFE_BYTES;
        if (destination.startsWith("/app/messenger/")) return MAX_PAYLOAD_MESSENGER_BYTES;
        return MAX_PAYLOAD_DEFAULT_BYTES;
    }

    private static int payloadByteLength(Object payload) {
        if (payload == null) return 0;
        if (payload instanceof byte[] bytes) return bytes.length;
        if (payload instanceof String s) return s.getBytes(StandardCharsets.UTF_8).length;
        if (payload instanceof CharSequence cs) return cs.toString().getBytes(StandardCharsets.UTF_8).length;
        return 0;
    }

    private static boolean isForbiddenScope(Principal principal) {
        if (principal instanceof Authentication auth) {
            AuthSessionContext context = AuthSessionContext.of(auth);
            if (context != null && isForbiddenAuthMethod(context.authMethod())) {
                return true;
            }
        }
        return false;
    }

    private static boolean isForbiddenAuthMethod(String authMethod) {
        if (authMethod == null || authMethod.isBlank()) {
            return false;
        }
        String normalized = authMethod.trim().toUpperCase(Locale.ROOT);
        if (EchoAnywhereConfig.AUTH_METHOD.equals(normalized)) {
            return true;
        }
        return !ALLOWED_WS_AUTH_METHODS.contains(normalized);
    }

    private Long parseNumericUserId(Principal principal, String extractedUserId) {
        if (principal instanceof Authentication auth && auth.getPrincipal() instanceof UserDetailsImpl userDetails) {
            return userDetails.getId();
        }
        if (extractedUserId != null && !extractedUserId.isBlank()) {
            try {
                return Long.parseLong(extractedUserId.trim());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private String extractBearerToken(StompHeaderAccessor accessor) {
        String authHeader = accessor.getFirstNativeHeader("Authorization");
        if (authHeader == null || authHeader.isBlank()) {
            authHeader = accessor.getFirstNativeHeader("authorization");
        }
        if (authHeader == null || authHeader.isBlank()) {
            authHeader = accessor.getFirstNativeHeader("passcode");
        }
        if (authHeader == null || authHeader.isBlank()) {
            authHeader = accessor.getPasscode();
        }

        if (authHeader != null && authHeader.toLowerCase().startsWith("bearer ")) {
            return authHeader.substring(7).trim();
        }
        return authHeader != null ? authHeader.trim() : null;
    }

    private String extractUserId(Principal principal) {
        if (principal == null) return null;
        if (principal instanceof Authentication auth) {
            if (auth.getPrincipal() instanceof UserDetailsImpl userDetails) {
                return String.valueOf(userDetails.getId());
            }
            if (auth.getPrincipal() instanceof Jwt jwt) {
                Object uid = jwt.getClaim("userId");
                if (uid != null) return String.valueOf(uid);
                String sub = jwt.getSubject();
                if (sub != null) return sub;
            }
        }
        return principal.getName();
    }

    private boolean isAdmin(Principal principal) {
        if (principal instanceof Authentication auth && auth.getAuthorities() != null) {
            return auth.getAuthorities().stream()
                    .anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
        }
        return false;
    }
}
