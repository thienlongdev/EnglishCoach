package com.englishcoach.speaking.arena;

import org.junit.jupiter.api.Test;
import org.springframework.messaging.Message;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.user.*;
import org.springframework.messaging.support.ExecutorSubscribableChannel;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ArenaEventsTest {
    @Test void disconnectedSocketNoticeCannotReplaceTheNewSocket() {
        var registry = mock(SimpUserRegistry.class);
        var user = mock(SimpUser.class);
        var replacement = mock(SimpSession.class);
        when(registry.getUser("same-user")).thenReturn(user);
        when(user.getSession("old-socket")).thenReturn(null);
        when(user.getSessions()).thenReturn(Set.of(replacement));
        when(replacement.getId()).thenReturn("new-socket");
        var resolver = new DefaultUserDestinationResolver(registry);
        var channel = new ExecutorSubscribableChannel();
        List<Message<?>> sent = new ArrayList<>();
        channel.subscribe(sent::add);
        var events = new ArenaEvents(new SimpMessagingTemplate(channel));

        events.send("same-user", "old-socket", new ArenaProtocol.Event("REPLACED", null, null, null));
        assertEquals(Set.of("/queue/speaking-arena-userold-socket"),
                resolver.resolveDestination(sent.getFirst()).getTargetDestinations());
        events.send("same-user", "new-socket", new ArenaProtocol.Event("ACK", UUID.randomUUID(), null, null));
        assertEquals(Set.of("/queue/speaking-arena-usernew-socket"),
                resolver.resolveDestination(sent.getLast()).getTargetDestinations());
    }
}
