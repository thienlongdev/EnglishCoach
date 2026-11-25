package com.englishcoach.kingofenglish;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
class KingPeakMemoryTest {
    @org.junit.jupiter.api.io.TempDir Path evidenceDir;
    KingService.Command command(String action,Map<String,Object> state,String mode){
        return new KingService.Command(action,state==null?null:(String)state.get("roomCode"),mode,"PRIVATE_ROOM",20,0,"KING",
            state==null?null:(String)state.get("matchId"),state==null?null:(Integer)state.get("round"),state==null?null:(Long)state.get("inputRevision"),UUID.randomUUID().toString(),null,null);
    }
    @Test void full500PvPRoomsAllEnginesAndCleanup()throws Exception{
        Path evidence=evidenceDir;
        var mapper=new ObjectMapper();
        @SuppressWarnings("unchecked") var usedWords=(Map<String,List<String>>)(Map<?,?>)mapper.readValue(new org.springframework.core.io.ClassPathResource("king/board-memory-words.json").getInputStream(),Map.class);
        var time=new KingServiceTest.Time();var boards=new KingConquestBank();var lexicon=KingConquestTest.localLexicon();
        var transport=new SimpMessagingTemplate((message,timeout)->true); // No Mockito invocation retention distorting heap.
        var game=new KingService(new KingBank(),new KingExplainBank(),boards,lexicon,transport,time,true);
        var rt=Runtime.getRuntime();var report=new LinkedHashMap<String,Object>();
        try{
            System.gc();report.put("baseline",game.memoryState());report.put("heapBaseline",rt.totalMemory()-rt.freeMemory());
            var field=KingService.class.getDeclaredField("rooms");field.setAccessible(true);
            @SuppressWarnings("unchecked") var registry=(Map<String,KingService.Room>)field.get(game);
            for(int n=0;n<500;n++){
                String mode=List.of("REORDER","REFLEX","EXPLAIN","CONQUEST").get(n%4);long host=2L*n+1,guest=host+1;
                var s=game.act(host,"p"+host,"s"+host,command("create",null,mode));
                game.act(guest,"p"+guest,"s"+guest,command("join",s,mode));
                game.act(host,"p"+host,"s"+host,command("ready",s,mode));game.act(guest,"p"+guest,"s"+guest,command("ready",s,mode));
                var r=registry.get(s.get("roomCode"));
                for(var p:r.players.values()){
                    p.score=12;p.completed=3;p.responseMs=14_000;p.revision=4;p.rematch=true;
                    p.correct.addAll(List.of(0,1));p.missed.add(2);p.queue.poll();p.queue.poll();p.queue.poll();
                    for(int receipt=0;receipt<128;receipt++)r.receipts.add(p.id+":"+UUID.randomUUID());
                }
                if(r.explain!=null){
                    r.round=3;
                    for(int clue=0;clue<KingConfig.EXPLAIN_CLUE_CAP;clue++)r.explain.clues.add("Think about the ordinary object and how people use it. ".repeat(7));
                    r.players.keySet().forEach(id->r.explain.attempts.put(id,KingConfig.EXPLAIN_GUESS_CAP));
                }else if(r.conquest!=null){
                    // Real locally solved words for this board; near the cap, no unrelated garbage.
                    r.conquest.used.addAll(usedWords.get(r.conquest.boardId));
                    for(int cell=0;cell<25;cell++)r.conquest.owners[cell]=cell%2==0?host:guest;
                    r.conquest.wordPoints.put(host,20);r.conquest.wordPoints.put(guest,20);
                    r.conquest.longest.put(host,8);r.conquest.longest.put(guest,8);
                    var last=boards.get(r.conquest.boardId).echoCandidates().getFirst();r.conquest.lastWord=last.word();r.conquest.lastPath=last.path();r.conquest.lastPlayer=host;
                }else{r.round=3;}
                if(n==99){System.gc();report.put("realisticRooms100",game.memoryState());report.put("heap100",rt.totalMemory()-rt.freeMemory());}
            }
            System.gc();report.put("realisticRoomsMax",game.memoryState());report.put("heapPeak",rt.totalMemory()-rt.freeMemory());
            assertEquals(1000,game.memoryState().get("memberships"));assertEquals(128000,game.memoryState().get("receipts"));assertEquals(125,game.memoryState().get("conquestBoards"));
            assertTrue(game.memoryState().get("usedWords")>=125*150);assertEquals(1000,game.memoryState().get("explainClues"));
            for(var r:registry.values())KingRoundEngine.finish(r,"SYNTHETIC_FINISH",null,time.ms);
            report.put("afterFinish",game.memoryState());report.put("heapAfterFinish",rt.totalMemory()-rt.freeMemory());
            time.ms+=KingConfig.FINISH_TTL;game.tick();System.gc();report.put("afterCleanup",game.memoryState());report.put("heapAfterCleanup",rt.totalMemory()-rt.freeMemory());
            assertTrue(game.memoryState().values().stream().allMatch(n->n==0));
            report.put("roomCap",KingConfig.ROOM_CAP);report.put("receiptCap",KingConfig.RECEIPT_CAP);report.put("explainClueCap",KingConfig.EXPLAIN_CLUE_CAP);
            report.put("explainGuessCap",KingConfig.EXPLAIN_GUESS_CAP);report.put("conquestUsedWordCap",KingConfig.CONQUEST_WORD_CAP);
            report.put("method","One JVM, 125 two-human rooms per mode, real lifecycle and retained state types, full ID queues, 256 receipts each, 8 near-max text clues, two 12-guess counters, Conquest 150-170 actual solver-verified words and 25 ownership values. Non-retaining transport. Explicit GC requests; used-word evidence map and shared content/lexicon remain in baseline.");
            report.put("limitations","Approximate live heap observations, not object-size/per-room estimates. Synthetic high state, not concurrent throughput or host/container qualification. Production capacity UNVERIFIED.");
            mapper.writerWithDefaultPrettyPrinter().writeValue(evidence.resolve("memory-peak.json").toFile(),report);
        }finally{game.close();}
    }
}
