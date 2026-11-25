package com.englishcoach.speaking.arena;

import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.*;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.*;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import java.util.Set;

@Configuration
public class ArenaChannelGuard implements WebSocketMessageBrokerConfigurer {
    static final Set<String> ACTIONS = Set.of(
            "take-item", "turn-item", "put-item", "sit", "stand", "board", "disembark", "jump-overboard", "climb-dock", "boat-free", "engine", "observe", "row", "beacon", "topic",
            "sync", "create", "quick", "join", "rejoin", "ping", "move", "ready", "team",
            "round", "stop", "free", "award", "mute", "kick", "leave", "end", "rematch",
            "wave", "listen", "cheer", "clap", "dance", "cast", "reel", "catch", "shake"
    );

    static Message<?> validate(Message<?> message) {
        var h = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (h == null || h.getDestination() == null) return message;
        String d = h.getDestination();
        if (h.getCommand() == StompCommand.SEND && d.contains("speaking-arena") && !d.startsWith("/app/speaking-arena/"))
            throw new IllegalArgumentException("Arena publication rejected");
        if (h.getCommand() == StompCommand.SEND && d.startsWith("/app/speaking-arena/")) {
            if (h.getUser() == null || !(message.getPayload() instanceof byte[] bytes) || bytes.length > 1536
                    || !ACTIONS.contains(d.substring("/app/speaking-arena/".length())))
                throw new IllegalArgumentException("Arena command rejected");
        }
        if (h.getCommand() == StompCommand.SUBSCRIBE && d.contains("speaking-arena")
                && (h.getUser() == null || !d.equals("/user/queue/speaking-arena")))
            throw new IllegalArgumentException("Arena subscription rejected");
        return message;
    }

    @Override
    public void configureClientInboundChannel(org.springframework.messaging.simp.config.ChannelRegistration r) {
        r.interceptors(new ChannelInterceptor() {
            @Override
            public Message<?> preSend(Message<?> m, MessageChannel c) {
                return validate(m);
            }
        });
    }
}
