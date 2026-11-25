package com.englishcoach.notification.security;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class StompSecurityTest {

    @Mock
    private JwtDecoder jwtDecoder;

    @Mock
    private CustomJwtAuthenticationConverter authConverter;

    @Mock
    private CardBlastPvPService pvpService;

    @Mock
    private MessageChannel messageChannel;

    private StompAuthChannelInterceptor interceptor;

    private final Long userAId = 1L;
    private final Long userBId = 2L;

    private UsernamePasswordAuthenticationToken authUserA;
    private UsernamePasswordAuthenticationToken authUserB;

    @BeforeEach
    void setUp() {
        interceptor = new StompAuthChannelInterceptor(jwtDecoder, authConverter, pvpService);

        UserDetailsImpl userDetailsA = new UserDetailsImpl(userAId, "usera@example.com", "pass",
                List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority("ROLE_USER")));
        authUserA = new UsernamePasswordAuthenticationToken(userDetailsA, null, userDetailsA.getAuthorities());

        UserDetailsImpl userDetailsB = new UserDetailsImpl(userBId, "userb@example.com", "pass",
                List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority("ROLE_USER")));
        authUserB = new UsernamePasswordAuthenticationToken(userDetailsB, null, userDetailsB.getAuthorities());
    }

    @Test
    @DisplayName("P0-A: Reject unauthenticated CONNECT (missing token)")
    void testConnect_MissingToken_Rejected() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.CONNECT);
        Message<?> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        assertThatThrownBy(() -> interceptor.preSend(message, messageChannel))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("missing token");
    }

    @Test
    @DisplayName("P0-A: Valid token on CONNECT sets authenticated user on message headers")
    void testConnect_ValidToken_Authenticated() {
        String token = "valid-jwt-token";
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.CONNECT);
        accessor.addNativeHeader("Authorization", "Bearer " + token);
        Message<?> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        Jwt jwt = new Jwt(token, Instant.now(), Instant.now().plusSeconds(3600), Map.of("alg", "none"), Map.of("sub", "usera@example.com"));
        when(jwtDecoder.decode(eq(token))).thenReturn(jwt);
        when(authConverter.convert(eq(jwt))).thenReturn(authUserA);

        Message<?> result = interceptor.preSend(message, messageChannel);
        assertThat(result).isNotNull();

        StompHeaderAccessor resultAccessor = StompHeaderAccessor.wrap(result);
        assertThat(resultAccessor.getUser()).isEqualTo(authUserA);
    }

    @Test
    @DisplayName("P0-A: Reject SUBSCRIBE from unauthenticated session")
    void testSubscribe_Unauthenticated_Rejected() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        accessor.setDestination("/user/queue/notifications");
        Message<?> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        assertThatThrownBy(() -> interceptor.preSend(message, messageChannel))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("unauthenticated");
    }

    @Test
    @DisplayName("P0-A: Allowed SUBSCRIBE to private user destination /user/queue/notifications")
    void testSubscribe_UserQueueNotifications_Allowed() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        accessor.setUser(authUserA);
        accessor.setDestination("/user/queue/notifications");
        Message<?> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        Message<?> result = interceptor.preSend(message, messageChannel);
        assertThat(result).isNotNull();
    }

    @Test
    @DisplayName("P0-A: Reject SUBSCRIBE to raw /queue/ to prevent cross-session eavesdropping")
    void testSubscribe_RawQueue_Rejected() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        accessor.setUser(authUserB);
        accessor.setDestination("/queue/notifications");
        Message<?> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        assertThat(interceptor.preSend(message, messageChannel)).isNull();
    }

    @Test
    @DisplayName("P0-A: Allowed SUBSCRIBE to public /topic/system-announcements")
    void testSubscribe_PublicAnnouncementTopic_Allowed() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        accessor.setUser(authUserA);
        accessor.setDestination("/topic/system-announcements");
        Message<?> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        Message<?> result = interceptor.preSend(message, messageChannel);
        assertThat(result).isNotNull();
    }

    @Test
    @DisplayName("P0-A: Reject SUBSCRIBE to unwhitelisted destination")
    void testSubscribe_UnwhitelistedDestination_Rejected() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        accessor.setUser(authUserA);
        accessor.setDestination("/topic/admin/secret-channel");
        Message<?> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        assertThat(interceptor.preSend(message, messageChannel)).isNull();
    }

    @Test
    @DisplayName("P0-A: User B cannot subscribe to another user's badge/queue")
    void testSubscribe_CrossUserForbidden() {
        StompHeaderAccessor accessor = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        accessor.setUser(authUserB); // User B (id = 2)
        accessor.setDestination("/topic/user/1/feedback-badge"); // Target User A (id = 1)
        Message<?> message = MessageBuilder.createMessage(new byte[0], accessor.getMessageHeaders());

        assertThat(interceptor.preSend(message, messageChannel)).isNull();
    }

    @Test
    void forbiddenSubscriptionsNeverReachBrokerSubscribers() {
        var inbound = new org.springframework.messaging.support.ExecutorSubscribableChannel();
        inbound.addInterceptor(interceptor);
        var deliveries = new java.util.concurrent.atomic.AtomicInteger();
        inbound.subscribe(message -> deliveries.incrementAndGet());
        for (String destination : List.of("/queue/notifications", "/topic/admin/secret-channel",
                "/topic/user/1/feedback-badge", "/topic/pvp/PRIVATE")) {
            var headers = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
            headers.setUser(authUserB);
            headers.setDestination(destination);
            assertThat(inbound.send(MessageBuilder.createMessage(new byte[0], headers.getMessageHeaders()))).isFalse();
        }
        assertThat(deliveries.get()).isZero();
        var own = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        own.setUser(authUserA);
        own.setDestination("/topic/user/1/feedback-badge");
        assertThat(inbound.send(MessageBuilder.createMessage(new byte[0], own.getMessageHeaders()))).isTrue();
        assertThat(deliveries.get()).isEqualTo(1);
    }

    @Test
    void clientsCannotForgeBrokerPayloadsAndAnonymousCommandsAreRejected() {
        for (String destination : List.of("/topic/system-announcements", "/topic/pvp/PRIVATE",
                "/queue/notifications", "/user/queue/notifications", "/topic/feedback/1", "")) {
            var headers = StompHeaderAccessor.create(StompCommand.SEND);
            headers.setUser(authUserA);
            headers.setDestination(destination);
            var message = MessageBuilder.createMessage("forged payload".getBytes(), headers.getMessageHeaders());
            assertThatThrownBy(() -> interceptor.preSend(message, messageChannel))
                    .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("destination forbidden");
        }
        var anonymous = StompHeaderAccessor.create(StompCommand.SEND);
        anonymous.setDestination("/app/pvp/create");
        var message = MessageBuilder.createMessage(new byte[0], anonymous.getMessageHeaders());
        assertThatThrownBy(() -> interceptor.preSend(message, messageChannel))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("unauthenticated");
        var authenticated = StompHeaderAccessor.create(StompCommand.SEND);
        authenticated.setDestination("/app/pvp/create");
        authenticated.setUser(authUserA);
        var authorized = MessageBuilder.createMessage(new byte[0], authenticated.getMessageHeaders());
        assertThat(interceptor.preSend(authorized, messageChannel)).isSameAs(authorized);
    }
}
