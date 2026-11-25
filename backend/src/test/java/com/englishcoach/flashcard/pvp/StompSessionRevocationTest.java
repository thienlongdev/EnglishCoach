package com.englishcoach.flashcard.pvp;

import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.jwt.JwtDecoder;

import java.time.Instant;
import java.util.Collections;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * An established WebSocket does not outlive its sign-in session: once the session is revoked (sign-out elsewhere,
 * "end other sessions", an administrator, a password change) the next frame after the re-check interval is refused.
 */
class StompSessionRevocationTest {

    private static final UUID SESSION = UUID.randomUUID();

    private static UsernamePasswordAuthenticationToken user() {
        var auth = new UsernamePasswordAuthenticationToken(
                new UserDetailsImpl(7L, "learner@example.test", "x", Collections.emptyList()), null, Collections.emptyList());
        auth.setDetails(new AuthSessionContext(SESSION, 7L, "CREDENTIALS", Instant.now(), null, null, null));
        return auth;
    }

    private static Message<byte[]> frame(StompCommand command, String destination) {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(command);
        accessor.setLeaveMutable(true);
        accessor.setSessionId("ws-revoked");
        accessor.setUser(user());
        accessor.setDestination(destination);
        return MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());
    }

    @Test
    @DisplayName("A frame of a connection whose session was revoked is refused; a live session keeps working")
    void revokedSessionClosesTheSocket() {
        AuthSessionService sessions = Mockito.mock(AuthSessionService.class);
        StompAuthChannelInterceptor interceptor = new StompAuthChannelInterceptor(Mockito.mock(JwtDecoder.class),
                Mockito.mock(CustomJwtAuthenticationConverter.class), Mockito.mock(CardBlastPvPService.class));
        interceptor.setAuthSessionService(sessions);
        MessageChannel channel = Mockito.mock(MessageChannel.class);

        when(sessions.validateAndTouchActiveSession(any(), any())).thenReturn(true);
        assertNotNull(interceptor.preSend(frame(StompCommand.SEND, "/app/pvp/ping"), channel));
        // within the re-check interval the row is not read again
        assertNotNull(interceptor.preSend(frame(StompCommand.SEND, "/app/pvp/ping"), channel));
        verify(sessions, times(1)).validateAndTouchActiveSession(SESSION, 7L);

        // a fresh interceptor state (interval elapsed) and a revoked row: refused
        StompAuthChannelInterceptor later = new StompAuthChannelInterceptor(Mockito.mock(JwtDecoder.class),
                Mockito.mock(CustomJwtAuthenticationConverter.class), Mockito.mock(CardBlastPvPService.class));
        later.setAuthSessionService(sessions);
        when(sessions.validateAndTouchActiveSession(any(), any())).thenReturn(false);
        assertThrows(IllegalArgumentException.class, () -> later.preSend(frame(StompCommand.SEND, "/app/pvp/ping"), channel));
        assertThrows(IllegalArgumentException.class,
                () -> later.preSend(frame(StompCommand.SUBSCRIBE, "/user/queue/pvp"), channel));
    }
}
