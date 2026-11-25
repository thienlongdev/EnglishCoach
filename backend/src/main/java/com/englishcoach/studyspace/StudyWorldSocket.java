package com.englishcoach.studyspace;

import com.englishcoach.common.security.UserDetailsImpl;
import java.security.Principal;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.annotation.SendToUser;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Controller;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

@Controller
public class StudyWorldSocket {
    private final StudySharedService rooms;
    public StudyWorldSocket(StudySharedService rooms) { this.rooms = rooms; }

    @MessageMapping("/echo-life/presence")
    @SendToUser(value = "/queue/echo-life", broadcast = false)
    public StudyWorldPresence.Frame presence(StudyWorldPresence.Input input, Principal principal, StompHeaderAccessor headers) {
        if (input == null || headers == null || !(principal instanceof Authentication auth) || !(auth.getPrincipal() instanceof UserDetailsImpl user)) return null;
        return rooms.worldFrame(user.getId(), headers.getSessionId(), input);
    }

    @EventListener
    public void disconnected(SessionDisconnectEvent event) {
        if (event != null && event.getSessionId() != null) rooms.disconnectWorld(event.getSessionId());
    }
}
