package com.englishcoach.kingofenglish;

import org.junit.jupiter.api.Test;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;
import static com.englishcoach.kingofenglish.KingRealtimeTest.*;

/** Real broker and authenticated peers; only the test service clock is advanced. No DB. */
class KingChampionshipRealtimeTest {
    static class Time extends Clock {
        final AtomicLong now=new AtomicLong(System.currentTimeMillis());
        public ZoneId getZone(){return ZoneOffset.UTC;}
        public Clock withZone(ZoneId zone){return this;}
        public Instant instant(){return Instant.ofEpochMilli(now.get());}
        public long millis(){return now.get();}
    }
    static class PacedPeer extends Peer {
        PacedPeer(int port,long user)throws Exception{super(port,user);}
        @Override Map<String,Object> command(String action,Map<String,Object> body)throws Exception{Thread.sleep(75);return super.command(action,body);}
    }
    @Test @SuppressWarnings("unchecked") void fourRoundBrokerLifecycleAllFlows()throws Exception{
        try(var app=context(0)){
            var game=app.getBean(KingService.class);var bank=app.getBean(KingBank.class);
            var time=new Time();var clock=KingService.class.getDeclaredField("clock");clock.setAccessible(true);clock.set(game,time);
            int port=app.getWebServer().getPort();
            for(String flow:List.of("SOLO","ECHO","QUICK_MATCH","PRIVATE_ROOM")){
                Thread.sleep(1100);
                boolean human=flow.equals("QUICK_MATCH")||flow.equals("PRIVATE_ROOM");
                try(var a=new PacedPeer(port,1);var b=new PacedPeer(port,2)){
                    var s=state(a.command(flow.equals("QUICK_MATCH")?"quick":flow.equals("PRIVATE_ROOM")?"create":"start",Map.of("mode","CHAMPIONSHIP","flow",flow)));
                    var code=(String)s.get("roomCode");
                    if(human){state(b.command(flow.equals("QUICK_MATCH")?"quick":"join",flow.equals("QUICK_MATCH")?Map.of("mode","CHAMPIONSHIP"):Map.of("roomCode",code)));if(flow.equals("PRIVATE_ROOM")){state(a.command("ready",Map.of("roomCode",code)));state(b.command("ready",Map.of("roomCode",code)));}s=state(a.command("ping",Map.of("roomCode",code)));}
                    var match=s.get("matchId");
                    s=state(a.command("answer",truth(bank,s)));assertEquals(1,((Number)s.get("score")).intValue());
                    time.now.addAndGet(KingConfig.REFLEX_MS);game.tick();s=state(a.command("ping",Map.of("roomCode",code)));assertEquals("INTERMISSION",s.get("status"));
                    try(var recovered=new PacedPeer(port,1)){
                        s=state(recovered.command("rejoin",Map.of("roomCode",code)));assertEquals(0,((Number)s.get("championshipRound")).intValue());
                        assertTrue(((Number)s.get("championshipTotal")).intValue()>0);
                        time.now.addAndGet(15_000);game.tick();s=state(recovered.command("ping",Map.of("roomCode",code)));assertEquals("EXPLAIN",s.get("mode"));
                        // Each actual mode processes authoritative deadlines, followed by real client ACKs.
                        for(int n=0;n<6;n++){time.now.addAndGet(KingConfig.EXPLAIN_MS);game.tick();time.now.addAndGet(KingConfig.RESOLUTION_MS);game.tick();}
                        s=state(recovered.command("ping",Map.of("roomCode",code)));assertEquals("INTERMISSION",s.get("status"));
                        time.now.addAndGet(15_000);game.tick();s=state(recovered.command("ping",Map.of("roomCode",code)));assertEquals("REORDER",s.get("mode"));
                        // Finish Solo by skips; competitive rounds by timeout.
                        while("PLAYING".equals(s.get("status"))){time.now.addAndGet(1000);if(flow.equals("SOLO"))s=state(recovered.command(Boolean.TRUE.equals(s.get("resolved"))?"next":"skip",scope(s)));else{time.now.addAndGet(KingConfig.REORDER_MS+KingConfig.RESOLUTION_MS);game.tick();s=state(recovered.command("ping",Map.of("roomCode",code)));}}
                        assertEquals("INTERMISSION",s.get("status"));time.now.addAndGet(15_000);game.tick();s=state(recovered.command("ping",Map.of("roomCode",code)));assertEquals("CONQUEST",s.get("mode"));
                        time.now.addAndGet(KingConfig.CONQUEST_MS);game.tick();s=state(recovered.command("ping",Map.of("roomCode",code)));assertEquals("FINISHED",s.get("status"));assertEquals(match,s.get("matchId"));
                        var rounds=(List<Map<String,Object>>)s.get("championshipRounds");assertEquals(4,rounds.size());int sum=0;for(var round:rounds){var scores=(Map<String,Map<String,Object>>)round.get("players");sum+=((Number)scores.get("1").get("normalized")).intValue();}assertEquals(sum,((Number)s.get("championshipTotal")).intValue());assertTrue(sum<=400);
                        if(human){var peer=state(b.command("ping",Map.of("roomCode",code)));assertEquals(s.get("championshipRounds"),peer.get("championshipRounds"));assertEquals(s.get("winnerId"),peer.get("winnerId"));state(b.command("leave",Map.of("roomCode",code)));}
                        state(recovered.command("leave",Map.of("roomCode",code)));
                    }
                    System.out.println("KING_CHAMPIONSHIP_BROKER "+flow+" four_modes=PASS stable_match=PASS totals=PASS recovery=PASS synthetic_auth=true advanced_test_clock=true");
                }
            }
        }
    }
}
