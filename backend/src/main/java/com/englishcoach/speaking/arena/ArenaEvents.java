package com.englishcoach.speaking.arena;

import org.springframework.stereotype.Component;
import org.springframework.messaging.simp.*;

@Component
public class ArenaEvents {
    private final SimpMessagingTemplate messages;
    public ArenaEvents(SimpMessagingTemplate messages) { this.messages = messages; }
    public void send(String principal, String session, ArenaProtocol.Event event) {
        if (session == null) return;
        var headers = SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);
        headers.setSessionId(session); headers.setLeaveMutable(true);
        // Address the exact socket. With a principal destination Spring falls back to ALL
        // current sessions when the old socket has left its registry; a late REPLACED
        // notice would then disconnect the very socket that just successfully rejoined.
        messages.convertAndSendToUser(session,"/queue/speaking-arena",event,headers.getMessageHeaders());
    }
}
