package com.englishcoach.wordchain;

import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.*;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.*;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

/** Protect only the new namespace. Card Blast destinations retain their existing behavior. */
@Configuration
public class WordChainChannelGuard implements WebSocketMessageBrokerConfigurer {
    @Override public void configureClientInboundChannel(org.springframework.messaging.simp.config.ChannelRegistration registration) {
        registration.interceptors(new ChannelInterceptor() {
            @Override public Message<?> preSend(Message<?> message, MessageChannel channel) {
                var h=MessageHeaderAccessor.getAccessor(message,StompHeaderAccessor.class);
                if(h==null || h.getCommand()!=StompCommand.SEND) return message;
                String d=h.getDestination();if(d==null) return message;
                if(d.startsWith("/app/word-chain/")) {
                    if(h.getUser()==null || (message.getPayload() instanceof byte[] bytes && bytes.length>1024))
                        throw new IllegalArgumentException("Word Chain command rejected");
                } else if(d.contains("/queue/word-chain") || d.startsWith("/topic/word-chain")) {
                    throw new IllegalArgumentException("Word Chain state is server-only");
                }
                return message;
            }
        });
    }
}
