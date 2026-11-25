package com.englishcoach.kingofenglish;
import com.englishcoach.dictionary.provider.*;
import com.englishcoach.dictionary.service.LocalGameLexicon;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class KingConquestTest {
    KingConquestBank bank=new KingConquestBank();KingServiceTest.Time time;KingService game;LocalGameLexicon lexicon;
    static LocalGameLexicon localLexicon(){
        var local=new LocalEnViLexicalProvider();local.init();var core=new KaikkiLocalLexicalStore(new ObjectMapper());core.init();
        return new LocalGameLexicon(local,core);
    }
    @BeforeEach void setup(){time=new KingServiceTest.Time();lexicon=localLexicon();assertTrue(lexicon.available());
        game=new KingService(new KingBank(),new KingExplainBank(),bank,lexicon,mock(SimpMessagingTemplate.class),time,true);}
    @AfterEach void close(){game.close();}
    Map<String,Object> act(long user,String action,Map<String,Object> s,String flow,String word,List<Integer> path){
        return game.act(user,"p"+user,"s"+user,new KingService.Command(action,s==null?null:(String)s.get("roomCode"),"CONQUEST",flow,6,0,"KING",
            s==null?null:(String)s.get("matchId"),s==null?null:(Integer)s.get("round"),s==null?null:(Long)s.get("inputRevision"),UUID.randomUUID().toString(),word,path));
    }
    @SuppressWarnings("unchecked") Map<String,Object> board(Map<String,Object> s){return (Map<String,Object>)s.get("conquest");}
    Map<String,Object> pair(String flow){
        var s=act(1,flow.equals("QUICK_MATCH")?"quick":"create",null,flow,null,null);
        act(2,flow.equals("QUICK_MATCH")?"quick":"join",flow.equals("QUICK_MATCH")?null:s,flow,null,null);
        act(1,"ready",s,flow,null,null);return act(2,"ready",s,flow,null,null);
    }
    void rejection(String code,org.junit.jupiter.api.function.Executable e){assertEquals(code,assertThrows(KingService.Rejection.class,e).code);}
    @Test void qualifiedImmutableBoardsAndRealCanonicalCandidates()throws Exception{
        assertTrue(bank.all().size()>=50);assertTrue(KingConquestBank.validate(new ArrayList<>(bank.all())).isEmpty());
        for(var b:bank.all()){
            assertEquals(25,b.letters().size());assertEquals(KingConquestBank.fingerprint(b),b.fingerprint());
            assertThrows(UnsupportedOperationException.class,()->b.letters().set(0,"Z"));
            for(var c:b.echoCandidates())assertEquals(c.word(),KingConquestRules.validate(b,c.word(),c.path(),Set.of(),lexicon));
        }
        var mapper=new ObjectMapper();var base=bank.get("king-c-1");
        for(var change:Map.of("sourceRef","","fingerprint","old","reviewStatus","ACTIVE","humanReview","fabricated").entrySet()){
            var tree=(com.fasterxml.jackson.databind.node.ObjectNode)mapper.valueToTree(base);tree.put(change.getKey(),change.getValue());
            assertFalse(KingConquestBank.validate(List.of(mapper.treeToValue(tree,KingConquestBank.Board.class))).isEmpty());
        }
        assertFalse(KingConquestBank.validate(List.of(base,base)).isEmpty());
        var tree=(com.fasterxml.jackson.databind.node.ObjectNode)mapper.valueToTree(base);tree.putArray("letters").add("Z");
        assertFalse(KingConquestBank.validate(List.of(mapper.treeToValue(tree,KingConquestBank.Board.class))).isEmpty());
        assertTrue(lexicon.lookupConquest("paris").isEmpty());assertTrue(lexicon.lookupConquest("london").isEmpty());
        assertTrue(lexicon.lookupConquest("cat").isPresent());assertTrue(lexicon.lookup("paris").isPresent(),"Word Chain behavior preserved");
    }
    @Test void pathGeometryLengthReuseBoundsLettersAndLexicon(){
        var letters=new ArrayList<>(Collections.nCopies(25,"A"));
        for(var path:List.of(List.of(0,1,2),List.of(0,5,10),List.of(0,6,12)))assertEquals("aaa",KingConquestRules.path(letters," AAA ",path));
        rejection("NOT_ADJACENT",()->KingConquestRules.path(letters,"aaa",List.of(0,2,3)));
        rejection("TILE_REUSED",()->KingConquestRules.path(letters,"aaa",List.of(0,1,0)));
        rejection("TILE_OUT_OF_RANGE",()->KingConquestRules.path(letters,"aaa",List.of(0,1,25)));
        rejection("LETTERS_MISMATCH",()->KingConquestRules.path(letters,"cat",List.of(0,1,2)));
        rejection("WORD_TOO_SHORT",()->KingConquestRules.path(letters,"aa",List.of(0,1)));
        rejection("INVALID_PATH",()->KingConquestRules.path(letters,"aaa",List.of(0,1)));
        var b=bank.get("king-c-1");var c=b.echoCandidates().getFirst();
        var blocked=mock(LocalGameLexicon.class);
        rejection("WORD_NOT_ELIGIBLE",()->KingConquestRules.validate(b,c.word(),c.path(),Set.of(),blocked));
        var used=new HashSet<String>();for(int n=0;n<KingConfig.CONQUEST_WORD_CAP;n++)used.add("already"+n);
        rejection("WORD_LIMIT",()->KingConquestRules.validate(b,c.word(),c.path(),used,lexicon));assertEquals(180,used.size());
    }
    @Test void territoryCaptureThroneRecaptureGlobalRepeatsRevisionsAndAllFlows(){
        // Recapture needs two throne candidates; random layouts need not put both in Echo's small pool.
        game.close();var fixed=spy(bank);doReturn("king-c-1").when(fixed).select(anyLong());
        game=new KingService(new KingBank(),new KingExplainBank(),fixed,lexicon,mock(SimpMessagingTemplate.class),time,true);
        for(String flow:List.of("SOLO","ECHO","QUICK_MATCH","PRIVATE_ROOM")){
            var s=flow.equals("SOLO")||flow.equals("ECHO")?act(1,"start",null,flow,null,null):pair(flow);
            var a=act(1,"ping",s,flow,null,null);var b=bank.get((String)board(a).get("boardId"));
            var c=b.echoCandidates().stream().filter(x->x.path().contains(12)).findFirst().orElseThrow();
            rejection("NOT_A_MEMBER",()->act(3,"move",a,flow,c.word(),c.path()));
            var moved=act(1,"move",a,flow,c.word().toUpperCase(),c.path());
            assertEquals(c.path().size(),board(moved).get("territory"));assertTrue(((List<?>)board(moved).get("owners")).get(12).equals(1L));
            assertEquals(KingConfig.conquestWordPoints(c.word().length())+c.path().size()*2+5,moved.get("score"));
            assertTrue((Long)moved.get("revision")>(Long)a.get("revision"));
            // The sender's view does not matter: the same word is refused for being used, whatever revision it was sent from.
            rejection("WORD_USED",()->act(1,"move",a,flow,c.word(),c.path()));
            rejection("WORD_USED",()->act(1,"move",moved,flow,c.word(),c.path()));
            if(flow.equals("QUICK_MATCH")||flow.equals("PRIVATE_ROOM")){
                var peer=act(2,"ping",s,flow,null,null);assertEquals(board(moved).get("letters"),board(peer).get("letters"));assertEquals(moved.get("deadline"),peer.get("deadline"));
                var peerBefore=peer;rejection("WORD_USED",()->act(2,"move",peerBefore,flow,c.word(),c.path()));
                var other=b.echoCandidates().stream().filter(x->x.path().contains(12)&&!x.word().equals(c.word())).findFirst().orElseThrow();
                peer=act(2,"move",peer,flow,other.word(),other.path());assertEquals(2L,((List<?>)board(peer).get("owners")).get(12));
            }
            time.ms+=KingConfig.CONQUEST_MS;game.tick();s=act(1,"ping",s,flow,null,null);assertEquals("FINISHED",s.get("status"));
            var end=s;rejection("NOT_PLAYING",()->act(1,"move",end,flow,c.word(),c.path()));
            time.ms+=100;game.tick();assertEquals(end.get("score"),act(1,"ping",end,flow,null,null).get("score"));
            if(flow.equals("SOLO")||flow.equals("ECHO")){s=act(1,"rematch",s,flow,null,null);assertEquals(0,s.get("score"));assertTrue(((List<?>)board(s).get("usedWords")).isEmpty());}
            else{act(1,"rematch",s,flow,null,null);s=act(2,"rematch",s,flow,null,null);assertEquals(0,s.get("score"));}
            assertNotEquals(end.get("matchId"),s.get("matchId"));game.disconnect("s1");time.ms+=500;s=act(1,"rejoin",s,flow,null,null);assertEquals("PLAYING",s.get("status"));
            act(1,"leave",s,flow,null,null);if(flow.equals("QUICK_MATCH")||flow.equals("PRIVATE_ROOM"))act(2,"leave",s,flow,null,null);
        }
    }
    @Test void everyFurtherValidWordKeepsAddingPointsPastSeventyFive(){
        var s=act(1,"start",null,"SOLO",null,null);var b=bank.get((String)board(s).get("boardId"));
        int expectedWordPoints=0,previous=0,beyond=0;
        for(var c:b.echoCandidates()){
            time.ms+=1000;s=act(1,"move",s,"SOLO",c.word(),c.path());
            expectedWordPoints+=KingConfig.conquestWordPoints(c.word().length());
            assertEquals(expectedWordPoints,board(s).get("wordPoints"));
            int score=(Integer)s.get("score");if(previous>=75){beyond++;assertTrue(score>previous,"a word after 75 must raise the score");}previous=score;
        }
        assertEquals(b.echoCandidates().size(),((List<?>)board(s).get("usedWords")).size());
        assertEquals(expectedWordPoints+(Integer)board(s).get("territory")*2+(((List<?>)board(s).get("owners")).get(12).equals(1L)?5:0),s.get("score"));
        assertTrue(expectedWordPoints>20,"the board offers more than the old word-point cap");
        int awarded=((List<Map<String,Object>>)board(s).get("wordHistory")).stream().mapToInt(event->((Number)event.get("wordPoints")).intValue()).sum();
        assertEquals(expectedWordPoints,awarded);
        assertTrue(((List<Map<String,Object>>)board(s).get("wordHistory")).stream().noneMatch(event->((Number)event.get("wordPoints")).intValue()==0),"no valid word is ever worth nothing");
        // Refused words stay refused: no points for a repeat.
        var end=s;var last=b.echoCandidates().getLast();rejection("WORD_USED",()->act(1,"move",end,"SOLO",last.word(),last.path()));
        assertEquals(previous,act(1,"ping",s,"SOLO",null,null).get("score"));
    }
    @Test void echoUsesSameValidatorAndDifficultyTiming(){
        assertEquals(KingConquestEngine.botDelay("KING",42,3),KingConquestEngine.botDelay("KING",42,3));
        assertTrue(KingConquestEngine.botDelay("KING",42,3)<KingConquestEngine.botDelay("EASY",42,3));
        var s=act(1,"start",null,"ECHO",null,null);time.ms+=6000;game.tick();s=act(1,"ping",s,"ECHO",null,null);
        assertFalse(((List<?>)board(s).get("usedWords")).isEmpty());assertEquals(0L,board(s).get("lastPlayer"));
        assertTrue(lexicon.lookupConquest((String)board(s).get("lastWord")).isPresent());
    }
    @Test @SuppressWarnings("unchecked") void simultaneousGlobalDuplicateAcceptsOnceAndHistoryRecomputesScores()throws Exception{
        var s=pair("QUICK_MATCH");var a=act(1,"ping",s,"QUICK_MATCH",null,null);var b=act(2,"ping",s,"QUICK_MATCH",null,null);
        var source=bank.get((String)board(a).get("boardId"));var candidate=source.echoCandidates().getFirst();
        var ready=new java.util.concurrent.CountDownLatch(2);var go=new java.util.concurrent.CountDownLatch(1);
        try(var workers=java.util.concurrent.Executors.newFixedThreadPool(2)){
            var calls=new ArrayList<java.util.concurrent.Future<Boolean>>();
            for(int user=1;user<=2;user++){long id=user;var snapshot=user==1?a:b;calls.add(workers.submit(()->{
                ready.countDown();go.await();try{act(id,"move",snapshot,"QUICK_MATCH",candidate.word(),candidate.path());return true;}
                catch(KingService.Rejection rejected){assertEquals("WORD_USED",rejected.code);return false;}
            }));}
            ready.await();go.countDown();int accepted=0;for(var call:calls)if(call.get())accepted++;assertEquals(1,accepted);
        }
        var current=act(1,"ping",s,"QUICK_MATCH",null,null);assertEquals(1,((List<?>)board(current).get("wordHistory")).size());
        var fresh=current;rejection("WORD_USED",()->act(1,"move",fresh,"QUICK_MATCH",candidate.word().toUpperCase(),candidate.path()));
        time.ms+=1000;
        var owners=new long[25];Arrays.fill(owners,-1);var points=new HashMap<Long,Integer>();
        var history=(List<Map<String,Object>>)board(current).get("wordHistory");
        for(var event:history){long id=((Number)event.get("playerId")).longValue();int awarded=((Number)event.get("wordPoints")).intValue();points.merge(id,awarded,Integer::sum);for(int tile:(List<Integer>)event.get("path"))owners[tile]=id;}
        var breakdown=(Map<String,Map<String,Object>>)board(current).get("playerBreakdown");
        for(long id:List.of(1L,2L)){int territory=(int)Arrays.stream(owners).filter(x->x==id).count();int score=points.getOrDefault(id,0)+territory*2+(owners[12]==id?5:0);assertEquals(score,((Number)breakdown.get(Long.toString(id)).get("score")).intValue());}
        var restored=game.act(1,"p1","replacement",new KingService.Command("rejoin",(String)s.get("roomCode"),null,null,null,null,null,null,null,null,"restore",null,null));
        assertEquals(board(current).get("usedWords"),board(restored).get("usedWords"));assertEquals(history,board(restored).get("wordHistory"));
    }
    @Test void loveNormalizationIsGlobalForHumansAndEcho(){
        var letters=new ArrayList<>(Collections.nCopies(25,"A"));for(int i=0;i<4;i++)letters.set(i,List.of("L","O","V","E").get(i));
        var base=bank.all().iterator().next();var synthetic=new KingConquestBank.Board("test-love",letters,1,base.qualityMetrics(),List.of(),base.sourceKind(),base.sourceRef(),base.contentVersion(),base.reviewStatus(),null,"");
        var used=new LinkedHashSet<String>();var path=List.of(0,1,2,3);
        used.add(KingConquestRules.validate(synthetic," LOVE ",path,used,w->true));
        for(String input:List.of("LOVE","love"," Love ","ＬＯＶＥ"))rejection("WORD_USED",()->KingConquestRules.validate(synthetic,input,path,used,w->true));
        assertEquals(Set.of("love"),used);
    }
}
