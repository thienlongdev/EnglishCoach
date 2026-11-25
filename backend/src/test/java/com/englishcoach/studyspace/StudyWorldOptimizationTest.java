package com.englishcoach.studyspace;

import com.englishcoach.echolife.EchoLifeBulkhead;
import com.englishcoach.echolife.EchoLifeException;
import com.englishcoach.echolife.EchoLifeGameService.EventWindow;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.speaking.arena.ArenaUsage;
import com.englishcoach.speaking.arena.ArenaVoice;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.*;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class StudyWorldOptimizationTest {

    static class TestClock extends Clock {
        long ms = Instant.parse("2026-11-21T06:00:00Z").toEpochMilli();
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId z) { return this; }
        public Instant instant() { return Instant.ofEpochMilli(ms); }
    }

    @SuppressWarnings("unchecked")
    private static StudySharedService newService(TestClock clock, int maxRooms, int maxPlayers, double radius, int maxPeers) {
        var voice = mock(ArenaVoice.class);
        var usage = mock(ArenaUsage.class);
        var jdbc = mock(JdbcTemplate.class);
        when(jdbc.queryForObject(anyString(), eq(String.class), anyLong())).thenAnswer(i -> "Learner " + i.getArgument(2));
        var provider = (ObjectProvider<EchoLifeBulkhead>) mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(new EchoLifeBulkhead(10, 2000));
        var svc = new StudySharedService(voice, usage, jdbc, clock);
        svc.configureSharedWorld(true, true, maxRooms, maxPlayers, radius, maxPeers, provider);
        return svc;
    }

    @Test
    void spatialInterestRadiusAndNearestPeerCapFilterSameZonePeers() {
        var clock = new TestClock();
        var svc = newService(clock, 10, 50, 50.0, 2);
        var created = svc.create(1, "Spatial", 5);
        UUID room = created.room().id();
        svc.join(2, created.invite());
        svc.join(3, created.invite());
        svc.join(4, created.invite());
        svc.join(5, created.invite());

        // User 1 at x=0; User 2 at 10 m, User 3 at 30 m, User 4 at 40 m (all within 50 m), User 5 at 120 m (beyond radius)
        svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 1, new StudyWorldPresence.Pose("street", 0.123456, 0, 0, 0.5555, "LYRA"), null));
        svc.worldFrame(2, "s2", new StudyWorldPresence.Input(room, 1, new StudyWorldPresence.Pose("street", 10, 0, 0, 0, "KAI"), null));
        svc.worldFrame(3, "s3", new StudyWorldPresence.Input(room, 1, new StudyWorldPresence.Pose("street", 30, 0, 0, 0, "KAI"), null));
        svc.worldFrame(4, "s4", new StudyWorldPresence.Input(room, 1, new StudyWorldPresence.Pose("street", 40, 0, 0, 0, "KAI"), null));
        svc.worldFrame(5, "s5", new StudyWorldPresence.Input(room, 1, new StudyWorldPresence.Pose("street", 120, 0, 0, 0, "KAI"), null));

        clock.ms += 200;
        var frame = svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 2, new StudyWorldPresence.Pose("street", 0.123456, 0, 0, 0.5555, "LYRA"), null));
        assertThat(frame).isNotNull();
        // Capped at maxPeers=2 nearest within 50 m -> users 2 (10 m) and 3 (30 m); user 4 (40 m) and user 5 (120 m) excluded.
        assertThat(frame.peers()).extracting(StudyWorldPresence.Peer::id).containsExactly(2L, 3L);
        // Pose quantized to 1 mm precision
        assertThat(svc.worldFrame(2, "s2", new StudyWorldPresence.Input(room, 2, new StudyWorldPresence.Pose("street", 10, 0, 0, 0, "KAI"), null))
                .peers().stream().filter(p -> p.id() == 1L).findFirst().orElseThrow().pose().x()).isEqualTo(0.123);
    }

    @Test
    void concurrentPlayerCapRefusesExcessWithoutDisruptingActivePlayersAndDisconnectFreesSlotAndBike() {
        var clock = new TestClock();
        var svc = newService(clock, 10, 2, 90.0, 8);
        var created = svc.create(1, "Cap Room", 4);
        UUID room = created.room().id();
        svc.join(2, created.invite());
        svc.join(3, created.invite());

        var park = new StudyWorldPresence.Pose("park", 1.2, 0, 0.8, 0, "LYRA");
        var f1 = svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 1, park, null));
        var bike = f1.equipment().get(0);
        clock.ms += 200;
        var claimed = svc.worldFrame(2, "s2", new StudyWorldPresence.Input(room, 1, park, null,
                new StudyWorldEquipment.Intent("claim", bike.id(), bike.revision())));
        assertThat(claimed.actionResult()).isEqualTo("CLAIMED");
        assertThat(svc.activeWorldPlayerCount()).isEqualTo(2);

        // Third player exceeds maxPlayers=2 -> WORLD_FULL immediately
        var full = svc.worldFrame(3, "s3", new StudyWorldPresence.Input(room, 1, park, null));
        assertThat(full).isNotNull();
        assertThat(full.actionResult()).isEqualTo("WORLD_FULL");
        assertThat(full.peers()).isEmpty();
        assertThat(svc.activeWorldPlayerCount()).isEqualTo(2);

        // User 2 disconnects abruptly -> O(1) cleanup frees slot AND immediately releases the shared bike!
        svc.disconnectWorld("s2");
        assertThat(svc.activeWorldPlayerCount()).isEqualTo(1);
        clock.ms += 200;
        var afterDrop = svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 2, park, null));
        assertThat(afterDrop.peers()).isEmpty();
        assertThat(afterDrop.equipment().get(0).holder()).isNull();

        // Now user 3 can enter the freed slot!
        var admitted = svc.worldFrame(3, "s3", new StudyWorldPresence.Input(room, 2, park, null));
        assertThat(admitted.actionResult()).isNull();
        assertThat(admitted.peers()).extracting(StudyWorldPresence.Peer::id).containsExactly(1L);
        assertThat(svc.activeWorldPlayerCount()).isEqualTo(2);
    }

    @Test
    void sweepClearsIdleWorldPresenceAndExpiredEvents() {
        var clock = new TestClock();
        var svc = newService(clock, 10, 10, 90.0, 8);
        var created = svc.create(1, "Idle Room", 4);
        UUID room = created.room().id();
        var park = new StudyWorldPresence.Pose("park", 2, 0, 2, 0, "KAI");
        svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 1, park, null));
        svc.inviteToEvent(1, room, "evt_park", () -> Optional.of(new EventWindow("evt_park", "park", "Gathering", 4000)));
        assertThat(svc.activeWorldPlayerCount()).isEqualTo(1);

        // Advance past EXPIRE_MS (3500 ms) and event duration (4000 ms), then sweep
        clock.ms += 5000;
        svc.sweep();
        assertThat(svc.activeWorldPlayerCount()).isZero();
        // Re-entering after expiry works cleanly and event is gone
        var next = svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 2, park, null));
        assertThat(next.event()).isNull();
    }

    @Test
    void echoLifeBulkheadRejectsWith503WhenSaturatedAndRecovers() throws Exception {
        var bulkhead = new EchoLifeBulkhead(1, 150);
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var holder = pool.submit(() -> bulkhead.execute(() -> {
                entered.countDown();
                try { release.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
                return "ok";
            }));
            assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> bulkhead.execute(() -> "second"))
                    .isInstanceOf(EchoLifeException.class)
                    .hasMessage("ECHO_LIFE_BUSY");
            assertThat(bulkhead.stats().rejected()).isEqualTo(1);
            release.countDown();
            assertThat(holder.get(2, TimeUnit.SECONDS)).isEqualTo("ok");
            assertThat(bulkhead.execute(() -> "recovered")).isEqualTo("recovered");
        }
    }

    @Test
    void stompInterceptorEnforcesEchoLifeRateLimitAndCleansUpOnDisconnectEvent() {
        var interceptor = new StompAuthChannelInterceptor(
                mock(JwtDecoder.class), mock(CustomJwtAuthenticationConverter.class), mock(CardBlastPvPService.class));
        var channel = mock(MessageChannel.class);
        var user = new UserDetailsImpl(5L, "learner5@example.test", "", List.of());
        var auth = new UsernamePasswordAuthenticationToken(user, null, user.getAuthorities());

        int passed = 0;
        for (int i = 0; i < 20; i++) {
            var acc = StompHeaderAccessor.create(StompCommand.SEND);
            acc.setLeaveMutable(true);
            acc.setSessionId("ws-echo-flood");
            acc.setUser(auth);
            acc.setDestination("/app/echo-life/presence");
            var msg = MessageBuilder.createMessage(new byte[0], acc.getMessageHeaders());
            if (interceptor.preSend(msg, channel) != null) passed++;
        }
        assertThat(passed).isEqualTo(12);

        // Abrupt SessionDisconnectEvent clears rate bucket immediately
        var discAcc = StompHeaderAccessor.create(StompCommand.DISCONNECT);
        discAcc.setSessionId("ws-echo-flood");
        var discMsg = MessageBuilder.createMessage(new byte[0], discAcc.getMessageHeaders());
        interceptor.onSessionDisconnect(new SessionDisconnectEvent(this, discMsg, "ws-echo-flood", CloseStatus.GOING_AWAY));

        var afterAcc = StompHeaderAccessor.create(StompCommand.SEND);
        afterAcc.setLeaveMutable(true);
        afterAcc.setSessionId("ws-echo-flood");
        afterAcc.setUser(auth);
        afterAcc.setDestination("/app/echo-life/presence");
        assertThat(interceptor.preSend(MessageBuilder.createMessage(new byte[0], afterAcc.getMessageHeaders()), channel)).isNotNull();
    }

    @Test
    void avatarLookV2VehiclePoseExpandedEmotesAndQuickChatSyncAndClearOnDisconnect() {
        var clock = new TestClock();
        var svc = newService(clock, 16, 64, 90.0, 12);
        var created = svc.create(1, "Plaza Hangout", 4);
        UUID room = created.room().id();
        svc.join(2, created.invite());

        String validV2 = "v2:l:long_wave:cb9578:4a6b8c:808080808080:80808080808080808080808080808080:hoodie.-.jeans.sneakers.glasses.40303f.2f3a55.2c3e5e.f2efe6.3b3f55";
        var mountedCar = new StudyWorldPresence.Pose("street", 4, 0, 2, 0.5, "LYRA", 6.0, "mounted",
                new StudyWorldPresence.VehiclePose("mango", "#FF6B35", 5));
        var observerPose = new StudyWorldPresence.Pose("street", 8, 0, 2, 0, "KAI");

        // User 1 sends V2 look + mounted VehiclePose + expanded emote ("toast") + allowlisted quickChat ("qc_hi")
        assertThat(svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 1, mountedCar, "toast", null, null, null, validV2, "qc_hi"))).isNotNull();
        var seenBy2 = svc.worldFrame(2, "s2", new StudyWorldPresence.Input(room, 1, observerPose, "dance", null, null, null, null, "qc_study_together"));
        assertThat(seenBy2).isNotNull();
        assertThat(seenBy2.peers()).hasSize(1);
        var peer1 = seenBy2.peers().get(0);
        assertThat(peer1.look()).isEqualTo(validV2);
        assertThat(peer1.emote()).isEqualTo("toast");
        assertThat(peer1.quickChat()).isEqualTo("qc_hi");
        assertThat(peer1.quickChatAt()).isEqualTo(clock.ms);
        assertThat(peer1.pose().vehicle()).isEqualTo(new StudyWorldPresence.VehiclePose("mango", "#ff6b35", 5));

        // Subsequent frame omits look (null) -> cached V2 look persists without re-sending 180 bytes every 80 ms!
        clock.ms += 200;
        var mountedMoto = new StudyWorldPresence.Pose("street", 6, 0, 2, 0.7, "LYRA", 6.0, "mounted",
                new StudyWorldPresence.VehiclePose("cafe_racer", "#1c2d4a", 15));
        assertThat(svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 2, mountedMoto, null, null, null, null, null, null))).isNotNull();
        var seenAgain = svc.worldFrame(2, "s2", new StudyWorldPresence.Input(room, 2, observerPose, null));
        assertThat(seenAgain.peers().get(0).look()).isEqualTo(validV2);
        assertThat(seenAgain.peers().get(0).pose().vehicle()).isEqualTo(new StudyWorldPresence.VehiclePose("cafe_racer", "#1c2d4a", 15));

        // Invalid VehiclePose (unmounted posture, unknown model, out-of-range lights, bad hex) -> rejected fail-closed!
        clock.ms += 200;
        var badUnmounted = new StudyWorldPresence.Pose("street", 6, 0, 2, 0, "LYRA", 6.0, null,
                new StudyWorldPresence.VehiclePose("lotus", "#112233", 1));
        assertThat(svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 3, badUnmounted, null))).isNull();
        var badModel = new StudyWorldPresence.Pose("street", 6, 0, 2, 0, "LYRA", 6.0, "mounted",
                new StudyWorldPresence.VehiclePose("spaceship", "#112233", 1));
        assertThat(svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 4, badModel, null))).isNull();
        var badLights = new StudyWorldPresence.Pose("street", 6, 0, 2, 0, "LYRA", 6.0, "mounted",
                new StudyWorldPresence.VehiclePose("lotus", "#112233", 16));
        assertThat(svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 5, badLights, null))).isNull();

        // Free-text quickChat or unknown emote -> rejected fail-closed!
        assertThat(svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 6, observerPose, null, null, null, null, null, "free text spam"))).isNull();
        assertThat(svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 7, observerPose, "hack_emote", null, null, null, null, null))).isNull();

        // Malicious look string is sanitized away (never relayed)
        assertThat(svc.worldFrame(1, "s1", new StudyWorldPresence.Input(room, 8, observerPose, null, null, null, null, "https://evil.example/a.glb", null))).isNotNull();
        clock.ms += 200;
        var afterBadLook = svc.worldFrame(2, "s2", new StudyWorldPresence.Input(room, 3, observerPose, null));
        assertThat(afterBadLook.peers().get(0).look()).isNull();

        // Disconnect clears look, quickChat, and pose in O(1)
        svc.disconnectWorld("s1");
        clock.ms += 200;
        var afterDisconnect = svc.worldFrame(2, "s2", new StudyWorldPresence.Input(room, 4, observerPose, null));
        assertThat(afterDisconnect.peers()).isEmpty();
        assertThat(svc.activeWorldPlayerCount()).isEqualTo(1);
    }
}
