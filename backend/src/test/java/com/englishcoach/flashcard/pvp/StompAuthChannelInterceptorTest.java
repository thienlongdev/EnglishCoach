package com.englishcoach.flashcard.pvp;

import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;

import java.time.Instant;
import java.util.Collections;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

class StompAuthChannelInterceptorTest {

    private JwtDecoder jwtDecoder;
    private CustomJwtAuthenticationConverter converter;
    private CardBlastPvPService pvpService;
    private StompAuthChannelInterceptor interceptor;

    @BeforeEach
    void setUp() {
        jwtDecoder = Mockito.mock(JwtDecoder.class);
        converter = Mockito.mock(CustomJwtAuthenticationConverter.class);
        pvpService = Mockito.mock(CardBlastPvPService.class);

        interceptor = new StompAuthChannelInterceptor(jwtDecoder, converter, pvpService);
    }

    @Test
    @DisplayName("Should authenticate CONNECT with valid Bearer token")
    void shouldAuthenticateValidConnect() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.CONNECT);
        accessor.setLeaveMutable(true);
        accessor.addNativeHeader("Authorization", "Bearer valid.jwt.token");
        accessor.setSessionId("session-1");
        Message<byte[]> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        Jwt jwt = new Jwt("valid.jwt.token", Instant.now(), Instant.now().plusSeconds(3600),
                Map.of("alg", "HS256"), Map.of("sub", "123"));
        when(jwtDecoder.decode("valid.jwt.token")).thenReturn(jwt);

        UserDetailsImpl userDetails = new UserDetailsImpl(123L, "user@test.com", "pass", Collections.emptyList());
        UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(userDetails, jwt, Collections.emptyList());
        when(converter.convert(jwt)).thenReturn(auth);

        Message<?> result = interceptor.preSend(message, Mockito.mock(MessageChannel.class));
        assertNotNull(result);

        StompHeaderAccessor resAccessor = StompHeaderAccessor.wrap(result);
        assertNotNull(resAccessor.getUser());
        assertEquals("user@test.com", resAccessor.getUser().getName());
    }

    @Test
    @DisplayName("Should reject CONNECT without token")
    void shouldRejectConnectWithoutToken() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.CONNECT);
        accessor.setSessionId("session-2");
        Message<byte[]> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        assertThrows(IllegalArgumentException.class, () ->
                interceptor.preSend(message, Mockito.mock(MessageChannel.class)));
    }

    @Test
    @DisplayName("Should authorize SUBSCRIBE when user is in room")
    void shouldAuthorizeSubscribeWhenInRoom() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        accessor.setDestination("/topic/pvp/ABC234");
        accessor.setSessionId("session-3");

        UserDetailsImpl userDetails = new UserDetailsImpl(123L, "user@test.com", "pass", Collections.emptyList());
        UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(userDetails, null, Collections.emptyList());
        accessor.setUser(auth);

        Message<byte[]> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        when(pvpService.isUserInRoom("ABC234", "123")).thenReturn(true);

        Message<?> result = interceptor.preSend(message, Mockito.mock(MessageChannel.class));
        assertNotNull(result);
    }

    @Test
    @DisplayName("Should reject SUBSCRIBE when user is NOT in room")
    void shouldRejectSubscribeWhenNotInRoom() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        accessor.setDestination("/topic/pvp/SECRET");
        accessor.setSessionId("session-4");

        UserDetailsImpl userDetails = new UserDetailsImpl(999L, "intruder@test.com", "pass", Collections.emptyList());
        UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(userDetails, null, Collections.emptyList());
        accessor.setUser(auth);

        Message<byte[]> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        when(pvpService.isUserInRoom("SECRET", "999")).thenReturn(false);

        assertNull(interceptor.preSend(message, Mockito.mock(MessageChannel.class)));
    }

    @Test
    @DisplayName("Should drop inbound messages exceeding rate limit of 30 msgs/s")
    void shouldEnforceRateLimiting() {
        String sessionId = "burst-session";
        MessageChannel channel = Mockito.mock(MessageChannel.class);

        // First 30 messages should pass
        for (int i = 0; i < 30; i++) {
            StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SEND);
            accessor.setSessionId(sessionId);
            accessor.setDestination("/app/pvp/ping");
            accessor.setUser(new UsernamePasswordAuthenticationToken("user", null, Collections.emptyList()));
            Message<byte[]> msg = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());
            Message<?> res = interceptor.preSend(msg, channel);
            assertNotNull(res, "Message " + (i + 1) + " should be allowed");
        }

        // 31st message should be dropped (null returned)
        StompHeaderAccessor overAccessor = StompHeaderAccessor.create(StompCommand.SEND);
        overAccessor.setSessionId(sessionId);
        overAccessor.setDestination("/app/pvp/ping");
        overAccessor.setUser(new UsernamePasswordAuthenticationToken("user", null, Collections.emptyList()));
        Message<byte[]> overMsg = MessageBuilder.createMessage(new byte[0], overAccessor.getMessageHeaders());
        Message<?> dropped = interceptor.preSend(overMsg, channel);
        assertNull(dropped, "31st message should be dropped by rate limiter");
    }
}
