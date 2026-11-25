package com.englishcoach.speaking.arena;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.MessageBuilder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class ArenaSecurityTest {
    @Test void tokensAreShortLivedRoomScopedMicrophoneOnly(){
        String secret="test-only-secret-that-is-at-least-thirty-two-bytes";
        var voice=new LiveKitArenaVoice(true,"wss://test.livekit.cloud","test-key",secret,new ObjectMapper());
        var claims=Jwts.parser().verifyWith(Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8))).build().parseSignedClaims(voice.token("room-one","opaque-identity",false)).getPayload();
        Map<?,?> grants=claims.get("video",Map.class);
        assertEquals("room-one",grants.get("room"));assertEquals(false,grants.get("canPublish"));assertEquals(false,grants.get("canPublishData"));
        assertEquals(java.util.List.of("microphone"),grants.get("canPublishSources"));assertFalse(grants.containsKey("roomAdmin"));assertFalse(grants.containsKey("roomCreate"));
        assertEquals(120_000,claims.getExpiration().getTime()-claims.getIssuedAt().getTime());
    }
    @Test void enabledConfigurationRejectsArbitraryEndpoints(){for(String url:java.util.List.of("https://test.livekit.cloud","wss://example.com","wss://test.livekit.cloud@evil.com","wss://test.livekit.cloud/path"))assertThrows(IllegalStateException.class,()->new LiveKitArenaVoice(true,url,"key","a".repeat(40),new ObjectMapper()));assertFalse(new LiveKitArenaVoice(false,"","","",new ObjectMapper()).available());}
    void reject(StompCommand command,String destination,int bytes){var h=StompHeaderAccessor.create(command);h.setDestination(destination);h.setUser(()->"user");assertThrows(IllegalArgumentException.class,()->ArenaChannelGuard.validate(MessageBuilder.createMessage(new byte[bytes],h.getMessageHeaders())));}
    @Test void clientsCannotSpoofBrokerEventsOrReadOtherQueues(){reject(StompCommand.SEND,"/user/queue/speaking-arena",5);reject(StompCommand.SEND,"/topic/speaking-arena",5);reject(StompCommand.SUBSCRIBE,"/user/other/queue/speaking-arena",5);reject(StompCommand.SEND,"/app/speaking-arena/hack",5);reject(StompCommand.SEND,"/app/speaking-arena/move",1537);}

    @Test void liveKitVoiceDoesNotHoldSingletonMonitorAcrossHttpAndDistinguishes200Vs404() throws Exception {
        String secret = "test-only-secret-that-is-at-least-thirty-two-bytes";
        var inHttp = new java.util.concurrent.CountDownLatch(1);
        var releaseHttp = new java.util.concurrent.CountDownLatch(1);
        var httpStatus = new java.util.concurrent.atomic.AtomicInteger(200);
        var heldMonitorInsideHttp = new java.util.concurrent.atomic.AtomicBoolean(false);
        var voiceRef = new java.util.concurrent.atomic.AtomicReference<LiveKitArenaVoice>();

        var http = org.mockito.Mockito.mock(java.net.http.HttpClient.class);
        @SuppressWarnings("unchecked")
        var resp = (java.net.http.HttpResponse<Object>) org.mockito.Mockito.mock(java.net.http.HttpResponse.class);
        org.mockito.Mockito.when(resp.statusCode()).thenAnswer(inv -> httpStatus.get());
        org.mockito.Mockito.when(http.send(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any())).thenAnswer(inv -> {
            heldMonitorInsideHttp.set(Thread.holdsLock(voiceRef.get()));
            inHttp.countDown();
            assertTrue(releaseHttp.await(3, java.util.concurrent.TimeUnit.SECONDS));
            return resp;
        });

        var voice = new LiveKitArenaVoice(true, "wss://test.livekit.cloud", "test-key", secret, new ObjectMapper(), 4, http);
        voiceRef.set(voice);
        assertFalse(voice.token("room-b", "id-b", true).isBlank());

        var removeFuture = java.util.concurrent.CompletableFuture.supplyAsync(() -> voice.remove("room-b", "id-b"));
        assertTrue(inHttp.await(3, java.util.concurrent.TimeUnit.SECONDS));

        // While Room B's remove() is blocked on HTTP I/O, Room A's token() MUST complete immediately without blocking!
        var tokenFuture = java.util.concurrent.CompletableFuture.supplyAsync(() -> voice.token("room-a", "id-a", true));
        assertFalse(tokenFuture.get(1, java.util.concurrent.TimeUnit.SECONDS).isBlank());

        releaseHttp.countDown();
        assertTrue(removeFuture.get(3, java.util.concurrent.TimeUnit.SECONDS), "HTTP 200 RemoveParticipant returns true");
        assertFalse(heldMonitorInsideHttp.get(), "LiveKitArenaVoice must NEVER hold singleton monitor across http.send()");
        assertEquals(1, voice.admittedCount());
        assertEquals(1, voice.admittedRoomCount(), "empty room-b set must be pruned after remove()");

        // HTTP 404 RemoveParticipant returns false and prunes empty room-a
        httpStatus.set(404);
        assertFalse(voice.remove("room-a", "id-a"), "HTTP 404 RemoveParticipant returns false");
        assertEquals(0, voice.admittedCount());
        assertEquals(0, voice.admittedRoomCount());
    }
}
