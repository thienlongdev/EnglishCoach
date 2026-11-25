package com.englishcoach.kingofenglish;
import org.junit.jupiter.api.Test;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import static com.englishcoach.kingofenglish.KingRealtimeTest.*;
import static org.junit.jupiter.api.Assertions.*;

/** Real independent clients and canonical local lexicon; synthetic auth, no application DB. */
class KingPhase3RealtimeTest {
    @SuppressWarnings("unchecked") Map<String,Object> view(Map<String,Object> s,String mode){return (Map<String,Object>)s.get(mode.equals("EXPLAIN")?"explain":"conquest");}
    Map<String,Object> body(Map<String,Object> s,String answer,List<Integer> path){
        var b=new HashMap<>(scope(s));b.put("answer",answer);if(path!=null)b.put("order",path);b.put("score",9999);b.put("owners",List.of(1,1,1));return b;
    }
    int rest(int port,int user,String path)throws Exception{
        return HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create("http://localhost:"+port+path)).timeout(Duration.ofSeconds(10))
            .header("Authorization","Bearer king-fixture-"+user).GET().build(),HttpResponse.BodyHandlers.discarding()).statusCode();
    }
    @Test void eightNewFlowsRealClientsSecrecyConcurrentOrderingRecoveryResults()throws Exception{
        try(var app=context(0)){
            int port=app.getWebServer().getPort();var explain=app.getBean(KingExplainBank.class);var boards=app.getBean(KingConquestBank.class);
            assertFalse(app.containsBean("dataSource"));
            for(String mode:List.of("EXPLAIN","CONQUEST"))for(String flow:List.of("SOLO","ECHO","QUICK_MATCH","PRIVATE_ROOM")){
                boolean human=flow.equals("QUICK_MATCH")||flow.equals("PRIVATE_ROOM");
                try(var a=new Peer(port,1);var b=new Peer(port,2);var outsider=new Peer(port,3)){
                    var s=state(a.command(flow.equals("QUICK_MATCH")?"quick":flow.equals("PRIVATE_ROOM")?"create":"start",Map.of("mode",mode,"flow",flow)));
                    String code=(String)s.get("roomCode");
                    if(human){
                        state(b.command(flow.equals("QUICK_MATCH")?"quick":"join",flow.equals("QUICK_MATCH")?Map.of("mode",mode):Map.of("roomCode",code)));
                        state(a.command("ready",Map.of("roomCode",code)));state(b.command("ready",Map.of("roomCode",code)));
                    }
                    s=state(a.command("ping",Map.of("roomCode",code)));assertEquals("PLAYING",s.get("status"));
                    var shared=s;
                    if(mode.equals("EXPLAIN")){
                        assertFalse(new ObjectMapper().writeValueAsString(s).contains("acceptedAliases"));
                        if(human){
                            var guess=state(b.command("ping",Map.of("roomCode",code)));assertFalse(view(guess,mode).containsKey("target"));
                            String target=(String)view(s,mode).get("target");assertNotNull(target);
                            assertEquals("NOT_DESCRIBER",b.command("clue",body(guess,"my clue",null)).get("code"));
                            assertEquals("TARGET_LEAKAGE",a.command("clue",body(s,target,null)).get("code"));
                            s=state(a.command("clue",body(s,"<b>Think about its purpose.</b>",null)));
                            guess=state(b.command("ping",Map.of("roomCode",code)));assertFalse(view(guess,mode).containsKey("target"));
                            for(var event:new ArrayList<>(b.events))if(event.get("state") instanceof Map<?,?> state&&state.get("explain") instanceof Map<?,?> e)assertFalse(e.containsKey("target"));
                            assertEquals("NOT_A_MEMBER",outsider.command("clue",body(s,"foreign clue",null)).get("code"));
                            s=state(b.command("answer",body(guess,target,null)));assertEquals(4,((Number)s.get("score")).intValue());
                            assertEquals(2,((Number)state(a.command("ping",Map.of("roomCode",code))).get("score")).intValue());
                        }else{
                            // The server fixture reads its truth by ID, independently of private client projection.
                            var f=KingService.class.getDeclaredField("rooms");f.setAccessible(true);var room=(KingService.Room)((Map<?,?>)f.get(app.getBean(KingService.class))).get(code);
                            var target=explain.get(room.ids.get(room.round));assertFalse(view(s,mode).containsKey("target"));
                            s=state(a.command("answer",body(s,target.target(),null)));assertEquals(3,((Number)s.get("score")).intValue());
                        }
                    }else{
                        var board=boards.get((String)view(s,mode).get("boardId"));var one=board.echoCandidates().get(0);var two=board.echoCandidates().get(1);
                        assertEquals("NOT_A_MEMBER",outsider.command("move",body(s,one.word(),one.path())).get("code"));
                        if(human){
                            var peer=state(b.command("ping",Map.of("roomCode",code)));assertEquals(s.get("deadline"),peer.get("deadline"));assertEquals(view(s,mode).get("letters"),view(peer,mode).get("letters"));
                            var initial=s;
                            var first=CompletableFuture.supplyAsync(()->{try{return a.command("move",body(initial,one.word(),one.path()));}catch(Exception e){throw new CompletionException(e);}});
                            var second=CompletableFuture.supplyAsync(()->{try{return b.command("move",body(peer,two.word(),two.path()));}catch(Exception e){throw new CompletionException(e);}});
                            var ea=first.get(10,TimeUnit.SECONDS);var eb=second.get(10,TimeUnit.SECONDS);
                            // Two different words sent at once are two moves: neither is refused for the other.
                            assertEquals(Set.of("ACK"),new HashSet<>(List.of((String)ea.get("type"),(String)eb.get("type"))));
                            s=state(a.command("ping",Map.of("roomCode",code)));assertEquals(2,((List<?>)view(s,mode).get("usedWords")).size());
                        }else{s=state(a.command("move",body(s,one.word(),one.path())));}
                        assertTrue(((Number)s.get("score")).intValue()<9999);assertTrue(((Number)s.get("revision")).longValue()>((Number)shared.get("revision")).longValue());
                    }
                    assertEquals("NOT_A_MEMBER",outsider.command("rejoin",Map.of("roomCode",code)).get("code"));
                    a.close();Thread.sleep(100);
                    try(var recovered=new Peer(port,1)){
                        var fresh=state(recovered.command("rejoin",Map.of("roomCode",code)));assertEquals(s.get("matchId"),fresh.get("matchId"));
                        if(mode.equals("CONQUEST"))assertEquals(view(s,mode).get("owners"),view(fresh,mode).get("owners"));
                        var end=state(recovered.command("leave",Map.of("roomCode",code)));assertEquals("FINISHED",end.get("status"));
                        assertEquals(200,rest(port,1,"/api/v1/king-of-english/results/"+end.get("matchId")));
                        assertEquals(404,rest(port,3,"/api/v1/king-of-english/results/"+end.get("matchId")));
                        assertEquals("NOT_A_MEMBER",recovered.command(mode.equals("EXPLAIN")?"answer":"move",body(end,"cat",List.of(0,1,2))).get("code"));
                        if(human){
                            var finished=state(b.command("ping",Map.of("roomCode",code)));
                            assertEquals("NOT_PLAYING",b.command(mode.equals("EXPLAIN")?"answer":"move",body(finished,"cat",List.of(0,1,2))).get("code"));
                            b.command("leave",Map.of("roomCode",code));
                        }
                    }
                    System.out.println("KING_P3_REAL_CLIENTS "+mode+"/"+flow+" multiplayer="+(human?"YES":"N/A")+" isolation=PASS");
                }
            }
        }
    }
}
