package com.englishcoach.messenger;

import com.englishcoach.common.security.UserDetailsImpl;
import jakarta.annotation.PreDestroy;
import org.springframework.context.event.EventListener;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.messaging.SessionConnectedEvent;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import java.security.Principal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Online or not comes from the broker's own registry of sockets: every signed-in page of the site holds one, so a person is online while ANY of their pages is open,
 * on any module, and closing one of three tabs changes nothing. A page load is a reconnect, so a change is told to friends only if it still holds a few seconds later:
 * moving between pages is not going offline, and it costs no database work. A tab that closed without saying so, or a lost network, is noticed by the broker's
 * heartbeat (10 s each way) and arrives here as the same disconnect.
 *
 * "Last active" is written ONCE, when a person's last page has gone (and for everyone still online when the server stops): never on a heartbeat, never while they are
 * online. One thread does all of it, so a burst of reconnects after a release is a short queue here and never a burst on the database. Under load, telling friends
 * waits for the next change; the time itself is still written.
 */
@Component
public class MessengerPresence {
    private static final long SETTLE_MS = 8000;
    private final MessengerRepository repo;
    private final MessengerPush push;
    private final MessengerLoad load;
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> { Thread t = new Thread(r, "messenger-presence"); t.setDaemon(true); return t; });
    private final Map<Long, ScheduledFuture<?>> pending = new ConcurrentHashMap<>();
    private final Map<Long, Boolean> told = new ConcurrentHashMap<>();

    public MessengerPresence(MessengerRepository repo, MessengerPush push, MessengerLoad load) {
        this.repo = repo;
        this.push = push;
        this.load = load;
    }

    private void changed(Principal principal) {
        if (!(principal instanceof Authentication a) || !(a.getPrincipal() instanceof UserDetailsImpl user) || user.getId() == null) return;
        long id = user.getId();
        String name = principal.getName();
        ScheduledFuture<?> old = pending.remove(id);
        if (old != null) old.cancel(false);
        if (pending.size() > 8192) return;
        pending.put(id, timer.schedule(() -> settle(id, name), SETTLE_MS, TimeUnit.MILLISECONDS));
    }

    void settle(long id, String principal) {
        pending.remove(id);
        try {
            boolean online = push.online(principal);
            Boolean before = told.get(id);
            if (before != null && before == online) return;
            told.put(id, online);
            if (told.size() > 16384) told.clear();
            // Their last page has gone: this is when they were last here. Written whether or not friends are told now.
            if (!online) repo.lastSeen(List.of(id));
            if (load.busy()) return;
            // First sight of someone coming online is news; first sight of someone going offline after a restart is too.
            MessengerDtos.Event event = MessengerDtos.Event.presence(id, online, online ? null : Instant.now());
            for (String friend : repo.friendPrincipals(id)) push.send(friend, event);
        } catch (RuntimeException ignored) {
            // Presence is a courtesy; the next list read tells the truth anyway.
        }
    }

    @EventListener public void connected(SessionConnectedEvent event) { changed(event.getUser()); }
    @EventListener public void disconnected(SessionDisconnectEvent event) { changed(event.getUser()); }

    /** The server is stopping: everyone it knew to be online was last seen now (one statement). After the restart their pages reconnect and they are online again. */
    @PreDestroy public void close() {
        timer.shutdownNow();
        try {
            List<Long> here = new ArrayList<>();
            told.forEach((id, online) -> { if (online && here.size() < 5000) here.add(id); });
            repo.lastSeen(here);
        } catch (RuntimeException ignored) {
            // The database may already be closing; a missing time only means no "last active" is shown.
        }
    }
}
