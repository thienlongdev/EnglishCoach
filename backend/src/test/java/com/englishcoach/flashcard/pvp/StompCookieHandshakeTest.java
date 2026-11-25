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
import org.springframework.security.oauth2.jwt.BadJwtException;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;

import java.time.Instant;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * A browser's STOMP CONNECT carries no token: it is authenticated by the application token the WebSocket handshake's
 * session cookie carried (kept in the WebSocket session attributes by the handshake interceptor), through the same
 * decoder and the same per-request session check as a header token.
 */
class StompCookieHandshakeTest {

    private JwtDecoder jwtDecoder;
    private CustomJwtAuthenticationConverter converter;
    private StompAuthChannelInterceptor interceptor;

    @BeforeEach
    void setUp() {
        jwtDecoder = Mockito.mock(JwtDecoder.class);
        converter = Mockito.mock(CustomJwtAuthenticationConverter.class);
        interceptor = new StompAuthChannelInterceptor(jwtDecoder, converter, Mockito.mock(CardBlastPvPService.class));
    }

    private Jwt accept(String token, long userId, String email) {
        Jwt jwt = new Jwt(token, Instant.now(), Instant.now().plusSeconds(600), Map.of("alg", "HS256"), Map.of("sub", "" + userId));
        when(jwtDecoder.decode(token)).thenReturn(jwt);
        UserDetailsImpl details = new UserDetailsImpl(userId, email, "x", Collections.emptyList());
        when(converter.convert(jwt)).thenReturn(new UsernamePasswordAuthenticationToken(details, jwt, Collections.emptyList()));
        return jwt;
    }

    private static Message<byte[]> connect(Map<String, Object> sessionAttributes, String authorizationHeader) {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.CONNECT);
        accessor.setLeaveMutable(true);
        accessor.setSessionId("ws-1");
        accessor.setSessionAttributes(sessionAttributes);
        if (authorizationHeader != null) accessor.addNativeHeader("Authorization", authorizationHeader);
        return MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());
    }

    @Test
    @DisplayName("CONNECT without any token in the frame is authenticated by the handshake cookie's token, which is then discarded")
    void cookieTokenAuthenticatesConnect() {
        accept("cookie.token", 7L, "learner@example.test");
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(StompAuthChannelInterceptor.HANDSHAKE_COOKIE_TOKEN, "cookie.token");

        Message<?> result = interceptor.preSend(connect(attributes, null), Mockito.mock(MessageChannel.class));

        assertNotNull(result);
        assertEquals("learner@example.test", StompHeaderAccessor.wrap(result).getUser().getName());
        assertEquals("7", attributes.get("PVP_USER_ID"));
        assertFalse(attributes.containsKey(StompAuthChannelInterceptor.HANDSHAKE_COOKIE_TOKEN),
                "the token is used for this frame only and not kept with the socket");
    }

    @Test
    @DisplayName("No cookie on the handshake and no token in the frame: CONNECT is refused")
    void nothingToAuthenticateWith() {
        assertThrows(IllegalArgumentException.class,
                () -> interceptor.preSend(connect(new HashMap<>(), null), Mockito.mock(MessageChannel.class)));
        verify(jwtDecoder, never()).decode(anyString());
    }

    @Test
    @DisplayName("A handshake cookie that no longer authenticates (expired token, revoked session) refuses the CONNECT")
    void deadCookieRefusesConnect() {
        when(jwtDecoder.decode("expired.token")).thenThrow(new BadJwtException("expired"));
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(StompAuthChannelInterceptor.HANDSHAKE_COOKIE_TOKEN, "expired.token");
        assertThrows(IllegalArgumentException.class,
                () -> interceptor.preSend(connect(attributes, null), Mockito.mock(MessageChannel.class)));

        Jwt jwt = new Jwt("revoked.token", Instant.now(), Instant.now().plusSeconds(600), Map.of("alg", "HS256"), Map.of("sub", "7"));
        when(jwtDecoder.decode("revoked.token")).thenReturn(jwt);
        when(converter.convert(jwt)).thenThrow(new org.springframework.security.oauth2.server.resource.InvalidBearerTokenException("revoked"));
        attributes.put(StompAuthChannelInterceptor.HANDSHAKE_COOKIE_TOKEN, "revoked.token");
        assertThrows(IllegalArgumentException.class,
                () -> interceptor.preSend(connect(attributes, null), Mockito.mock(MessageChannel.class)));
    }

    @Test
    @DisplayName("A token in the frame, when present, is the one that is checked (the non-browser path is unchanged)")
    void frameTokenStillWorks() {
        accept("header.token", 9L, "other@example.test");
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(StompAuthChannelInterceptor.HANDSHAKE_COOKIE_TOKEN, "cookie.token");
        Message<?> result = interceptor.preSend(connect(attributes, "Bearer header.token"), Mockito.mock(MessageChannel.class));
        assertEquals("other@example.test", StompHeaderAccessor.wrap(result).getUser().getName());
        verify(jwtDecoder, never()).decode("cookie.token");
    }
}
