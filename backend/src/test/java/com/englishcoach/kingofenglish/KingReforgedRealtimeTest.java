package com.englishcoach.kingofenglish;

import org.junit.jupiter.api.Test;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;
import static com.englishcoach.kingofenglish.KingRealtimeTest.*;

/** Bounded repetition against the real authenticated broker; synthetic users, no DB. */
class KingReforgedRealtimeTest {
    private Map<String,Object> invoke(Peer p,String action,Map<String,Object> body){
        try{return state(p.command(action,body));}catch(Exception e){throw new CompletionException(e);}
    }
    @Test void twentyQuickPairsAndTwentyPrivateJoinsWithReplayAndRecovery()throws Exception{
        var enrollment=new ArrayList<Double>();var joins=new ArrayList<Double>();var pairs=new ArrayList<Double>();
        var recovery=new ArrayList<Double>();
        try(var app=context(0);var workers=Executors.newFixedThreadPool(2)){
            int port=app.getWebServer().getPort();var bank=app.getBean(KingBank.class);
            try(var a=new Peer(port,1);var b=new Peer(port,2);var outsider=new Peer(port,3)){
                assertEquals("SYNC",a.command("sync",Map.of()).get("type"));
                for(String flow:List.of("QUICK_MATCH","PRIVATE_ROOM"))for(int trial=0;trial<20;trial++){
                    Thread.sleep(1100); // Respect the real per-player command rate limit.
                    String action=flow.equals("QUICK_MATCH")?"quick":"create";
                    Map<String,Object> s,t;
                    long start=System.nanoTime();
                    if(flow.equals("QUICK_MATCH")&&trial%3==0){
                        var first=CompletableFuture.supplyAsync(()->invoke(a,"quick",Map.of("mode","REFLEX")),workers);
                        var second=CompletableFuture.supplyAsync(()->invoke(b,"quick",Map.of("mode","REFLEX")),workers);
                        s=first.get(10,TimeUnit.SECONDS);t=second.get(10,TimeUnit.SECONDS);
                    }else{
                        Peer first=trial%2==0?a:b,second=trial%2==0?b:a;
                        s=state(first.command(action,Map.of("mode","REFLEX")));enrollment.add(ms(start));
                        if(flow.equals("PRIVATE_ROOM")){
                            assertEquals("NOT_A_MEMBER",second.command("rejoin",Map.of("roomCode",s.get("roomCode"))).get("code"));
                            assertEquals("ROOM_NOT_FOUND",second.command("join",Map.of("roomCode","FFFFFFFF")).get("code"));
                        }
                        long joinAt=System.nanoTime();t=state(second.command(flow.equals("QUICK_MATCH")?"quick":"join",flow.equals("QUICK_MATCH")?Map.of("mode","REFLEX"):Map.of("roomCode",s.get("roomCode"))));joins.add(ms(joinAt));
                    }
                    assertEquals(s.get("roomCode"),t.get("roomCode"));String code=(String)s.get("roomCode");
                    if(flow.equals("PRIVATE_ROOM")){
                        var duplicate=state(b.command("join",Map.of("roomCode",code)));assertEquals(2,((List<?>)duplicate.get("players")).size());
                        state(a.command("ready",Map.of("roomCode",code)));state(b.command("ready",Map.of("roomCode",code)));
                        assertEquals("ROOM_FULL",outsider.command("join",Map.of("roomCode",code)).get("code"));
                    }
                    s=state(a.command("ping",Map.of("roomCode",code)));t=state(b.command("ping",Map.of("roomCode",code)));
                    assertEquals("PLAYING",s.get("status"));assertEquals(s.get("matchId"),t.get("matchId"));pairs.add(ms(start));
                    var answer=truth(bank,s);answer.put("messageId","trial-"+flow.replace('_','-')+"-"+trial);
                    var accepted=state(a.command("answer",answer));assertEquals(1,((Number)accepted.get("score")).intValue());
                    assertEquals(accepted.get("score"),state(a.command("answer",answer)).get("score"));
                    assertEquals(1,((Number)state(b.command("answer",truth(bank,t))).get("score")).intValue());
                    long restoreAt=System.nanoTime();
                    try(var returned=new Peer(port,1)){
                        var restored=state(returned.command("rejoin",Map.of("roomCode",code)));recovery.add(ms(restoreAt));
                        assertEquals(1,((Number)restored.get("score")).intValue());assertEquals(s.get("matchId"),restored.get("matchId"));
                        var ended=state(returned.command("leave",Map.of("roomCode",code)));assertEquals("FINISHED",ended.get("status"));
                    }
                    state(b.command("leave",Map.of("roomCode",code)));
                }
            }
        }
        System.out.printf(Locale.ROOT,"KING_REFORGED_BROKER trials=40 failures=0 enrollment_p50=%.3f enrollment_p95=%.3f join_p50=%.3f join_p95=%.3f pair_p50=%.3f pair_p95=%.3f recovery_p50=%.3f recovery_p95=%.3f units=ms local_synthetic_auth=true%n",
            percentile(enrollment,.5),percentile(enrollment,.95),percentile(joins,.5),percentile(joins,.95),percentile(pairs,.5),percentile(pairs,.95),percentile(recovery,.5),percentile(recovery,.95));
    }
    static double ms(long start){return (System.nanoTime()-start)/1_000_000.0;}
    static double percentile(List<Double> values,double percentile){var sorted=values.stream().sorted().toList();return sorted.get(Math.max(0,(int)Math.ceil(sorted.size()*percentile)-1));}
}
