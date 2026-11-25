package com.englishcoach.feedback.security;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.feedback.repository.FeedbackThreadRepository;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class FeedbackChannelGuardTest {
    @Test void ownerAndAdminReceiveThreadFramesWhileOtherUsersAndMalformedIdsNeverReachBroker() {
        var repository = mock(FeedbackThreadRepository.class);
        when(repository.existsByIdAndUserId(7L, 1L)).thenReturn(true);
        var inbound = new ExecutorSubscribableChannel();
        inbound.addInterceptor(new FeedbackChannelGuard(repository));
        var delivered = new AtomicInteger();
        inbound.subscribe(message -> delivered.incrementAndGet());
        assertThat(send(inbound, 1L, false, "/topic/feedback/7")).isTrue();
        assertThat(send(inbound, 2L, false, "/topic/feedback/7")).isFalse();
        assertThat(send(inbound, 3L, true, "/topic/feedback/7")).isTrue();
        for (String suffix : List.of("-7", "7/extra", "9223372036854775808", "x", "")) {
            assertThat(send(inbound, 1L, false, "/topic/feedback/" + suffix)).isFalse();
        }
        var anonymous = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        anonymous.setDestination("/topic/feedback/7");
        assertThat(inbound.send(MessageBuilder.createMessage(new byte[0], anonymous.getMessageHeaders()))).isFalse();
        assertThat(delivered.get()).isEqualTo(2);
    }
    private boolean send(ExecutorSubscribableChannel channel, long id, boolean admin, String destination) {
        var user = new UserDetailsImpl(id, "fixture@example.test", "", List.of(new SimpleGrantedAuthority(admin ? "ROLE_ADMIN" : "ROLE_USER")));
        var headers = StompHeaderAccessor.create(StompCommand.SUBSCRIBE);
        headers.setUser(new UsernamePasswordAuthenticationToken(user, null, user.getAuthorities()));
        headers.setDestination(destination);
        return channel.send(MessageBuilder.createMessage(new byte[0], headers.getMessageHeaders()));
    }
}
