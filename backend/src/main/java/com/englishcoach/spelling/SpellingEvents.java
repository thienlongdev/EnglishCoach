package com.englishcoach.spelling;

import org.springframework.stereotype.Component;
import org.springframework.messaging.simp.*;

/** Uses Speaking Arena's exact-session routing pattern on the one existing STOMP broker. */
@Component
public class SpellingEvents {
    private final SimpMessagingTemplate messages;
    public SpellingEvents(SimpMessagingTemplate messages) { this.messages=messages; }
    public void send(String session,SpellingProtocol.Event event) {
        if(session==null)return;
        var headers=SimpMessageHeaderAccessor.create(SimpMessageType.MESSAGE);
        headers.setSessionId(session);headers.setLeaveMutable(true);
        messages.convertAndSendToUser(session,"/queue/spelling",event,headers.getMessageHeaders());
    }
}
