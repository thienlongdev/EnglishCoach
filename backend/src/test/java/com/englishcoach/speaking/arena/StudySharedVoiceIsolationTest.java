package com.englishcoach.speaking.arena;

import com.englishcoach.studyspace.StudySharedService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.file.Path;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Verifies RT-04 and ARENA-02 fixes across the StudySharedService <-> ArenaUsage/ArenaVoice boundary. */
class StudySharedVoiceIsolationTest {
    @TempDir Path dir;

    private static JdbcTemplate mockJdbc() {
        var jdbc = mock(JdbcTemplate.class);
        when(jdbc.queryForObject(anyString(), eq(String.class), anyLong())).thenAnswer(i -> "Learner " + i.getArgument(2));
        when(jdbc.queryForObject(anyString(), eq(Integer.class), any())).thenReturn(0);
        return jdbc;
    }

    static class ControlledVoice implements ArenaVoice {
        boolean failCreate, failToken, removeExisted;
        Runnable onCreate, onToken;

        @Override public boolean available() { return true; }
        @Override public String url() { return "wss://example.livekit.cloud"; }
        @Override public void create(String room, int capacity) {
            if (onCreate != null) onCreate.run();
            if (failCreate) throw ArenaService.fail(503, "VOICE_UNAVAILABLE");
        }
        @Override public String token(String room, String identity, boolean publish) {
            if (onToken != null) onToken.run();
            if (failToken) throw ArenaService.fail(503, "VOICE_UNAVAILABLE");
            return "jwt-" + identity;
        }
        @Override public boolean remove(String room, String identity) { return removeExisted; }
        @Override public void close(String room) {}
    }

    @Test void ticketRunsLiveKitIoOutsideRoomLockRollsBackOnFailureAndSettles404AtZeroMinutes() throws Exception {
        var voice = new ControlledVoice();
        var jdbc = mockJdbc();
        try (var usage = new ArenaUsage(dir.toString(), 60, 8, new ObjectMapper())) {
            var service = new StudySharedService(voice, usage, jdbc);
            try {
                var created = service.create(1L, "Focus Room", 4);
                UUID roomId = created.room().id();

                // 1. If voice.create() throws, usage.open() must NOT be called (zero leaked 5-min lease)
                voice.failCreate = true;
                assertThrows(RuntimeException.class, () -> service.ticket(1L, roomId));
                long now = System.currentTimeMillis();
                assertEquals(0, usage.status(now).get("openConnections"), "failed voice.create() must not open a lease");
                assertEquals(0L, usage.status(now).get("usedMinutes"));

                // 2. While voice.create() is blocked on network I/O, heartbeat() / current() must NOT stall on synchronized(r)
                voice.failCreate = false;
                voice.failToken = true;
                var inCreate = new CountDownLatch(1);
                var releaseCreate = new CountDownLatch(1);
                voice.onCreate = () -> {
                    inCreate.countDown();
                    try { assertTrue(releaseCreate.await(3, TimeUnit.SECONDS)); }
                    catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                };

                var ticketAttempt = CompletableFuture.runAsync(() -> assertThrows(RuntimeException.class, () -> service.ticket(1L, roomId)));
                assertTrue(inCreate.await(3, TimeUnit.SECONDS), "ticket entered voice.create()");

                var hbDone = new CountDownLatch(1);
                new Thread(() -> {
                    assertNotNull(service.heartbeat(1L, roomId));
                    assertNotNull(service.current(1L));
                    hbDone.countDown();
                }).start();
                assertTrue(hbDone.await(1, TimeUnit.SECONDS), "heartbeat/current must not block while voice.create() runs");

                releaseCreate.countDown();
                ticketAttempt.get(3, TimeUnit.SECONDS);

                // 3. When voice.token() throws after usage.open(), the freshly opened lease must roll back cleanly
                now = System.currentTimeMillis();
                assertEquals(0, usage.status(now).get("openConnections"), "failed voice.token() must roll back freshly opened lease");
                assertEquals(0L, usage.status(now).get("usedMinutes"));

                // 4. Successful ticket followed by leaveVoice() when LiveKit returns 404 (e.g. client already disconnected WebRTC)
                // MUST conservatively charge the issued lease (>= 1m), preserving ArenaUsage's "whatever cannot be proven is charged" invariant.
                voice.onCreate = null;
                voice.failToken = false;
                voice.removeExisted = false;
                var ticket = service.ticket(1L, roomId);
                assertNotNull(ticket.token());
                assertEquals(1, usage.status(System.currentTimeMillis()).get("openConnections"));

                service.leaveVoice(1L, roomId);
                now = System.currentTimeMillis();
                assertEquals(0, usage.status(now).get("openConnections"));
                assertEquals(1L, usage.status(now).get("usedMinutes"), "issued lease must settle conservatively even when LiveKit remove returns 404");
            } finally {
                service.shutdown();
            }
        }
    }
}
