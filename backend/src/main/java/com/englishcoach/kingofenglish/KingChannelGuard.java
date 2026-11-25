package com.englishcoach.kingofenglish;

import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.*;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.*;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

/** Only King inbound commands/private subscription; existing Games destinations are untouched. */
@Configuration
public class KingChannelGuard implements WebSocketMessageBrokerConfigurer {
    @Override public void configureClientInboundChannel(org.springframework.messaging.simp.config.ChannelRegistration r){
        r.interceptors(new ChannelInterceptor(){
            @Override public Message<?> preSend(Message<?> m,MessageChannel channel){
                var h=MessageHeaderAccessor.getAccessor(m,StompHeaderAccessor.class);if(h==null)return m;
                String d=h.getDestination();if(d==null)return m;
                if(h.getCommand()==StompCommand.SEND&&d.startsWith("/app/king-of-english/")){
                    if(h.getUser()==null||m.getPayload() instanceof byte[] b&&b.length>2048)throw new IllegalArgumentException("King command rejected");
                    String action=d.substring("/app/king-of-english/".length());
                    if(!java.util.Set.of("sync","continue","start","create","quick","join","ready","answer","clue","move","skip","next","leave","rejoin","rematch","ping").contains(action))
                        throw new IllegalArgumentException("King action rejected");
                }else if(h.getCommand()==StompCommand.SEND&&(d.contains("/queue/king-of-english")||d.startsWith("/topic/king-of-english")))
                    throw new IllegalArgumentException("King state is server-only");
                if(h.getCommand()==StompCommand.SUBSCRIBE&&d.contains("king-of-english")&&
                    (h.getUser()==null||!d.equals("/user/queue/king-of-english")))
                    throw new IllegalArgumentException("King subscription rejected");
                return m;
            }
        });
    }
}

