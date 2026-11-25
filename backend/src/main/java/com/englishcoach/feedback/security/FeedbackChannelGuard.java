package com.englishcoach.feedback.security;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.feedback.repository.FeedbackThreadRepository;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.core.Authentication;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

/** Feedback messages have the same owner/admin visibility as the REST thread. */
@Configuration
public class FeedbackChannelGuard implements WebSocketMessageBrokerConfigurer, ChannelInterceptor {
    private final FeedbackThreadRepository threads;

    public FeedbackChannelGuard(FeedbackThreadRepository threads) { this.threads = threads; }

    @Override public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(this);
    }

    @Override public Message<?> preSend(Message<?> message, MessageChannel channel) {
        var headers = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (headers == null || headers.getCommand() != StompCommand.SUBSCRIBE) return message;
        String destination = headers.getDestination();
        if (destination == null || !destination.startsWith("/topic/feedback/")) return message;
        String id = destination.substring("/topic/feedback/".length());
        if (!id.matches("[1-9][0-9]{0,18}") || !(headers.getUser() instanceof Authentication auth)
                || !auth.isAuthenticated() || !(auth.getPrincipal() instanceof UserDetailsImpl user)) return null;
        long threadId;
        try { threadId = Long.parseLong(id); } catch (NumberFormatException invalid) { return null; }
        boolean admin = auth.getAuthorities().stream().anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
        return admin || threads.existsByIdAndUserId(threadId, user.getId()) ? message : null;
    }
}
