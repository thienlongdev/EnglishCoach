package com.englishcoach.spelling;

import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.*;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.*;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import java.util.Set;

@Configuration
public class SpellingChannelGuard implements WebSocketMessageBrokerConfigurer {
    static final Set<String> ACTIONS=Set.of("sync","create","quick","join","rejoin","ready","start","rematch","draft","answer","heard","repeat","audio-failed","move","ping","leave","finish");
    static Message<?> validate(Message<?> message) {
        var h=MessageHeaderAccessor.getAccessor(message,StompHeaderAccessor.class);
        if(h==null||h.getDestination()==null)return message;
        String d=h.getDestination();
        if(h.getCommand()==StompCommand.SEND&&d.contains("spelling")&&!d.startsWith("/app/spelling/"))throw new IllegalArgumentException("Spelling publication rejected");
        if(h.getCommand()==StompCommand.SEND&&d.startsWith("/app/spelling/")) {
            if(h.getUser()==null||!(message.getPayload() instanceof byte[] bytes)||bytes.length>1536||!ACTIONS.contains(d.substring(14)))throw new IllegalArgumentException("Spelling command rejected");
        }
        if(h.getCommand()==StompCommand.SUBSCRIBE&&d.contains("spelling")&&(h.getUser()==null||!d.equals("/user/queue/spelling")))throw new IllegalArgumentException("Spelling subscription rejected");
        return message;
    }
    @Override public void configureClientInboundChannel(org.springframework.messaging.simp.config.ChannelRegistration r){
        r.interceptors(new ChannelInterceptor(){@Override public Message<?> preSend(Message<?> m,MessageChannel c){return validate(m);}});
    }
}
