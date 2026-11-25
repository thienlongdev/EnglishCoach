package com.englishcoach.messenger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.user.SimpUserRegistry;
import org.springframework.stereotype.Component;

/** The private queue of a person, on the socket every signed-in page already holds. A broker failure never reaches the caller: the database has the message. */
@Component
public class MessengerPush {
    private static final Logger log = LoggerFactory.getLogger(MessengerPush.class);
    private final SimpMessagingTemplate messages;
    private final SimpUserRegistry users;

    public MessengerPush(SimpMessagingTemplate messages, SimpUserRegistry users) {
        this.messages = messages;
        this.users = users;
    }

    public boolean online(String principal) {
        return principal != null && users.getUser(principal) != null;
    }

    public void send(String principal, MessengerDtos.Event event) {
        if (!online(principal)) return;
        try {
            messages.convertAndSendToUser(principal, "/queue/messenger", event);
        } catch (RuntimeException e) {
            log.warn("[Messenger] push failed: {}", e.getClass().getSimpleName());
        }
    }
}
