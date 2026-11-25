package com.englishcoach.quizrush;

import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.*;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.*;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import java.util.Set;

/** Narrow namespace guard; authentication and all other games remain unchanged. */
@Configuration
public class RushCompetitiveChannelGuard implements WebSocketMessageBrokerConfigurer {
    public static final Set<String> ACTIONS=Set.of("sync","create","bots","quick","join","rejoin","ping","input","ready","start","kick","leave","answer","dash","rush","skill","rematch");
    public static Message<?> validate(Message<?> m){
        var h=MessageHeaderAccessor.getAccessor(m,StompHeaderAccessor.class);if(h==null)return m;
        String d=h.getDestination();if(d==null)return m;
        if(h.getCommand()==StompCommand.SEND&&d.startsWith("/app/quiz-rush/")){
            if(h.getUser()==null||m.getPayload() instanceof byte[] b&&b.length>2048||!ACTIONS.contains(d.substring("/app/quiz-rush/".length())))throw new IllegalArgumentException("Rush command rejected");
        }
        if(h.getCommand()==StompCommand.SUBSCRIBE&&d.contains("quiz-rush")&&(h.getUser()==null||!d.equals("/user/queue/quiz-rush")))throw new IllegalArgumentException("Rush subscription rejected");
        if(h.getCommand()==StompCommand.SEND&&(d.contains("/queue/quiz-rush")||d.startsWith("/topic/quiz-rush")))throw new IllegalArgumentException("Rush state is server-only");
        return m;
    }
    @Override public void configureClientInboundChannel(org.springframework.messaging.simp.config.ChannelRegistration r){r.interceptors(new ChannelInterceptor(){@Override public Message<?> preSend(Message<?> m,MessageChannel c){return validate(m);}});}
}
