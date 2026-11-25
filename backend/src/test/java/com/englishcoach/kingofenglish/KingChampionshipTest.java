package com.englishcoach.kingofenglish;

import org.junit.jupiter.api.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** Regression coverage for the single-room four-round championship lifecycle. */
class KingChampionshipTest {
    KingServiceTest.Time time;
    KingService game;

    @BeforeEach void setup(){
        time=new KingServiceTest.Time();
        game=new KingService(new KingBank(),new KingExplainBank(),new KingConquestBank(),
            KingConquestTest.localLexicon(),mock(SimpMessagingTemplate.class),time,true);
    }
    @AfterEach void close(){game.close();}

    KingService.Command cmd(String action,Map<String,Object> s,String mode){
        return new KingService.Command(action,s==null?null:(String)s.get("roomCode"),mode,"SOLO",10,0,"MEDIUM",
            s==null?null:(String)s.get("matchId"),s==null?null:(Integer)s.get("round"),
            s==null?null:(Long)s.get("inputRevision"),UUID.randomUUID().toString(),null,null);
    }
    Map<String,Object> act(String action,Map<String,Object> s,String mode){return game.act(1,"p1","s1",cmd(action,s,mode));}

    @SuppressWarnings("unchecked") KingService.Room room(Map<String,Object> state)throws Exception{
        var field=KingService.class.getDeclaredField("rooms");field.setAccessible(true);
        return ((Map<String,KingService.Room>)field.get(game)).get(state.get("roomCode"));
    }
    Map<String,Object> play(long user,String action,Map<String,Object> state,String flow,String answer,List<Integer> order){
        time.ms+=200;
        return game.act(user,"p"+user,"s"+user,new KingService.Command(action,state==null?null:(String)state.get("roomCode"),"CHAMPIONSHIP",flow,10,0,"MEDIUM",
            state==null?null:(String)state.get("matchId"),state==null?null:(Integer)state.get("round"),state==null?null:(Long)state.get("inputRevision"),UUID.randomUUID().toString(),answer,order));
    }
    @ParameterizedTest @ValueSource(strings={"SOLO","ECHO","QUICK_MATCH","PRIVATE_ROOM"})
    @SuppressWarnings("unchecked") void acceptedActionsAllFourRoundsAndReplayStayInOneMatch(String flow)throws Exception{
        boolean human=flow.equals("QUICK_MATCH")||flow.equals("PRIVATE_ROOM");
        var state=play(1,flow.equals("QUICK_MATCH")?"quick":flow.equals("PRIVATE_ROOM")?"create":"start",null,flow,null,null);
        if(human){play(2,flow.equals("QUICK_MATCH")?"quick":"join",flow.equals("QUICK_MATCH")?null:state,flow,null,null);if(flow.equals("PRIVATE_ROOM")){play(1,"ready",state,flow,null,null);play(2,"ready",state,flow,null,null);}state=play(1,"ping",state,flow,null,null);}
        String match=(String)state.get("matchId"),code=(String)state.get("roomCode");
        var bank=new KingBank();var explain=new KingExplainBank();var conquest=new KingConquestBank();
        for(int mode=0;mode<4;mode++){
            assertEquals(List.of("REFLEX","EXPLAIN","REORDER","CONQUEST").get(mode),state.get("mode"));assertEquals(0,state.get("round"));
            var previous=state;
            if(mode==0){
                int count=(Integer)state.get("count");for(int n=0;n<count;n++){
                    state=play(1,"ping",state,flow,null,null);var truth=KingRealtimeTest.truth(bank,state);
                    state=play(1,"answer",state,flow,(String)truth.get("answer"),(List<Integer>)truth.get("order"));
                    if(human){var peer=play(2,"ping",state,flow,null,null);var peerTruth=KingRealtimeTest.truth(bank,peer);play(2,"answer",peer,flow,(String)peerTruth.get("answer"),(List<Integer>)peerTruth.get("order"));}
                }
                state=play(1,"ping",state,flow,null,null);
                while(state.get("status").equals("PLAYING")){time.ms+=5000;game.tick();state=play(1,"ping",state,flow,null,null);}
            }else if(mode==1){
                for(int n=0;n<6;n++){
                    var r=room(state);long guesser=human?n%2==0?2:1:1;
                    var own=play(guesser,"ping",state,flow,null,null);
                    state=play(guesser,"answer",own,flow,explain.get(r.ids.get(r.round)).target(),null);
                    time.ms+=KingConfig.RESOLUTION_MS;game.tick();state=play(1,"ping",state,flow,null,null);
                }
            }else if(mode==2){
                int count=(Integer)state.get("count");for(int n=0;n<count;n++){
                    state=play(1,"ping",state,flow,null,null);var truth=KingRealtimeTest.truth(bank,state);
                    state=play(1,"answer",state,flow,(String)truth.get("answer"),(List<Integer>)truth.get("order"));
                    if(flow.equals("SOLO"))state=play(1,"next",state,flow,null,null);
                    else{time.ms+=KingConfig.RESOLUTION_MS;game.tick();state=play(1,"ping",state,flow,null,null);}
                }
            }else{
                var r=room(state);var candidate=conquest.get(r.conquest.boardId).echoCandidates().getFirst();
                state=play(1,"move",state,flow,candidate.word(),candidate.path());
                time.ms+=KingConfig.CONQUEST_MS;game.tick();
            }
            state=play(1,"ping",state,flow,null,null);assertEquals(match,state.get("matchId"));assertEquals(code,state.get("roomCode"));
            if(mode<3){
                assertEquals("INTERMISSION",state.get("status"));
                var continueCommand=cmd("continue",state,"CHAMPIONSHIP");
                state=game.act(1,"p1","s1",continueCommand);
                if(human){assertEquals("INTERMISSION",state.get("status"));state=play(2,"continue",play(2,"ping",state,flow,null,null),flow,null,null);}
                var replay=game.act(1,"p1","s1",continueCommand);assertEquals(mode+1,replay.get("championshipRound"));
                var stale=previous;
                assertThrows(KingService.Rejection.class,()->play(1,"answer",stale,flow,"stale",null));
                game.disconnect("s1");var rejoined=game.act(1,"p1","replacement",cmd("rejoin",state,"CHAMPIONSHIP"));assertEquals(state.get("championshipRound"),rejoined.get("championshipRound"));
                state=game.act(1,"p1","s1",cmd("rejoin",state,"CHAMPIONSHIP"));game.disconnect("replacement");
            }
        }
        assertEquals("FINISHED",state.get("status"));
        var rounds=(List<Map<String,Object>>)state.get("championshipRounds");assertEquals(4,rounds.size());
        for(long user:room(state).players.keySet()){
            int sum=0;for(var round:rounds){var scores=(Map<String,Map<String,Object>>)round.get("players");var score=scores.get(Long.toString(user));int normalized=((Number)score.get("normalized")).intValue();assertTrue(normalized>=0&&normalized<=100);sum+=normalized;}
            assertEquals(sum,room(state).championshipTotals.get(user));assertTrue(sum<=400);
        }
        assertTrue((Integer)state.get("championshipTotal")>200);
        if(human){play(1,"rematch",state,flow,null,null);state=play(2,"rematch",state,flow,null,null);}else state=play(1,"rematch",state,flow,null,null);
        assertEquals("REFLEX",state.get("mode"));assertEquals(0,state.get("championshipRound"));assertEquals(0,state.get("championshipTotal"));assertEquals(0,((List<?>)state.get("championshipRounds")).size());assertNotEquals(match,state.get("matchId"));
    }

    @Test void fourRoundsKeepOneMatchAndBoundNormalizedTotals(){
        var state=act("start",null,"CHAMPIONSHIP");
        String match=(String)state.get("matchId");
        assertEquals("CHAMPIONSHIP",state.get("variant"));
        assertEquals("REFLEX",state.get("mode"));

        time.ms+=KingConfig.REFLEX_MS;game.tick();state=act("ping",state,"REFLEX");
        assertEquals("INTERMISSION",state.get("status"));state=act("continue",state,"REFLEX");
        assertEquals("EXPLAIN",state.get("mode"));

        for(int round=0;round<KingConfig.EXPLAIN_ROUNDS;round++){
            time.ms+=KingConfig.EXPLAIN_MS;game.tick();
            time.ms+=KingConfig.RESOLUTION_MS;game.tick();
        }
        state=act("ping",state,"EXPLAIN");assertEquals("INTERMISSION",state.get("status"));state=act("continue",state,"EXPLAIN");
        assertEquals("REORDER",state.get("mode"));
        for(int round=0;round<KingConfig.REORDER_ROUNDS;round++){
            time.ms+=KingConfig.REORDER_MS;game.tick();
            time.ms+=KingConfig.FINISH_TTL;game.tick();
            state=act("ping",state,"REORDER");
            if("INTERMISSION".equals(state.get("status")))break;
        }
        state=act("ping",state,"REORDER");assertEquals("INTERMISSION",state.get("status"));state=act("continue",state,"REORDER");
        assertEquals("CONQUEST",state.get("mode"));
        time.ms+=KingConfig.CONQUEST_MS;game.tick();state=act("ping",state,"CONQUEST");

        assertEquals("FINISHED",state.get("status"));
        assertEquals(match,state.get("matchId"));
        assertEquals(4,((List<?>)state.get("championshipRounds")).size());
        assertTrue(((Number)state.get("championshipTotal")).intValue()>=0);
        assertTrue(((Number)state.get("championshipTotal")).intValue()<=400);
        assertEquals("CHAMPIONSHIP_COMPLETE",state.get("reason"));
    }
    @Test void autoTransitionTieAndIntermissionForfeitAreDeterministic()throws Exception{
        var state=play(1,"quick",null,"QUICK_MATCH",null,null);
        play(2,"quick",null,"QUICK_MATCH",null,null);
        state=play(1,"ping",state,"QUICK_MATCH",null,null);
        var match=state.get("matchId");
        time.ms+=KingConfig.REFLEX_MS;game.tick();
        state=play(1,"ping",state,"QUICK_MATCH",null,null);
        assertEquals("INTERMISSION",state.get("status"));
        assertEquals(0,state.get("championshipTotal"));
        time.ms+=15_000;game.tick();state=play(1,"ping",state,"QUICK_MATCH",null,null);
        assertEquals("EXPLAIN",state.get("mode"));assertEquals(match,state.get("matchId"));
        for(int n=0;n<6;n++){time.ms+=KingConfig.EXPLAIN_MS;game.tick();time.ms+=KingConfig.RESOLUTION_MS;game.tick();}
        state=play(1,"ping",state,"QUICK_MATCH",null,null);
        assertEquals("INTERMISSION",state.get("status"));
        state=play(1,"leave",state,"QUICK_MATCH",null,null);
        assertEquals("FINISHED",state.get("status"));assertEquals(2L,state.get("winnerId"));
        assertEquals(4,((List<?>)state.get("championshipRounds")).size());
        assertEquals(0,state.get("championshipTotal"));
        var tied=new KingService.Room("test","CHAMPIONSHIP","QUICK_MATCH","MEDIUM",10,0,time.ms);
        tied.players.put(1L,new KingService.Player(1,"p1","s1"));tied.players.put(2L,new KingService.Player(2,"p2","s2"));
        tied.players.values().forEach(p->p.score=120);assertNull(KingRoundEngine.scoreWinner(tied));
    }

}
