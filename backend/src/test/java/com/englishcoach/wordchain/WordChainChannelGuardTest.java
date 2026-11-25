package com.englishcoach.wordchain;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class WordChainChannelGuardTest {
    @Test void blocksForgedStateAndOversizedCommandsWithoutChangingOtherGames() {
        var registration=mock(ChannelRegistration.class);
        new WordChainChannelGuard().configureClientInboundChannel(registration);
        var captor=ArgumentCaptor.forClass(ChannelInterceptor.class);verify(registration).interceptors(captor.capture());
        var guard=captor.getValue();
        for(String destination:java.util.List.of("/queue/word-chain-user1","/user/other/queue/word-chain","/topic/word-chain/secret")) {
            var h=StompHeaderAccessor.create(StompCommand.SEND);h.setDestination(destination);
            var message=MessageBuilder.createMessage(new byte[0],h.getMessageHeaders());
            assertThrows(IllegalArgumentException.class,()->guard.preSend(message,null));
        }
        var h=StompHeaderAccessor.create(StompCommand.SEND);h.setDestination("/app/word-chain/submit");
        var anonymous=MessageBuilder.createMessage(new byte[1],h.getMessageHeaders());
        assertThrows(IllegalArgumentException.class,()->guard.preSend(anonymous,null));
        h=StompHeaderAccessor.create(StompCommand.SEND);h.setDestination("/app/word-chain/submit");
        h.setUser(()->"user");var oversized=MessageBuilder.createMessage(new byte[1025],h.getMessageHeaders());
        assertThrows(IllegalArgumentException.class,()->guard.preSend(oversized,null));
        h=StompHeaderAccessor.create(StompCommand.SEND);h.setDestination("/app/pvp/hit");
        var cardBlast=MessageBuilder.createMessage(new byte[2048],h.getMessageHeaders());
        assertSame(cardBlast,guard.preSend(cardBlast,null));
    }
}
