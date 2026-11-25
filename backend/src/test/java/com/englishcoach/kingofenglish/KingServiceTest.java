package com.englishcoach.kingofenglish;

import org.junit.jupiter.api.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.*;
import java.util.*;
import java.nio.file.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class KingServiceTest {
    static class Time extends Clock{
        long ms=100_000;public ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(ZoneId z){return this;}
        public Instant instant(){return Instant.ofEpochMilli(ms);}public long millis(){return ms;}
    }
    KingBank bank;KingService game;Time time;
    @BeforeEach void setup(){bank=new KingBank();time=new Time();game=new KingService(bank,mock(SimpMessagingTemplate.class),time,true);}
    @AfterEach void close(){game.close();}
    Map<String,Object> command(long user,String session,String action,Map<String,Object> state,String mode,String flow,String answer,List<Integer> order,String receipt){
        return game.act(user,"principal-"+user,session,new KingService.Command(action,state==null?null:(String)state.get("roomCode"),
            mode,flow,5,0,"MEDIUM",state==null?null:(String)state.get("matchId"),state==null?null:(Integer)state.get("round"),
            state==null?null:(Long)state.get("inputRevision"),receipt,answer,order));
    }
    Map<String,Object> act(long user,String action,Map<String,Object> state){return command(user,"s"+user,action,state,null,null,null,null,UUID.randomUUID().toString());}
    Map<String,Object> start(String mode,String flow){return command(1,"s1","start",null,mode,flow,null,null,"start");}
    Map<String,Object> pair(String mode,String flow){
        var a=command(1,"s1",flow.equals("QUICK_MATCH")?"quick":"create",null,mode,flow,null,null,"create");
        command(2,"s2",flow.equals("QUICK_MATCH")?"quick":"join",flow.equals("QUICK_MATCH")?null:a,mode,flow,null,null,"join");
        act(1,"ready",a);return act(2,"ready",a);
    }
    @SuppressWarnings("unchecked") KingBank.Item item(Map<String,Object> s){
        return bank.get((String)((Map<String,Object>)s.get("challenge")).get("id"));
    }
    List<Integer> correctOrder(KingBank.Item i){
        var target=i.mode().equals("REORDER")?KingBank.normalize(i.canonical()).split(" "):i.canonical().split("");
        var available=new ArrayList<Integer>();for(int n=0;n<i.tokens().size();n++)available.add(n);
        var order=new ArrayList<Integer>();
        for(String t:target){int index=available.stream().filter(n->KingBank.normalize(i.tokens().get(n)).equals(t)).findFirst().orElseThrow();order.add(index);available.remove(Integer.valueOf(index));}
        return order;
    }
    Map<String,Object> answer(long user,Map<String,Object> s,String id){
        time.ms+=1600;var i=item(s);return command(user,"s"+user,"answer",s,null,null,i.canonical(),i.tokens().isEmpty()?null:correctOrder(i),id);
    }
    void code(String expected,org.junit.jupiter.api.function.Executable run){assertEquals(expected,assertThrows(KingService.Rejection.class,run).code);}
    @Test void immutableSharedBankAndRepeatedTokens(){
        var i=bank.get("king-r-19");assertSame(i,bank.get(i.id()));assertThrows(UnsupportedOperationException.class,()->i.tokens().add("x"));
        assertTrue(KingBank.correct(i,null,correctOrder(i)));
        var duplicate=new ArrayList<>(correctOrder(i));duplicate.set(1,duplicate.get(0));assertFalse(KingBank.correct(i,null,duplicate));
        assertFalse(KingBank.correct(i,null,List.of(100)));
    }
    @Test void alternativesPunctuationContractions(){
        var i=bank.get("king-r-7");assertTrue(KingBank.correct(i,null,List.of(3,0,1,2)));
        assertEquals("don't re-order",KingBank.normalize(" DON'T  re-order! "));
        assertNotEquals(KingBank.normalize("don't"),KingBank.normalize("dont"));
    }
    @Test void allReflexFamiliesExecuteTruth(){
        var families=new HashSet<String>();
        for(int n=1;n<=26;n++){var i=bank.get("king-f-"+n);families.add(i.family());
            assertTrue(KingBank.correct(i,i.canonical(),i.tokens().isEmpty()?null:correctOrder(i)),i.id());
            assertFalse(KingBank.correct(i,"incorrect",i.tokens().isEmpty()?null:List.of(-1)),i.id());}
        assertEquals(KingBank.REFLEX_TYPES,families);
    }
    @Test void productionClosed(){
        var closed=new KingService(bank,mock(SimpMessagingTemplate.class),time,false);
        try{code("CONTENT_NOT_APPROVED",()->closed.act(1,"a","s",new KingService.Command("start",null,"REORDER","SOLO",5,0,"MEDIUM",null,null,null,"1",null,null)));}
        finally{closed.close();}
    }
    @Test void createJoinReadyMembershipAndSpoof(){
        var s=pair("REORDER","PRIVATE_ROOM");assertEquals("PLAYING",s.get("status"));
        code("NOT_A_MEMBER",()->answer(3,s,"cross"));
        code("STALE_SESSION",()->command(1,"other","answer",s,null,null,"x",null,"spoof"));
        code("ALREADY_IN_ROOM",()->command(1,"new-socket","create",null,"REFLEX","PRIVATE_ROOM",null,null,"different"));
        var duplicate=command(1,"new-socket","create",null,"REORDER","PRIVATE_ROOM",null,null,"again");
        assertEquals(s.get("roomCode"),duplicate.get("roomCode"));assertEquals(1,game.memoryState().get("rooms"));
    }
    @Test void quickMatchSharesEngineAndSeparatesModes(){
        var s=pair("REFLEX","QUICK_MATCH");assertEquals(2,((List<?>)s.get("players")).size());
        var other=command(3,"s3","quick",null,"REORDER","QUICK_MATCH",null,null,"q3");assertEquals("WAITING",other.get("status"));assertEquals(2,game.memoryState().get("rooms"));
    }
    @Test void competitivePresentationHasNoTruthOrOpponentInput()throws Exception{
        var s=pair("REORDER","PRIVATE_ROOM");var json=new ObjectMapper().writeValueAsString(s);
        assertFalse(json.contains("canonical"));assertFalse(json.contains("accepted"));assertFalse(json.contains("\"answer\":"));
        assertFalse(json.contains("selected"));assertFalse(json.contains("sourceRef"));
    }
    @Test void firstCorrectDuplicateStaleAndLock(){
        var s=pair("REORDER","PRIVATE_ROOM");var host=act(1,"ping",s);
        var wrong=command(1,"s1","answer",host,null,null,"bad",List.of(0),"wrong");
        assertEquals(1,wrong.get("wrong"));
        code("INPUT_LOCKED",()->command(1,"s1","answer",host,null,null,"bad",List.of(0),"spam"));
        var won=answer(1,host,"win");assertEquals(1,won.get("score"));
        var replay=command(1,"s1","answer",host,null,null,"x",null,"win");assertEquals(1,replay.get("score"));
        code("ROUND_RESOLVED",()->command(2,"s2","answer",s,null,null,"late",null,"late"));
        time.ms+=KingConfig.RESOLUTION_MS;game.tick();var next=act(1,"ping",s);assertEquals(1,next.get("round"));
        code("STALE_ROUND",()->answer(1,host,"old"));
    }
    @Test void boundedSuddenDeathAndDraw(){
        var s=pair("REORDER","PRIVATE_ROOM");
        for(int n=0;n<KingConfig.REORDER_ROUNDS+KingConfig.SUDDEN_MAX;n++){time.ms+=KingConfig.REORDER_MS;game.tick();time.ms+=KingConfig.RESOLUTION_MS;game.tick();}
        var end=act(1,"ping",s);assertEquals("FINISHED",end.get("status"));assertNull(end.get("winnerId"));assertEquals(13,end.get("round"));
        code("NOT_PLAYING",()->command(1,"s1","answer",end,null,null,"x",null,"end"));
    }
    @Test void normalWinAndTerminalState(){
        var s=pair("REORDER","PRIVATE_ROOM");
        for(int n=0;n<10;n++){var own=act(1,"ping",s);answer(1,own,"answer-"+n);time.ms+=KingConfig.RESOLUTION_MS;game.tick();}
        var end=act(1,"ping",s);assertEquals("FINISHED",end.get("status"));assertEquals(1L,end.get("winnerId"));assertEquals(10,end.get("score"));
        var before=end.get("score");act(1,"leave",end);assertEquals(before,game.result(1,(String)end.get("matchId")).get("score"));
    }
    @Test void reorderSoloLengthRestartAndReview(){
        var s=start("REORDER","SOLO");
        for(int n=0;n<5;n++){s=answer(1,s,"a"+n);assertTrue((Boolean)s.get("resolved"));s=act(1,"next",s);}
        assertEquals("FINISHED",s.get("status"));assertEquals(50,s.get("score"));assertEquals(5,((List<?>)s.get("review")).size());
        var old=s;var restarted=act(1,"rematch",s);assertEquals(0,restarted.get("score"));assertEquals(0,restarted.get("round"));assertNotEquals(s.get("matchId"),restarted.get("matchId"));
        code("STALE_MATCH",()->command(1,"s1","answer",old,null,null,"old",null,"old-match"));
    }
    @Test void reflexSkipRevisitWrongAndDuplicate(){
        var s=start("REFLEX","SOLO");assertEquals(13,s.get("count"));assertEquals(time.ms+90_000,s.get("deadline"));
        int first=(Integer)s.get("round");s=act(1,"skip",s);assertEquals(1,s.get("skipped"));
        var old=s;s=command(1,"s1","answer",s,null,null,"incorrect",List.of(-1),"wrong");assertEquals(0,s.get("score"));assertEquals(1,s.get("wrong"));
        var replay=command(1,"s1","answer",old,null,null,"incorrect",null,"wrong");assertEquals(s.get("completed"),replay.get("completed"));
        for(int n=0;n<11;n++)s=answer(1,s,"f"+n);
        assertEquals(first,s.get("round"));assertTrue((Boolean)s.get("revisiting"));s=answer(1,s,"revisit");
        assertEquals("FINISHED",s.get("status"));assertEquals(12,s.get("score"));assertEquals(13,s.get("completed"));assertEquals(1,s.get("wrong"));
    }
    @Test void reflexTimeoutTieBreakAndSharedSequence(){
        var s=pair("REFLEX","PRIVATE_ROOM");var a=act(1,"ping",s);assertEquals(item(s).id(),item(a).id());
        answer(1,a,"a");time.ms+=10_000;answer(2,s,"b");time.ms+=90_000;game.tick();
        var end=act(1,"ping",s);assertEquals(1L,end.get("winnerId"));assertEquals("FINISHED",end.get("status"));
    }
    @Test void echoProfilesDeterministicIndependentAndBothModes(){
        var easy=KingService.botDecision("EASY",42,0,3,8);var king=KingService.botDecision("KING",42,0,3,8);
        assertEquals(easy,KingService.botDecision("EASY",42,0,3,8));assertTrue(king.delay()<easy.delay());
        for(String mode:List.of("REORDER","REFLEX")){
            var s=start(mode,"ECHO");time.ms+=8000;game.tick();var update=act(1,"ping",s);
            assertEquals(2,((List<?>)update.get("players")).size());act(1,"leave",update);
        }
    }
    @Test void reconnectGraceStateSessionAndAfterExpiry(){
        var s=pair("REORDER","PRIVATE_ROOM");var host=act(1,"ping",s);answer(1,host,"a");game.disconnect("s2");time.ms+=1000;
        var attached=command(2,"replacement","rejoin",s,null,null,null,null,"r");assertEquals(0,attached.get("score"));
        assertEquals(1,act(1,"ping",s).get("score"));game.disconnect("s2");var refreshed=command(2,"replacement","ping",attached,null,null,null,null,"ping");assertTrue(((List<Map<String,Object>>)refreshed.get("players")).stream().allMatch(p->(Boolean)p.get("connected")));
        game.disconnect("replacement");time.ms+=KingConfig.DISCONNECT_GRACE+1;game.tick();
        var ended=command(2,"newest","rejoin",s,null,null,null,null,"expired");assertEquals("FINISHED",ended.get("status"));assertEquals(1L,ended.get("winnerId"));
    }
    @Test void bilateralRematchOldReceiptsAndOwnerResults(){
        var s=pair("REFLEX","PRIVATE_ROOM");var end=act(1,"leave",s); // leave prevents bilateral rematch
        assertNotNull(game.result(1,(String)end.get("matchId")));code("RESULT_NOT_FOUND",()->game.result(3,(String)end.get("matchId")));
        assertTrue(game.history(3).isEmpty());code("OPPONENT_LEFT",()->act(2,"rematch",end));
        var next=pair("REORDER","PRIVATE_ROOM");time.ms+=500_000; // tick advances only once; force finish via player2 leave
        var terminal=act(2,"leave",next);assertEquals("FINISHED",terminal.get("status"));
    }
    @Test void receiptBoundWaitingTTLFinishedCleanup(){
        var s=game.act(1,"principal-1","s1",new KingService.Command("start",null,"REORDER","SOLO",20,0,"MEDIUM",null,null,null,"start",null,null));
        for(int round=0;round<19;round++){
            for(int n=0;n<15;n++){time.ms+=1600;s=command(1,"s1","answer",s,null,null,"wrong",List.of(0),"id-"+round+"-"+n);}
            time.ms+=1600;s=act(1,"skip",s);s=act(1,"next",s);
        }
        assertTrue(game.memoryState().get("maxReceipt")<=KingConfig.RECEIPT_CAP);
        act(1,"leave",s);time.ms+=KingConfig.FINISH_TTL;game.tick();assertEquals(0,game.memoryState().get("rooms"));
        var wait=command(1,"s1","create",null,"REFLEX","PRIVATE_ROOM",null,null,"wait");
        time.ms+=KingConfig.WAIT_TTL;game.tick();assertEquals("FINISHED",act(1,"ping",wait).get("status"));
        time.ms+=KingConfig.FINISH_TTL;game.tick();assertEquals(0,game.memoryState().get("memberships"));
    }
    @Test void synthetic500RoomsBoundAndCleanup()throws Exception{
        Runtime rt=Runtime.getRuntime();System.gc();long baseline=rt.totalMemory()-rt.freeMemory();
        var report=new LinkedHashMap<String,Object>();report.put("baseline",game.memoryState());report.put("heapBaseline",baseline);
        var states=new ArrayList<Map<String,Object>>();
        for(int n=1;n<=500;n++){states.add(command(n,"s"+n,"start",null,n%2==0?"REORDER":"REFLEX","ECHO",null,null,"create"));
            if(n==100)report.put("rooms100",game.memoryState());}
        long peak=rt.totalMemory()-rt.freeMemory();report.put("rooms500",game.memoryState());report.put("heapPeak",peak);
        int maxSnapshot=0;for(var state:states)maxSnapshot=Math.max(maxSnapshot,new ObjectMapper().writeValueAsBytes(state).length);
        report.put("maxActiveSnapshotBytes",maxSnapshot);assertTrue(maxSnapshot<100_000);
        code("SERVER_BUSY",()->command(501,"s501","create",null,"REORDER","PRIVATE_ROOM",null,null,"over"));
        for(int n=1;n<=500;n++)act(n,"leave",states.get(n-1));report.put("afterFinish",game.memoryState());
        states.clear();time.ms+=KingConfig.FINISH_TTL;game.tick();System.gc();report.put("afterCleanup",game.memoryState());
        report.put("heapAfterCleanup",rt.totalMemory()-rt.freeMemory());report.put("method","One JVM, explicit GC request, live heap snapshots; approximate/no per-room RAM inference");
        assertEquals(0,game.memoryState().get("rooms"));assertEquals(0,game.memoryState().get("memberships"));
        assertTrue(Arrays.stream(KingService.Room.class.getDeclaredFields()).noneMatch(f->f.getType().equals(KingBank.Item.class)||f.getType().equals(KingBank.class)));
        String dir=System.getProperty("king.evidenceDir");if(dir!=null)new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(Path.of(dir,"memory.json").toFile(),report);
        System.out.println("KING_MEMORY "+new ObjectMapper().writeValueAsString(report));
    }
    @Test void contentNegativeCasesAndQualityReport()throws Exception{
        var mapper=new ObjectMapper();var i=bank.get("king-r-1");
        assertTrue(KingBank.validate(List.of(i,i)).stream().anyMatch(e->e.endsWith("DUPLICATE_ID")));
        var mutations=Map.of("canonical","","sourceRef","","status","ACTIVE","fingerprint","old","cefr","A0");
        for(var entry:mutations.entrySet()){
            var tree=mapper.valueToTree(i);((com.fasterxml.jackson.databind.node.ObjectNode)tree).put(entry.getKey(),entry.getValue());
            assertFalse(KingBank.validate(List.of(mapper.treeToValue(tree,KingBank.Item.class))).isEmpty(),entry.getKey());
        }
        for(var entry:Map.of("king-f-3","missingIndex","king-f-13","relationSet","king-f-17","expression","king-f-19","expression","king-f-21","meaning","king-f-11","context").entrySet()){
            var tree=(com.fasterxml.jackson.databind.node.ObjectNode)mapper.valueToTree(bank.get(entry.getKey()));tree.putNull(entry.getValue());
            try{assertFalse(KingBank.validate(List.of(mapper.treeToValue(tree,KingBank.Item.class))).isEmpty());}catch(IllegalArgumentException expected){}
        }
        assertEquals(47,bank.quality().get("TOTAL_UNIQUE"));
        String dir=System.getProperty("king.evidenceDir");if(dir!=null)mapper.writerWithDefaultPrettyPrinter().writeValue(Path.of(dir,"content-quality.json").toFile(),bank.quality());
    }
    @Test void timeoutsCountOnceAndAccuracyIncludesMisses(){
        var s=start("REORDER","SOLO");s=answer(1,s,"right");s=act(1,"next",s);
        time.ms+=KingConfig.REORDER_MS;game.tick();s=act(1,"ping",s);
        assertEquals(2,s.get("completed"));game.tick();assertEquals(2,act(1,"ping",s).get("completed"));
        s=act(1,"next",s);
        for(int n=0;n<3;n++){time.ms+=1600;s=act(1,"skip",s);s=act(1,"next",s);}
        assertEquals(5,s.get("completed"));assertEquals(.2,(Double)s.get("accuracy"));
    }
    @Test void revisitSkipCountsUniqueSlots(){
        var s=start("REFLEX","SOLO");
        for(int n=0;n<26;n++){time.ms+=1600;s=act(1,"skip",s);}
        assertEquals("FINISHED",s.get("status"));assertEquals(13,s.get("skipped"));assertEquals(13,s.get("completed"));
    }
    @Test void competitiveLoserCompletesRoundsAndSuccessfulBilateralRematch(){
        var s=pair("REORDER","QUICK_MATCH");
        for(int n=0;n<10;n++){answer(1,act(1,"ping",s),"round-"+n);time.ms+=KingConfig.RESOLUTION_MS;game.tick();}
        var a=act(1,"ping",s);var b=act(2,"ping",s);
        assertEquals(10,a.get("completed"));assertEquals(10,b.get("completed"));assertEquals(0.0,b.get("accuracy"));
        assertEquals("FINISHED",act(1,"rematch",a).get("status"));
        var fresh=act(2,"rematch",b);assertEquals("PLAYING",fresh.get("status"));assertEquals(0,fresh.get("score"));
        assertNotEquals(a.get("matchId"),fresh.get("matchId"));assertEquals(0,game.memoryState().get("receipts"));
        code("STALE_MATCH",()->command(1,"s1","answer",a,null,null,"old",null,"round-0"));
    }
    @Test void reflexFewerWrongPrecedesTimeAndExactTieDraws(){
        var s=pair("REFLEX","PRIVATE_ROOM");
        var a=answer(1,act(1,"ping",s),"right-a");answer(2,s,"right-b");
        command(1,"s1","answer",a,null,null,"bad",List.of(-1),"wrong-a");
        time.ms+=KingConfig.REFLEX_MS;game.tick();assertEquals(2L,act(1,"ping",s).get("winnerId"));
        act(1,"leave",s);act(2,"leave",s);
        var tie=pair("REFLEX","PRIVATE_ROOM");time.ms+=KingConfig.REFLEX_MS;game.tick();assertNull(act(1,"ping",tie).get("winnerId"));
    }
    @Test void mixedReflexHasEveryFamilyAndSequenceIsSeeded(){
        var ids=bank.sequence("REFLEX",0,13,123);
        assertEquals(ids,bank.sequence("REFLEX",0,13,123));
        assertEquals(KingBank.REFLEX_TYPES,new HashSet<>(ids.stream().map(id->bank.get(id).family()).toList()));
        assertTrue(bank.sequence("REFLEX",1,13,4).stream().allMatch(id->bank.get(id).difficulty()<=1));
    }
    @Test void botProfileDistributionAndDifficulty(){
        int easy=0,king=0;
        for(int n=0;n<1000;n++){
            var e=KingService.botDecision("EASY",n,2,3,8);var k=KingService.botDecision("KING",n,2,3,8);
            if(e.correct())easy++;if(k.correct())king++;
            assertTrue(k.delay()<e.delay());
            assertTrue(KingService.botDecision("HARD",n,2,5,8).delay()>KingService.botDecision("HARD",n,2,1,8).delay());
        }
        assertTrue(king>easy);assertTrue(easy>300&&easy<700);assertTrue(king>700);
    }
    @Test void productionProfilesOverrideEngineeringFlag(){
        for(String profile:List.of("prod","production")){
            var env=new org.springframework.mock.env.MockEnvironment();env.setActiveProfiles(profile);
            var closed=new KingService(bank,mock(SimpMessagingTemplate.class),env,true);
            try{code("CONTENT_NOT_APPROVED",()->closed.act(1,"a","s",new KingService.Command("start",null,"REFLEX","SOLO",5,0,"KING",null,null,null,"1",null,null)));}
            finally{closed.close();}
        }
    }
    @Test void contentSpecificNegativeCases()throws Exception{
        var mapper=new ObjectMapper();
        for(var change:List.of(new String[]{"king-f-5","prompt","definitely"},new String[]{"king-f-11","canonical","unknown"},
            new String[]{"king-f-17","expression",""},new String[]{"king-f-19","expression",""},new String[]{"king-f-21","expression",""},new String[]{"king-f-25","expression",""})){
            var tree=(com.fasterxml.jackson.databind.node.ObjectNode)mapper.valueToTree(bank.get(change[0]));tree.put(change[1],change[2]);
            var mutated=mapper.treeToValue(tree,KingBank.Item.class);tree.put("fingerprint",KingBank.fingerprint(mutated));
            assertFalse(KingBank.validate(List.of(mapper.treeToValue(tree,KingBank.Item.class))).isEmpty(),Arrays.toString(change));
        }
        for(String id:List.of("king-f-13","king-f-15")){
            var tree=(com.fasterxml.jackson.databind.node.ObjectNode)mapper.valueToTree(bank.get(id));tree.putArray("relationSet");
            tree.put("fingerprint",KingBank.fingerprint(mapper.treeToValue(tree,KingBank.Item.class)));
            assertTrue(KingBank.validate(List.of(mapper.treeToValue(tree,KingBank.Item.class))).stream().anyMatch(e->e.endsWith("MISSING_RELATION")));
        }
    }
    @SuppressWarnings("unchecked") static Map<String,Object> map(Object value){return (Map<String,Object>)value;}
    @Test void soloReflexRevealsTheResolvedAnswerAndTheLearnersOwnSubmission(){
        var s=start("REFLEX","SOLO");var item=item(s);
        assertNull(s.get("lastResult"));
        var after=command(1,"s1","answer",s,null,null,"definitely-wrong",null,"solo-wrong");
        var last=map(after.get("lastResult"));
        assertEquals(0,last.get("slot"));assertEquals(false,last.get("correct"));assertEquals(true,last.get("revealed"));
        assertEquals("definitely-wrong",last.get("submitted"));
        assertEquals(item.canonical(),map(last.get("challenge")).get("answer"));assertEquals(item.meaning(),map(last.get("challenge")).get("meaning"));
        assertNotEquals(0,after.get("round"),"the next slot is live at once: feedback never holds the shared clock");
    }
    @Test void competitiveReflexWithholdsTheAnswerUntilTheOpponentResolvesThatSlot(){
        var s=pair("REFLEX","QUICK_MATCH");
        var mine=act(1,"ping",s);var item=item(mine);
        var after=command(1,"s1","answer",mine,null,null,item.canonical(),item.tokens().isEmpty()?null:correctOrder(item),"p1-first");
        var last=map(after.get("lastResult"));
        assertEquals(true,last.get("correct"));assertEquals(false,last.get("revealed"));
        assertFalse(map(last.get("challenge")).containsKey("answer"));assertFalse(map(last.get("challenge")).containsKey("meaning"));
        var theirs=act(2,"ping",s);
        assertEquals(0,theirs.get("round"));assertFalse(map(theirs.get("challenge")).containsKey("answer"));
        command(2,"s2","answer",theirs,null,null,"wrong-guess",null,"p2-first");
        var again=map(act(1,"ping",s).get("lastResult"));
        assertEquals(true,again.get("revealed"));assertEquals(item.canonical(),map(again.get("challenge")).get("answer"));
    }
    @Test void finishedReviewCarriesTheLearnersOwnSubmission(){
        var s=start("REORDER","SOLO");var item=item(s);
        var wrong=new ArrayList<>(correctOrder(item));Collections.reverse(wrong);
        if(KingBank.correct(item,null,wrong))Collections.swap(wrong,0,1);
        command(1,"s1","answer",s,null,null,null,wrong,"wrong-order");
        time.ms+=KingConfig.WRONG_LOCK_MS;
        var resolved=answer(1,act(1,"ping",s),"right-order");assertEquals(true,resolved.get("resolved"));
        assertEquals(2_500L,KingConfig.publicConfig().get("resolutionMs"));
        var finished=act(1,"leave",resolved);
        assertEquals("FINISHED",finished.get("status"));
        var first=map(((List<?>)finished.get("review")).getFirst());
        assertEquals(true,first.get("correct"));assertEquals(KingBank.normalize(item.canonical()),KingBank.normalize((String)first.get("submitted")));
    }
}

