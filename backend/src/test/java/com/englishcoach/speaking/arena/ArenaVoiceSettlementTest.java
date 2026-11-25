package com.englishcoach.speaking.arena;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class ArenaVoiceSettlementTest {
    @TempDir Path dir;
    long now=1_800_000_000_000L;
    final Set<String> removed=new TreeSet<>();
    int asked,recovered;
    Map<String,Long> list=Map.of();boolean failing,removeFails;
    final ArenaVoice voice=new ArenaVoice(){
        public boolean available(){return true;}
        public String url(){return "wss://example.livekit.cloud";}
        public String token(String r,String i,boolean p){return "t";}
        public void create(String r,int n){}
        public boolean remove(String r,String i){if(removeFails)throw ArenaService.fail(503,"VOICE_UNAVAILABLE");removed.add(i);return true;}
        public void close(String r){}
        @Override public Map<String,Long> participants(String r){asked++;if(failing)throw new IllegalStateException("provider down");return list;}
    };
    ArenaUsage usage(long limit){return new ArenaUsage(dir.toString(),limit,8,new ObjectMapper());}
    @Test void nothingIsAskedWhileNobodyIsConnected(){
        try(var u=usage(100);var s=new ArenaVoiceSettlement(voice,u,()->now,()->recovered++)){
            s.sweep();assertEquals(0,asked);assertEquals(1,recovered,"rooms from before a restart do not wait for the next visitor");
        }
    }
    @Test void aSilentClientIsStillSettled(){
        try(var u=usage(100);var s=new ArenaVoiceSettlement(voice,u,()->now,()->{})){
            u.open("room","a",now);list=Map.of("a",now);now+=30_000;s.sweep();now+=30_000;list=Map.of();s.sweep();
            assertEquals(1L,u.status(now).get("usedMinutes"));assertEquals(2,asked);
            s.sweep();assertEquals(2,asked,"settled: not asked again");
        }
    }
    @Test void aProviderFailureKeepsTheLeaseAndCostsNothingExtra(){
        try(var u=usage(100);var s=new ArenaVoiceSettlement(voice,u,()->now,()->{})){
            u.open("room","a",now);failing=true;now+=30_000;s.sweep();
            assertEquals(5L,u.status(now).get("openMinutes"));assertEquals(0L,u.status(now).get("usedMinutes"));
        }
    }
    @Test void quotaRunningOutEndsTheConnectionItCannotCover(){
        try(var u=usage(6);var s=new ArenaVoiceSettlement(voice,u,()->now,()->{})){
            u.open("room","a",now);list=Map.of("a",now);now+=4*60_000;
            removeFails=true;s.sweep();
            assertTrue(removed.isEmpty());assertEquals(1,((Number)u.status(now).get("openConnections")).intValue(),"could not be ended: still connected, still charged");
            removeFails=false;now+=30_000;s.sweep();
            assertEquals(Set.of("a"),removed);assertEquals(0,((Number)u.status(now).get("openConnections")).intValue());assertEquals(5L,u.status(now).get("usedMinutes"));
        }
    }

    /** The answer a real livekit-server 1.9.0 gave a real browser connection, word for word in its shape. */
    @org.junit.jupiter.api.Test void readsWhatARealServerAnswers() throws Exception {
        var json = new com.fasterxml.jackson.databind.ObjectMapper();
        var answer = json.readTree("""
            {"participants":[
              {"sid":"PA_1","identity":"canary-a","state":"ACTIVE","joined_at":"1794025545"},
              {"sid":"PA_2","identity":"gone","state":"DISCONNECTED","joined_at":"1794025000"},
              {"sid":"PA_3","identity":"joining","state":"JOINING","joined_at":"0"},
              {"sid":"PA_4","identity":"","state":"ACTIVE"},
              {"sid":"PA_5","identity":"numeric","state":3,"joinedAt":1794025000},
              {"sid":"PA_6","identity":"camel","state":2,"joinedAt":1794025001}
            ]}""");
        var present = LiveKitArenaVoice.present(answer);
        org.junit.jupiter.api.Assertions.assertEquals(java.util.Map.of("canary-a", 1794025545000L, "joining", 0L, "camel", 1794025001000L), present);
        org.junit.jupiter.api.Assertions.assertEquals(java.util.Map.of(), LiveKitArenaVoice.present(json.readTree("{}")), "a room that does not exist answers 200 and nobody");
    }

    @Test void settlementEvictsDepartedAndExpiredAdmissionsWithoutEvictingFreshTokens() throws Exception {
        String secret = "test-only-secret-that-is-at-least-thirty-two-bytes";
        var participantsJson = new java.util.concurrent.atomic.AtomicReference<>("{\"participants\":[{\"identity\":\"a\",\"state\":\"ACTIVE\",\"joined_at\":\"" + (now / 1000) + "\"}]}");
        var http = org.mockito.Mockito.mock(java.net.http.HttpClient.class);
        @SuppressWarnings("unchecked")
        var strResp = (java.net.http.HttpResponse<Object>) org.mockito.Mockito.mock(java.net.http.HttpResponse.class);
        org.mockito.Mockito.when(strResp.statusCode()).thenReturn(200);
        org.mockito.Mockito.when(strResp.body()).thenAnswer(inv -> participantsJson.get());
        org.mockito.Mockito.when(http.send(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any())).thenReturn(strResp);

        var liveVoice = new LiveKitArenaVoice(true, "wss://test.livekit.cloud", "key", secret, new ObjectMapper(), 2, http);
        try (var u = usage(100); var s = new ArenaVoiceSettlement(liveVoice, u, () -> now, () -> {})) {
            u.open("room-1", "a", now);
            liveVoice.token("room-1", "a", true);
            u.open("room-1", "b", now);
            liveVoice.token("room-1", "b", true);
            assertEquals(2, liveVoice.admittedCount());
            assertEquals("VOICE_PROVIDER_LIMIT", assertThrows(org.springframework.web.server.ResponseStatusException.class,
                    () -> liveVoice.token("room-1", "c", true)).getReason());

            // Sweep 1 at +30s: "a" is connected, "b" is still fresh (<150s) -> both remain admitted
            now += 30_000;
            s.sweep();
            assertEquals(2, liveVoice.admittedCount());

            // Sweep 2 at +60s: "a" departed cleanly -> "a" settled (1 min) and evicted from admissions, freeing slot for "c"
            participantsJson.set("{\"participants\":[]}");
            now += 30_000;
            s.sweep();
            assertEquals(1, liveVoice.admittedCount(), "departed participant must be evicted from admissions");
            assertEquals(1L, u.status(now).get("usedMinutes"));

            // Sweep 3 at +160s: unused "b" expires (>=150s) -> dropped at 0 min and room pruned from admissions
            now += 100_000;
            s.sweep();
            assertEquals(0, liveVoice.admittedCount(), "expired unused token must be evicted from admissions");
            assertEquals(0, liveVoice.admittedRoomCount(), "empty room set must be pruned");
            assertEquals(1L, u.status(now).get("usedMinutes"));
            assertFalse(liveVoice.token("room-1", "c", true).isBlank());
        }
    }
}
