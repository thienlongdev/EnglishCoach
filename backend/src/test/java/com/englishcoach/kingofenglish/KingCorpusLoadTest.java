package com.englishcoach.kingofenglish;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class KingCorpusLoadTest {
    @org.junit.jupiter.api.io.TempDir Path evidenceDir;
    static long heap(){System.gc();return Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory();}
    static KingService.Command command(String action,Map<String,Object> state,String mode){return new KingService.Command(action,state==null?null:(String)state.get("roomCode"),mode,"PRIVATE_ROOM",20,0,"KING",null,null,null,UUID.randomUUID().toString(),null,null);}
    @Test void actualPreview500MixedRoomsBoundedCacheCleanupExpiryAndLatency()throws Exception{
        var report=new LinkedHashMap<String,Object>();var time=new KingServiceTest.Time();report.put("baselineBytes",heap());
        try(var corpus=new KingCorpus("REVIEW_PREVIEW",time,true)){
            report.putAll(corpus.initializationMemory());
            report.put("afterProviderAndIndexesBytes",heap());report.put("providerCounts",corpus.counts());
            @SuppressWarnings("unchecked") var boardWords=(Map<String,List<String>>)(Map<?,?>)new ObjectMapper().readValue(new org.springframework.core.io.ClassPathResource("king/preview-board-memory-words.json").getInputStream(),Map.class);
            var lookup=new ArrayList<Long>();var selection=new ArrayList<Long>();var recent=new KingRecentContent(time);
            for(int n=0;n<1000;n++){
                var entry=corpus.entries("REFLEX").get(n);long at=System.nanoTime();corpus.get(entry.id());lookup.add(System.nanoTime()-at);
                at=System.nanoTime();recent.select(corpus,"REFLEX",0,13,n,List.of(99999L));selection.add(System.nanoTime()-at);
            }
            report.put("lookup",KingPhase4QualificationTest.percentiles(lookup));report.put("selection",KingPhase4QualificationTest.percentiles(selection));report.put("afterWarmBytes",heap());
            try(varGame game=new varGame(corpus,new SimpMessagingTemplate((message,timeout)->true),time)){
                var field=KingService.class.getDeclaredField("rooms");field.setAccessible(true);
                @SuppressWarnings("unchecked") var rooms=(Map<String,KingService.Room>)field.get(game.service);
                for(int n=0;n<500;n++){
                    long host=n*2L+1,guest=host+1;String mode=List.of("REORDER","REFLEX","EXPLAIN","CONQUEST").get(n%4);
                    var s=game.service.act(host,"p"+host,"s"+host,command("create",null,mode));game.service.act(guest,"p"+guest,"s"+guest,command("join",s,mode));
                    game.service.act(host,"p"+host,"s"+host,command("ready",s,mode));game.service.act(guest,"p"+guest,"s"+guest,command("ready",s,mode));
                    var room=rooms.get(s.get("roomCode"));for(int x=0;x<256;x++)room.receipts.add("receipt"+x);
                    if(room.explain!=null){for(int x=0;x<8;x++)room.explain.clues.add("A source-backed clue used for retained-state load measurement. ".repeat(6));room.players.keySet().forEach(id->room.explain.attempts.put(id,12));}
                    if(room.conquest!=null){for(String word:boardWords.get(room.conquest.boardId)){assertTrue(corpus.wordEligible(word));room.conquest.used.add(new String(word.toCharArray()));}for(int x=0;x<25;x++)room.conquest.owners[x]=x%2==0?host:guest;room.conquest.wordPoints.put(host,20);room.conquest.wordPoints.put(guest,20);}
                    if(n==99){report.put("rooms100Bytes",heap());report.put("rooms100",game.service.memoryState());}
                }
                report.put("rooms500Bytes",heap());report.put("rooms500",game.service.memoryState());assertEquals(500,game.service.memoryState().get("rooms"));
                for(var room:rooms.values())KingRoundEngine.finish(room,"LOAD_TEST",null,time.ms);
                time.ms+=KingConfig.FINISH_TTL;game.service.tick();assertEquals(0,game.service.memoryState().get("rooms"));report.put("afterCleanupBytes",heap());
                time.ms+=KingRecentContent.TTL;recent.expire();game.service.tick();assertEquals(0,game.service.memoryState().get("recentusers"));assertEquals(0,corpus.cacheState().get("entries"));
                report.put("afterExpiryBytes",heap());report.put("afterExpiry",game.service.memoryState());report.put("cache",corpus.cacheState());
            }
        }
        report.put("method","One JVM. Artifact providers/indexes shared. 500 two-human mixed rooms, 256 receipts each, 8 near-cap retained clues and two 12-guess counters for Explain; Conquest retains up to 179 independently solver-verified words, distinct per-room strings, ownership and capped word scores. The measurement harness retains the source word fixture separately. Explicit GC requests; JVM live heap only, native SQLite/process RSS excluded. No production capacity claim.");
        Path out=evidenceDir.resolve("preview-load.json");new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(out.toFile(),report);
    }
    static final class varGame implements AutoCloseable {final KingService service;varGame(KingCorpus c,SimpMessagingTemplate t,java.time.Clock clock){service=new KingService(c,t,clock);}public void close(){service.close();}}
}
