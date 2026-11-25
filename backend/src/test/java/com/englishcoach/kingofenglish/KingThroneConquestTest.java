package com.englishcoach.kingofenglish;
import com.englishcoach.dictionary.service.LocalGameLexicon;
import org.junit.jupiter.api.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** Soán ngôi 2.0 (owner 2026-10-29): four board sizes, the extended word list, replay / rematch lifecycle, recorded results. */
class KingThroneConquestTest {
    KingConquestBank bank=new KingConquestBank();KingServiceTest.Time time;KingService game;LocalGameLexicon lexicon;
    final List<List<KingConquestResults.Row>> recorded=new ArrayList<>();
    @BeforeEach void setup(){
        time=new KingServiceTest.Time();lexicon=KingConquestTest.localLexicon();
        game=new KingService(new KingBank(),new KingExplainBank(),bank,lexicon,mock(SimpMessagingTemplate.class),time,true);
        var results=mock(KingConquestResults.class);
        doAnswer(call->{recorded.add(call.getArgument(0));((java.util.function.Consumer<Boolean>)call.getArgument(1)).accept(true);return null;})
            .when(results).submit(any(),any());
        game.setResults(results);
    }
    @AfterEach void close(){game.close();}
    Map<String,Object> act(long user,String action,Map<String,Object> s,String flow,Integer size,String word,List<Integer> path){
        return game.act(user,"p"+user,"s"+user,new KingService.Command(action,s==null?null:(String)s.get("roomCode"),"CONQUEST",flow,10,0,"KING",
            s==null?null:(String)s.get("matchId"),s==null?null:(Integer)s.get("round"),s==null?null:(Long)s.get("inputRevision"),UUID.randomUUID().toString(),word,path,size));
    }
    @SuppressWarnings("unchecked") Map<String,Object> board(Map<String,Object> s){return (Map<String,Object>)s.get("conquest");}
    KingService.Room room(Map<String,Object> s)throws Exception{
        var f=KingService.class.getDeclaredField("rooms");f.setAccessible(true);
        return ((Map<String,KingService.Room>)f.get(game)).get((String)s.get("roomCode"));
    }
    void rejection(String code,org.junit.jupiter.api.function.Executable e){assertEquals(code,assertThrows(KingService.Rejection.class,e).code);}

    @Test void everydayWordsAreAcceptedAndJunkIsNot(){
        var words=KingConquestBoards.words();assertTrue(words.size()>40_000,"extended list loaded: "+words.size());
        for(String w:"post her his him she they them their posts posted ran went eaten children cats colour color realise realize better best mice teeth wrote written the and with from very".split(" "))
            assertTrue(words.contains(w),w);
        for(String w:"etc mph inc dept approx tsp lol omg aka asap qwe zzz xyz abc paris london xvii lxiv".split(" "))
            assertFalse(words.contains(w),w);
    }
    @Test void fourSizesHaveTheirOwnClockBoardAndThrone()throws Exception{
        for(var e:Map.of(4,120_000L,5,180_000L,6,270_000L,7,360_000L).entrySet()){
            int size=e.getKey();var s=act(1,"start",null,"SOLO",size,null,null);
            var b=board(s);assertEquals(size,b.get("size"));assertEquals(size*size,((List<?>)b.get("letters")).size());
            assertEquals(time.ms+e.getValue(),((Number)s.get("deadline")).longValue());assertEquals(e.getValue(),((Number)b.get("durationMs")).longValue());
            int throne=(Integer)b.get("throne"),h=size/2;
            if(size%2==1)assertEquals(h*size+h,throne);
            else assertTrue(Set.of((h-1)*size+h-1,(h-1)*size+h,h*size+h-1,h*size+h).contains(throne),"even boards: one of the four central cells");
            // A real word on this very board is accepted and captures its tiles (the throne included when crossed).
            var r=room(s);var c=r.conquest.candidates.getFirst();
            s=act(1,"move",s,"SOLO",null,c.word(),c.path());
            assertEquals(c.path().size(),board(s).get("territory"));
            act(1,"leave",s,"SOLO",null,null,null);
        }
        rejection("INVALID_BOARD_SIZE",()->act(1,"start",null,"SOLO",8,null,null));
    }
    @Test void generatedBoardsAreDeterministicPlayableAndFast(){
        var all=KingConquestBoards.words();
        for(int size:new int[]{4,6,7}){
            long began=System.nanoTime();int passes=0;
            for(long seed=1;seed<=20;seed++){
                var a=KingConquestBoards.generate(size,seed,all,all);var b=KingConquestBoards.generate(size,seed,all,all);
                assertEquals(a.letters(),b.letters());assertEquals(a.throne(),b.throne());
                assertTrue(a.candidates().size()>=12,"Echo has candidates");
                for(var c:a.candidates())assertEquals(c.word(),KingConquestRules.path(a.letters(),size,c.word(),c.path()));
                if(a.playableWords()>=(size==4?45:size==6?170:240))passes++;
            }
            long ms=(System.nanoTime()-began)/1_000_000;
            assertTrue(passes>=18,size+"×"+size+" boards reaching the floor: "+passes);
            assertTrue(ms<4_000,size+"×"+size+" 40 boards in "+ms+" ms");
        }
    }
    @Test void pathRulesFollowTheBoardSizeAndNameTheRealReason(){
        var letters=new ArrayList<>(Collections.nCopies(49,"A"));
        assertEquals("aaa",KingConquestRules.path(letters,7,"aaa",List.of(0,8,16)));
        rejection("NOT_ADJACENT",()->KingConquestRules.path(letters,7,"aaa",List.of(5,6,7)));
        rejection("TILE_OUT_OF_RANGE",()->KingConquestRules.path(letters,7,"aaa",List.of(47,48,49)));
        rejection("WORD_TOO_SHORT",()->KingConquestRules.path(letters,7,"aa",List.of(0,1)));
        rejection("WORD_USED",()->KingConquestRules.validate(letters,7,"aaa",List.of(0,1,2),Set.of("aaa"),w->true));
        rejection("WORD_NOT_ELIGIBLE",()->KingConquestRules.validate(letters,7,"aaa",List.of(0,1,2),Set.of(),w->false));
    }
    @Test void soloReplayStartsAFreshRoundOfTheSameSizeEvenAfterTheResultTtl()throws Exception{
        var s=act(1,"start",null,"SOLO",6,null,null);var c=room(s).conquest.candidates.getFirst();
        s=act(1,"move",s,"SOLO",null,c.word(),c.path());int scored=(Integer)s.get("score");assertTrue(scored>0);
        time.ms+=270_001;game.tick();
        s=act(1,"ping",s,"SOLO",null,null,null);assertEquals("FINISHED",s.get("status"));
        assertEquals(1,recorded.size());assertEquals(6,recorded.getFirst().getFirst().size());assertEquals(scored,recorded.getFirst().getFirst().score());
        assertEquals(true,s.get("resultSaved"));
        // The learner reads the result for five minutes; the result screen's heartbeat keeps the room.
        for(int n=0;n<30;n++){time.ms+=10_000;game.tick();s=act(1,"ping",s,"SOLO",null,null,null);}
        var old=s.get("matchId");s=act(1,"rematch",s,"SOLO",null,null,null);
        assertEquals("PLAYING",s.get("status"));assertNotEquals(old,s.get("matchId"));assertEquals(0,s.get("score"));
        assertEquals(6,board(s).get("size"));assertTrue(((List<?>)board(s).get("usedWords")).isEmpty());
        assertEquals(time.ms+270_000,((Number)s.get("deadline")).longValue());assertEquals(false,s.get("resultSaved"));
        var fresh=room(s).conquest.candidates.getFirst();s=act(1,"move",s,"SOLO",null,fresh.word(),fresh.path());assertTrue((Integer)s.get("score")>0);
    }
    @Test void duelRematchIsBilateralAndALeaverNeverLeavesTheOtherWaiting()throws Exception{
        var a=act(1,"quick",null,"QUICK_MATCH",7,null,null);var b=act(2,"quick",null,"QUICK_MATCH",7,null,null);
        assertEquals("PLAYING",b.get("status"));assertEquals(a.get("roomCode"),b.get("roomCode"));
        var other=act(3,"quick",null,"QUICK_MATCH",4,null,null);assertEquals("WAITING",other.get("status"),"a 4×4 player is never paired with a 7×7 room");
        time.ms+=360_001;game.tick();
        a=act(1,"ping",a,"QUICK_MATCH",null,null,null);b=act(2,"ping",b,"QUICK_MATCH",null,null,null);
        assertEquals("FINISHED",a.get("status"));assertEquals(2,recorded.getFirst().size());
        a=act(1,"rematch",a,"QUICK_MATCH",null,null,null);assertEquals("FINISHED",a.get("status"));
        b=act(2,"rematch",b,"QUICK_MATCH",null,null,null);assertEquals("PLAYING",b.get("status"));assertEquals(7,board(b).get("size"));
        a=act(1,"ping",b,"QUICK_MATCH",null,null,null);assertEquals(b.get("matchId"),a.get("matchId"));
        time.ms+=360_001;game.tick();a=act(1,"ping",a,"QUICK_MATCH",null,null,null);
        act(1,"rematch",a,"QUICK_MATCH",null,null,null);act(2,"leave",a,"QUICK_MATCH",null,null,null);
        var left=act(1,"ping",a,"QUICK_MATCH",null,null,null);
        @SuppressWarnings("unchecked") var players=(List<Map<String,Object>>)left.get("players");
        assertTrue(players.stream().allMatch(p->Boolean.FALSE.equals(p.get("rematch"))),"a pending vote is cleared when the opponent leaves");
        assertTrue(players.stream().anyMatch(p->Boolean.FALSE.equals(p.get("connected"))));
        rejection("OPPONENT_LEFT",()->act(1,"rematch",left,"QUICK_MATCH",null,null,null));
    }
    @Test void forfeitsAndChampionshipsAreNotRanked()throws Exception{
        var s=act(1,"start",null,"SOLO",4,null,null);act(1,"leave",s,"SOLO",null,null,null);
        assertTrue(recorded.isEmpty());
    }
}
