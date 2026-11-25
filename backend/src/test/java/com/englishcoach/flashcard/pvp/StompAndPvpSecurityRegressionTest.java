package com.englishcoach.flashcard.pvp;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.extension.EchoAnywhereConfig;
import com.englishcoach.flashcard.pvp.controller.CardBlastPvPController;
import com.englishcoach.flashcard.pvp.dto.PvPRequests.CreateRoomRequest;
import com.englishcoach.flashcard.pvp.dto.PvPRequests.JoinRoomRequest;
import com.englishcoach.flashcard.pvp.model.CardBlastRoom;
import com.englishcoach.flashcard.pvp.model.PlayerState;
import com.englishcoach.flashcard.pvp.model.RoomMode;
import com.englishcoach.flashcard.pvp.model.RoomStatus;
import com.englishcoach.flashcard.pvp.model.ScheduledWord;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.flashcard.repository.VocabDeckRepository;
import com.englishcoach.user.service.UserProfileService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.MessageDeliveryException;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import java.lang.reflect.Method;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Security regression suite covering Workstream 3B STOMP WebSocket & Card Blast PvP findings:
 * EC-SEC-2026-016, WS-03, EC-SEC-2026-034, WS-04, EC-SEC-2026-020, and WS-06.
 */
class StompAndPvpSecurityRegressionTest {

    private JwtDecoder jwtDecoder;
    private CustomJwtAuthenticationConverter authConverter;
    private CardBlastPvPService mockPvpService;
    private MessageChannel channel;
    private StompAuthChannelInterceptor interceptor;

    @BeforeEach
    void setUp() {
        jwtDecoder = mock(JwtDecoder.class);
        authConverter = mock(CustomJwtAuthenticationConverter.class);
        mockPvpService = mock(CardBlastPvPService.class);
        channel = mock(MessageChannel.class);
        interceptor = new StompAuthChannelInterceptor(jwtDecoder, authConverter, mockPvpService);
    }

    private static Jwt jwt(String token, long userId) {
        return new Jwt(
                token,
                Instant.now(),
                Instant.now().plusSeconds(3600),
                Map.of("alg", "HS256"),
                Map.of("sub", String.valueOf(userId), "userId", userId)
        );
    }

    private static UsernamePasswordAuthenticationToken authWithSession(long userId, String authMethod, UUID sessionId) {
        UserDetailsImpl details = new UserDetailsImpl(userId, "user" + userId + "@example.test", "x", Collections.emptyList());
        UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(details, null, Collections.emptyList());
        if (sessionId != null || authMethod != null) {
            auth.setDetails(new AuthSessionContext(sessionId, userId, authMethod, Instant.now(), null, null, null));
        }
        return auth;
    }

    private static Message<byte[]> connectFrame(StompCommand command, String sessionId, String bearerToken) {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(command);
        accessor.setLeaveMutable(true);
        accessor.setSessionId(sessionId);
        accessor.setSessionAttributes(new HashMap<>());
        if (bearerToken != null) {
            accessor.addNativeHeader("Authorization", "Bearer " + bearerToken);
        }
        return MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());
    }

    private CardBlastPvPService buildRealPvpService() {
        SimpMessagingTemplate template = mock(SimpMessagingTemplate.class);
        doNothing().when(template).convertAndSend(anyString(), any(Object.class));
        FlashcardRepository flashcardRepo = mock(FlashcardRepository.class);
        List<DictionaryEntry> entries = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            DictionaryEntry e = new DictionaryEntry();
            e.setId(201L + i);
            e.setWord("word" + i);
            e.setGeneralTranslationVi("nghĩa" + i);
            e.setMeanings(List.of("nghĩa" + i));
            entries.add(e);
        }
        when(flashcardRepo.findPvPPersonalWords(anyLong())).thenReturn(PvPWordFixtures.rows(entries));
        when(flashcardRepo.findPvPWordsByDeckId(anyLong())).thenReturn(PvPWordFixtures.rows(entries));
        return new CardBlastPvPService(template, flashcardRepo, mock(DictionaryRepository.class), mock(VocabDeckRepository.class));
    }

    @Test
    @DisplayName("EC-SEC-2026-016: ECHO_ANYWHERE extension scope is rejected on STOMP CONNECT and STOMP frames")
    void echoAnywhereSessionRejectedOnStompConnect() {
        Jwt token = jwt("ext.jwt", 77L);
        when(jwtDecoder.decode("ext.jwt")).thenReturn(token);
        when(authConverter.convert(token)).thenReturn(authWithSession(77L, EchoAnywhereConfig.AUTH_METHOD, UUID.randomUUID()));

        MessageDeliveryException connectEx = assertThrows(MessageDeliveryException.class,
                () -> interceptor.preSend(connectFrame(StompCommand.CONNECT, "ws-ext-1", "ext.jwt"), channel));
        assertTrue(connectEx.getMessage().contains("Forbidden session scope for WebSocket"));

        MessageDeliveryException stompEx = assertThrows(MessageDeliveryException.class,
                () -> interceptor.preSend(connectFrame(StompCommand.STOMP, "ws-ext-2", "ext.jwt"), channel));
        assertTrue(stompEx.getMessage().contains("Forbidden session scope for WebSocket"));
    }

    @Test
    @DisplayName("WS-03: Unauthenticated STOMP 1.2 STOMP frame is rejected and valid STOMP frame authenticates")
    void stomp12FrameEnforcesAuthentication() {
        assertThrows(IllegalArgumentException.class,
                () -> interceptor.preSend(connectFrame(StompCommand.STOMP, "ws-stomp-anon", null), channel));

        Jwt token = jwt("good.jwt", 88L);
        when(jwtDecoder.decode("good.jwt")).thenReturn(token);
        when(authConverter.convert(token)).thenReturn(authWithSession(88L, "CREDENTIALS", UUID.randomUUID()));

        Message<?> result = interceptor.preSend(connectFrame(StompCommand.STOMP, "ws-stomp-ok", "good.jwt"), channel);
        assertNotNull(result);
        assertNotNull(StompHeaderAccessor.wrap(result).getUser());
    }

    @Test
    @DisplayName("EC-SEC-2026-034: Session recheck fails closed after 2 consecutive DB errors and rejects DISABLED accounts")
    void sessionRecheckFailsClosedOnDbErrorsAndDisabledAccount() {
        AuthSessionService sessions = mock(AuthSessionService.class);
        UserRepository users = mock(UserRepository.class);
        interceptor.setAuthSessionService(sessions);
        interceptor.setUserRepository(users);

        UUID sid = UUID.randomUUID();
        UsernamePasswordAuthenticationToken auth = authWithSession(55L, "CREDENTIALS", sid);

        // 1. Two consecutive DB errors -> fail closed on the 2nd
        when(sessions.validateAndTouchActiveSession(sid, 55L)).thenThrow(new RuntimeException("db down"));
        StompHeaderAccessor a1 = StompHeaderAccessor.create(StompCommand.SEND);
        a1.setSessionId("ws-db-fail");
        a1.setDestination("/app/pvp/ping");
        a1.setUser(auth);
        assertNotNull(interceptor.preSend(MessageBuilder.createMessage(new byte[0], a1.getMessageHeaders()), channel),
                "Single transient DB fault tolerated");

        StompHeaderAccessor a2 = StompHeaderAccessor.create(StompCommand.SEND);
        a2.setSessionId("ws-db-fail");
        a2.setDestination("/app/pvp/ping");
        a2.setUser(auth);
        assertThrows(IllegalArgumentException.class,
                () -> interceptor.preSend(MessageBuilder.createMessage(new byte[0], a2.getMessageHeaders()), channel),
                "Second consecutive DB fault must fail closed");

        // 2. Active session row but DISABLED user account -> rejected immediately
        UUID sid2 = UUID.randomUUID();
        UsernamePasswordAuthenticationToken disabledAuth = authWithSession(56L, "CREDENTIALS", sid2);
        when(sessions.validateAndTouchActiveSession(sid2, 56L)).thenReturn(true);
        User disabledUser = User.builder().id(56L).email("u56@example.test").name("Disabled").accountStatus("DISABLED").build();
        when(users.findById(56L)).thenReturn(Optional.of(disabledUser));

        StompHeaderAccessor a3 = StompHeaderAccessor.create(StompCommand.SEND);
        a3.setSessionId("ws-disabled");
        a3.setDestination("/app/pvp/ping");
        a3.setUser(disabledAuth);
        assertThrows(IllegalArgumentException.class,
                () -> interceptor.preSend(MessageBuilder.createMessage(new byte[0], a3.getMessageHeaders()), channel));
    }

    @Test
    @DisplayName("WS-04: Oversized /app/pvp/* payload rejected, concurrent session cap (6) enforced, rate limit shared per userId")
    void payloadCapsConnectionCapAndPerUserRateLimitEnforced() {
        // 1. Oversized /app/pvp/* payload (> 2 KB)
        UsernamePasswordAuthenticationToken auth = authWithSession(91L, "CREDENTIALS", UUID.randomUUID());
        StompHeaderAccessor oversized = StompHeaderAccessor.create(StompCommand.SEND);
        oversized.setSessionId("ws-payload");
        oversized.setDestination("/app/pvp/hit");
        oversized.setUser(auth);
        byte[] tooBig = new byte[2049];
        assertThrows(MessageDeliveryException.class,
                () -> interceptor.preSend(MessageBuilder.createMessage(tooBig, oversized.getMessageHeaders()), channel));

        // 2. Concurrent session cap: 6 allowed, 7th rejected, after disconnect 7th succeeds
        Jwt token = jwt("cap.jwt", 92L);
        when(jwtDecoder.decode("cap.jwt")).thenReturn(token);
        when(authConverter.convert(token)).thenReturn(authWithSession(92L, "CREDENTIALS", UUID.randomUUID()));
        for (int i = 1; i <= 6; i++) {
            assertNotNull(interceptor.preSend(connectFrame(StompCommand.CONNECT, "cap-s-" + i, "cap.jwt"), channel));
        }
        assertThrows(MessageDeliveryException.class,
                () -> interceptor.preSend(connectFrame(StompCommand.CONNECT, "cap-s-7", "cap.jwt"), channel));

        StompHeaderAccessor discAcc = StompHeaderAccessor.create(StompCommand.DISCONNECT);
        discAcc.setSessionId("cap-s-1");
        Message<byte[]> discMsg = MessageBuilder.createMessage(new byte[0], discAcc.getMessageHeaders());
        interceptor.onSessionDisconnect(new SessionDisconnectEvent(this, discMsg, "cap-s-1", CloseStatus.NORMAL));

        assertNotNull(interceptor.preSend(connectFrame(StompCommand.CONNECT, "cap-s-7", "cap.jwt"), channel));

        // 3. Per-user rate limit: opening two sockets does NOT multiply 30 msgs/s budget
        UsernamePasswordAuthenticationToken rateUser = authWithSession(93L, "CREDENTIALS", UUID.randomUUID());
        int allowed = 0;
        for (int i = 0; i < 20; i++) {
            StompHeaderAccessor s1 = StompHeaderAccessor.create(StompCommand.SEND);
            s1.setSessionId("rate-s1");
            s1.setDestination("/app/pvp/ping");
            s1.setUser(rateUser);
            if (interceptor.preSend(MessageBuilder.createMessage(new byte[0], s1.getMessageHeaders()), channel) != null) allowed++;

            StompHeaderAccessor s2 = StompHeaderAccessor.create(StompCommand.SEND);
            s2.setSessionId("rate-s2");
            s2.setDestination("/app/pvp/ping");
            s2.setUser(rateUser);
            if (interceptor.preSend(MessageBuilder.createMessage(new byte[0], s2.getMessageHeaders()), channel) != null) allowed++;
        }
        assertEquals(30, allowed, "Two sockets for the same user must share the 30/s per-user budget");
    }

    @Test
    @DisplayName("EC-SEC-2026-020: Card Blast rejects hits during COUNTDOWN, forged future tMs, negative tMs, and rapid macro bursts")
    void cardBlastRejectsCountdownHitsAndForgedTMs() {
        CardBlastPvPService pvpService = buildRealPvpService();
        CardBlastRoom room = pvpService.createRoom("101", "Alice", null, CreateRoomRequest.builder().mode(RoomMode.HUMAN).build());
        pvpService.joinRoom("102", "Bob", null, room.getRoomCode());
        pvpService.startCountdown(room);
        assertEquals(RoomStatus.COUNTDOWN, room.getStatus());

        ScheduledWord first = room.getSchedule().get(0);
        ScheduledWord second = room.getSchedule().get(1);

        // 1. Hit during COUNTDOWN must be rejected
        assertFalse(pvpService.applyHit(room.getRoomCode(), "101", first.getSeq(), first.getSpawnAtMs() + 500));

        // Transition to IN_GAME with server elapsed = first.spawnAtMs + 600ms
        room.setStatus(RoomStatus.IN_GAME);
        room.setMatchStartServerMs(System.currentTimeMillis() - first.getSpawnAtMs() - 600L);

        // 2. Negative tMs rejected
        assertFalse(pvpService.applyHit(room.getRoomCode(), "101", first.getSeq(), -10L));

        // 3. Forged future tMs (> serverElapsedMs + 2500) rejected (targeting second word far ahead of server clock)
        assertFalse(pvpService.applyHit(room.getRoomCode(), "101", second.getSeq(), second.getSpawnAtMs() + 500));

        // 4. Pre-spawn tMs (< wordSpawnMs) rejected
        assertFalse(pvpService.applyHit(room.getRoomCode(), "101", first.getSeq(), first.getSpawnAtMs() - 100));

        // 5. Legitimate hit succeeds
        assertTrue(pvpService.applyHit(room.getRoomCode(), "101", first.getSeq(), first.getSpawnAtMs() + 500));

        // 6. Immediate macro hit on a second active word in the same millisecond is rejected by server inter-hit check
        second.setSpawnAtMs(first.getSpawnAtMs());
        assertFalse(pvpService.applyHit(room.getRoomCode(), "101", second.getSeq(), first.getSpawnAtMs() + 800));
    }

    @Test
    @DisplayName("WS-06: CardBlastPvPController removes duplicate IDOR getMissedWords, ignores client avatar, never leaks email")
    void cardBlastControllerRemovesMissedWordsAndSanitizesIdentity() {
        boolean hasMissedWordsHandler = Arrays.stream(CardBlastPvPController.class.getDeclaredMethods())
                .map(Method::getName)
                .anyMatch("getMissedWords"::equals);
        assertFalse(hasMissedWordsHandler, "Duplicate/IDOR getMissedWords must not exist on CardBlastPvPController");

        CardBlastPvPService svc = mock(CardBlastPvPService.class);
        SimpMessagingTemplate tpl = mock(SimpMessagingTemplate.class);
        UserRepository users = mock(UserRepository.class);
        UserProfileService profiles = new UserProfileService(
                users,
                mock(com.englishcoach.user.repository.UserProfileRepository.class),
                mock(com.englishcoach.auth.repository.AuthIdentityRepository.class),
                mock(com.englishcoach.user.service.AvatarStorageService.class)
        );
        CardBlastPvPController controller = new CardBlastPvPController(svc, tpl, profiles);

        UserDetailsImpl details = new UserDetailsImpl(42L, "secret.email@example.test", "x", List.of());
        UsernamePasswordAuthenticationToken principal = new UsernamePasswordAuthenticationToken(details, null, details.getAuthorities());
        User userWithBlankName = User.builder().id(42L).email("secret.email@example.test").name("   ").build();
        when(users.findById(42L)).thenReturn(Optional.of(userWithBlankName));

        CardBlastRoom room = CardBlastRoom.builder()
                .roomCode("ABC123")
                .status(RoomStatus.WAITING)
                .mode(RoomMode.HUMAN)
                .host(PlayerState.builder().userId("42").build())
                .build();
        when(svc.joinRoom(eq("42"), eq("Player #42"), isNull(), eq("ABC123"), eq("secret.email@example.test"), eq("s-join")))
                .thenReturn(room);

        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SEND);
        accessor.setSessionId("s-join");
        accessor.setSessionAttributes(new HashMap<>());

        JoinRoomRequest joinReq = new JoinRoomRequest("ABC123", "https://evil.tracker/pixel.png");
        controller.joinRoom(principal, joinReq, accessor);

        verify(svc).joinRoom(eq("42"), eq("Player #42"), isNull(), eq("ABC123"), eq("secret.email@example.test"), eq("s-join"));
    }

    @Test
    @DisplayName("EC-SEC-2026-016 (Phase 4): /topic/feedback/{threadId} rejects non-owner learner subscriptions when FeedbackThreadRepository is wired")
    void feedbackTopicSubscribeEnforcesThreadOwnership() {
        var feedbackRepo = mock(com.englishcoach.feedback.repository.FeedbackThreadRepository.class);
        when(feedbackRepo.existsByIdAndUserId(77L, 50L)).thenReturn(true);
        when(feedbackRepo.existsByIdAndUserId(77L, 51L)).thenReturn(false);
        interceptor.setFeedbackThreadRepository(feedbackRepo);

        var otherUser = new UserDetailsImpl(51L, "u51@example.test", "", List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority("ROLE_USER")));
        var ownerUser = new UserDetailsImpl(50L, "u50@example.test", "", List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority("ROLE_USER")));

        StompHeaderAccessor otherLearnerSub = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        otherLearnerSub.setSessionId("s-fb-other");
        otherLearnerSub.setDestination("/topic/feedback/77");
        otherLearnerSub.setUser(new UsernamePasswordAuthenticationToken(otherUser, null, otherUser.getAuthorities()));
        assertNull(interceptor.preSend(MessageBuilder.createMessage(new byte[0], otherLearnerSub.getMessageHeaders()), channel));

        StompHeaderAccessor ownerSub = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        ownerSub.setSessionId("s-fb-owner");
        ownerSub.setDestination("/topic/feedback/77");
        ownerSub.setUser(new UsernamePasswordAuthenticationToken(ownerUser, null, ownerUser.getAuthorities()));
        assertNotNull(interceptor.preSend(MessageBuilder.createMessage(new byte[0], ownerSub.getMessageHeaders()), channel));
    }
}
