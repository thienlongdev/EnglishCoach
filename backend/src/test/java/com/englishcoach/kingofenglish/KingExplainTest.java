package com.englishcoach.kingofenglish;
import org.junit.jupiter.api.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
class KingExplainTest {
    KingExplainBank bank=new KingExplainBank();KingServiceTest.Time time;KingService game;
    @BeforeEach void setup(){time=new KingServiceTest.Time();game=new KingService(new KingBank(),mock(SimpMessagingTemplate.class),time,true);}
    @AfterEach void close(){game.close();}
    Map<String,Object> act(long user,String action,Map<String,Object> s,String flow,String answer){
        return game.act(user,"p"+user,"s"+user,new KingService.Command(action,s==null?null:(String)s.get("roomCode"),"EXPLAIN",flow,6,0,"MEDIUM",
            s==null?null:(String)s.get("matchId"),s==null?null:(Integer)s.get("round"),s==null?null:(Long)s.get("inputRevision"),UUID.randomUUID().toString(),answer,null));
    }
    @SuppressWarnings("unchecked") Map<String,Object> explain(Map<String,Object> s){return (Map<String,Object>)s.get("explain");}
    Map<String,Object> pair(String flow){
        var s=act(1,flow.equals("QUICK_MATCH")?"quick":"create",null,flow,null);
        act(2,flow.equals("QUICK_MATCH")?"quick":"join",flow.equals("QUICK_MATCH")?null:s,flow,null);
        act(1,"ready",s,flow,null);return act(2,"ready",s,flow,null);
    }
    void rejection(String code,org.junit.jupiter.api.function.Executable e){assertEquals(code,assertThrows(KingService.Rejection.class,e).code);}
    @Test void contentAndLeakageNegatives()throws Exception{
        assertEquals(60,bank.all().size());assertTrue(KingExplainBank.validate(new ArrayList<>(bank.all())).isEmpty());
        var i=bank.get("king-e-1");
        for(String text:List.of("umbrella","UMBRELLA!","u m b r e l l a","u-m-b-r-e-l-l-a","u.m.b.r.e.l.l.a"))assertTrue(KingExplainBank.leaks(i,text),text);
        assertFalse(KingExplainBank.leaks(i,"You keep dry in the rain."));assertFalse(KingExplainBank.leaks(i,"umbrellas"));
        assertTrue(KingExplainBank.leaks(bank.get("king-e-3"),"bike"));assertTrue(KingExplainBank.correct(bank.get("king-e-3"),"BIKE!"));
        var explicit=new KingExplainBank.Item(i.id(),i.target(),i.acceptedAliases(),i.progressiveClues(),List.of("umbrellas"),i.meaning(),i.category(),i.difficulty(),i.cefr(),i.sourceKind(),i.sourceRef(),i.contentVersion(),i.fingerprint(),i.reviewStatus(),null);
        assertTrue(KingExplainBank.leaks(explicit,"umbrellas"));assertFalse(KingExplainBank.leaks(bank.get("king-e-60"),"Education helps everyone."));
        var mapper=new ObjectMapper();
        for(var change:Map.of("target","","meaning","","sourceRef","","fingerprint","old","reviewStatus","ACTIVE","humanReview","invented").entrySet()){
            var tree=(com.fasterxml.jackson.databind.node.ObjectNode)mapper.valueToTree(i);tree.put(change.getKey(),change.getValue());
            assertFalse(KingExplainBank.validate(List.of(mapper.treeToValue(tree,KingExplainBank.Item.class))).isEmpty());
        }
        assertFalse(KingExplainBank.validate(List.of(i,i)).isEmpty());
        for(String field:List.of("progressiveClues","acceptedAliases","forbiddenForms")){
            var tree=(com.fasterxml.jackson.databind.node.ObjectNode)mapper.valueToTree(i);tree.putArray(field).add("").add("");
            assertFalse(KingExplainBank.validate(List.of(mapper.treeToValue(tree,KingExplainBank.Item.class))).isEmpty());
        }
    }
    @Test void soloClueScheduleScoresTimeoutRestartNoRepeat(){
        var s=act(1,"start",null,"SOLO",null);
        assertEquals(1,((List<?>)explain(s).get("clues")).size());assertFalse(explain(s).containsKey("target"));
        var selection=bank.sequence(0,6,123,false);assertEquals(6,new HashSet<>(selection).size());
        // Infer target from authored clue for the test, never from the client payload.
        String clue=(String)((List<?>)explain(s).get("clues")).get(0);
        var item=bank.all().stream().filter(i->i.progressiveClues().get(0).equals(clue)).findFirst().orElseThrow();
        // A first clue can intentionally be broad: select the actual room ID through server test state.
        item=target(s);
        s=act(1,"answer",s,"SOLO",item.target());assertEquals(3,s.get("score"));assertTrue((Boolean)s.get("resolved"));
        time.ms+=KingConfig.RESOLUTION_MS;game.tick();s=act(1,"ping",s,"SOLO",null);
        time.ms+=40_000;game.tick();s=act(1,"ping",s,"SOLO",null);assertEquals(3,((List<?>)explain(s).get("clues")).size());
        s=act(1,"answer",s,"SOLO",target(s).target());assertEquals(4,s.get("score"));
        for(int n=0;n<5;n++){time.ms+=KingConfig.RESOLUTION_MS;game.tick();time.ms+=KingConfig.EXPLAIN_MS;game.tick();}
        time.ms+=KingConfig.RESOLUTION_MS;game.tick();s=act(1,"ping",s,"SOLO",null);assertEquals("FINISHED",s.get("status"));
        var old=s;s=act(1,"rematch",s,"SOLO",null);assertEquals(0,s.get("score"));assertNotEquals(old.get("matchId"),s.get("matchId"));
    }
    KingExplainBank.Item target(Map<String,Object> s){
        try{var f=KingService.class.getDeclaredField("rooms");f.setAccessible(true);var rooms=(Map<?,?>)f.get(game);var r=(KingService.Room)rooms.get(s.get("roomCode"));return bank.get(r.ids.get(r.round));}
        catch(Exception e){throw new AssertionError(e);}
    }
    @Test void equalHumanRolesSecrecyClueGuessesScoringReconnectAndRematch()throws Exception{
        for(String flow:List.of("QUICK_MATCH","PRIVATE_ROOM")){
            var s=pair(flow);int[] described={0,0};
            for(int round=0;round<6;round++){
                long author=round%2+1,guesser=author==1?2:1;described[(int)author-1]++;
                var a=act(author,"ping",s,flow,null);var g=act(guesser,"ping",s,flow,null);
                assertEquals("DESCRIBER",explain(a).get("role"));assertEquals("GUESSER",explain(g).get("role"));
                String target=(String)explain(a).get("target");
                String json=new ObjectMapper().writeValueAsString(g);assertFalse(json.contains("\"target\""));assertFalse(json.contains("acceptedAliases"));assertFalse(json.contains("forbiddenForms"));
                var authorView=a;var guessView=g;
                rejection("NOT_DESCRIBER",()->act(guesser,"clue",guessView,flow,"test"));rejection("NOT_GUESSER",()->act(author,"answer",authorView,flow,target));
                rejection("TARGET_LEAKAGE",()->act(author,"clue",authorView,flow,target));rejection("INVALID_CLUE",()->act(author,"clue",authorView,flow,"x".repeat(401)));
                time.ms+=1000;a=act(author,"clue",a,flow,"<b>Think about its purpose.</b>");
                g=act(guesser,"ping",g,flow,null);assertEquals(List.of("<b>Think about its purpose.</b>"),explain(g).get("clues"));
                // Fake elapsed times test all four speed tiers, while both role score formulas stay canonical.
                int guesserBefore=((Number)g.get("score")).intValue(),authorBefore=((Number)a.get("score")).intValue();
                time.ms+=round<4?round*15_000L+1000:1000;
                g=act(guesser,"ping",g,flow,null);s=act(guesser,"answer",g,flow,target);
                assertEquals(guesserBefore+(round<4?4-round:4),s.get("score"));
                assertEquals(authorBefore+(round==2||round==3?1:2),act(author,"ping",s,flow,null).get("score"));
                assertTrue((Boolean)s.get("resolved"));
                var old=g;time.ms+=KingConfig.RESOLUTION_MS;game.tick();
                if(round<5)rejection("STALE_ROUND",()->act(guesser,"answer",old,flow,target));
                s=act(1,"ping",s,flow,null);
            }
            assertArrayEquals(new int[]{3,3},described);assertEquals("FINISHED",s.get("status"));
            String endedMatch=(String)s.get("matchId");rejection("RESULT_NOT_FOUND",()->game.result(3,endedMatch));
            var end=s;rejection("NOT_PLAYING",()->act(1,"clue",end,flow,"anything"));
            act(1,"rematch",s,flow,null);s=act(2,"rematch",s,flow,null);assertEquals(0,s.get("score"));
            game.disconnect("s2");time.ms+=500;s=act(2,"rejoin",s,flow,null);assertEquals("GUESSER",explain(s).get("role"));
            act(1,"leave",s,flow,null);act(2,"leave",s,flow,null);
        }
    }
    @Test void guessesAndCluesHaveFiniteCapsAndEchoPolicyHasNoInput(){
        assertEquals(KingExplainEngine.botDelay("KING",42,1,2),KingExplainEngine.botDelay("KING",42,1,2));
        assertTrue(KingExplainEngine.botDelay("KING",42,1,2)<KingExplainEngine.botDelay("EASY",42,1,2));
        assertTrue(KingExplainEngine.botDelay("HARD",42,1,4)>KingExplainEngine.botDelay("HARD",42,1,1));
        var s=pair("PRIVATE_ROOM");var a=act(1,"ping",s,"PRIVATE_ROOM",null);
        for(int n=0;n<8;n++){time.ms+=1000;a=act(1,"clue",a,"PRIVATE_ROOM","A useful thing "+n);}
        var latest=a;time.ms+=1000;rejection("CLUE_LIMIT",()->act(1,"clue",latest,"PRIVATE_ROOM","another"));
        var g=act(2,"ping",s,"PRIVATE_ROOM",null);for(int n=0;n<12;n++){time.ms+=1000;g=act(2,"answer",g,"PRIVATE_ROOM","not the answer");}
        var last=g;time.ms+=1000;rejection("GUESS_LIMIT",()->act(2,"answer",last,"PRIVATE_ROOM","again"));
        act(1,"leave",s,"PRIVATE_ROOM",null);act(2,"leave",s,"PRIVATE_ROOM",null);
        s=act(1,"start",null,"ECHO",null);time.ms+=50_000;game.tick();s=act(1,"ping",s,"ECHO",null);assertTrue((Boolean)s.get("resolved"));
        assertEquals(3,((List<?>)explain(s).get("clues")).size());
    }
}
