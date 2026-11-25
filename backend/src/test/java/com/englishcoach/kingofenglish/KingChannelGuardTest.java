package com.englishcoach.kingofenglish;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class KingChannelGuardTest {
    @Test void authenticatedBoundedCommandsPrivateSubscriptionsAndNamespaceIsolation(){
        var registration=mock(ChannelRegistration.class);
        new KingChannelGuard().configureClientInboundChannel(registration);
        var captor=ArgumentCaptor.forClass(ChannelInterceptor.class);verify(registration).interceptors(captor.capture());
        var guard=captor.getValue();
        for(String destination:java.util.List.of("/queue/king-of-english-user1","/user/other/queue/king-of-english","/topic/king-of-english/secret","/app/king-of-english/hack")){
            var h=StompHeaderAccessor.create(StompCommand.SEND);h.setDestination(destination);h.setUser(()->"user");
            var message=MessageBuilder.createMessage(new byte[1],h.getMessageHeaders());
            assertThrows(IllegalArgumentException.class,()->guard.preSend(message,null));
        }
        for(int size:java.util.List.of(1,2049)){
            var h=StompHeaderAccessor.create(StompCommand.SEND);h.setDestination("/app/king-of-english/answer");
            if(size>1)h.setUser(()->"user");
            var message=MessageBuilder.createMessage(new byte[size],h.getMessageHeaders());
            assertThrows(IllegalArgumentException.class,()->guard.preSend(message,null));
        }
        for(String destination:java.util.List.of("/queue/king-of-english","/user/other/queue/king-of-english","/topic/king-of-english/secret")){
            var h=StompHeaderAccessor.create(StompCommand.SUBSCRIBE);h.setDestination(destination);h.setUser(()->"user");
            var message=MessageBuilder.createMessage(new byte[0],h.getMessageHeaders());
            assertThrows(IllegalArgumentException.class,()->guard.preSend(message,null));
        }
        var anon=StompHeaderAccessor.create(StompCommand.SUBSCRIBE);anon.setDestination("/user/queue/king-of-english");
        var anonymous=MessageBuilder.createMessage(new byte[0],anon.getMessageHeaders());
        assertThrows(IllegalArgumentException.class,()->guard.preSend(anonymous,null));
        for(String destination:java.util.List.of("/app/pvp/hit","/app/word-chain/submit","/app/king-of-english/answer","/user/queue/king-of-english")){
            var h=StompHeaderAccessor.create(destination.startsWith("/user/")?StompCommand.SUBSCRIBE:StompCommand.SEND);
            h.setDestination(destination);h.setUser(()->"user");var m=MessageBuilder.createMessage(new byte[2048],h.getMessageHeaders());
            assertSame(m,guard.preSend(m,null));
        }
    }
}
