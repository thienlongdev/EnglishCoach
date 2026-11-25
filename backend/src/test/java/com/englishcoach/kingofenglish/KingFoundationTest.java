package com.englishcoach.kingofenglish;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import java.nio.file.Path;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class KingFoundationTest {
    @Test void uniqueSelectionsFilteredTinyAndExhausted(){
        var bank=new KingBank();
        for(String mode:List.of("REORDER","REFLEX"))for(int level=0;level<=5;level++)for(int count:List.of(5,10,13,15,20)){
            var ids=bank.sequence(mode,level,count,123);
            assertEquals(ids.size(),new HashSet<>(ids).size());
            assertTrue(ids.size()<=count);
            for(var id:ids)assertTrue(levelCompatible(bank.get(id),level));
        }
        var only=bank.get("king-r-1");
        assertEquals(List.of(only.id()),KingContentSelector.sequence(List.of(only),"REORDER",0,20,1));
        assertEquals(List.of(),KingContentSelector.sequence(List.of(only),"REORDER",0,0,1));
        assertThrows(KingService.Rejection.class,()->KingContentSelector.sequence(List.of(),"REORDER",0,5,1));
    }
    private boolean levelCompatible(KingBank.Item i,int level){return level==0||i.difficulty()<=level;}
    @Test void shortenedCompetitiveMatchTerminatesAndSharesTruth(){
        var bank=new KingBank();var time=new KingServiceTest.Time();
        var game=new KingService(bank,mock(SimpMessagingTemplate.class),time,true);
        try{
            for(String flow:List.of("SOLO","ECHO","QUICK_MATCH","PRIVATE_ROOM")){
                var a=game.act(1,"p1","s1",cmd(flow.equals("QUICK_MATCH")?"quick":flow.equals("PRIVATE_ROOM")?"create":"start",null,flow));
                if(flow.equals("QUICK_MATCH")||flow.equals("PRIVATE_ROOM")){
                    game.act(2,"p2","s2",cmd(flow.equals("QUICK_MATCH")?"quick":"join",a,flow));
                    game.act(1,"p1","s1",cmd("ready",a,flow));game.act(2,"p2","s2",cmd("ready",a,flow));
                }
                a=game.act(1,"p1","s1",cmd("ping",a,flow));
                int actual=(Integer)a.get("count");assertTrue(actual<20);
                var seen=new HashSet<String>();
                while(a.get("status").equals("PLAYING")){
                    @SuppressWarnings("unchecked") var challenge=(Map<String,Object>)a.get("challenge");
                    assertTrue(seen.add((String)challenge.get("id")));
                    if(flow.equals("SOLO")){
                        time.ms+=KingConfig.REORDER_MS;game.tick();
                        a=game.act(1,"p1","s1",cmd("next",a,flow));
                    }else{time.ms+=KingConfig.REORDER_MS;game.tick();time.ms+=KingConfig.RESOLUTION_MS;game.tick();}
                    a=game.act(1,"p1","s1",cmd("ping",a,flow));
                }
                assertEquals(actual,seen.size());
                game.act(1,"p1","s1",cmd("leave",a,flow));
                if(flow.equals("QUICK_MATCH")||flow.equals("PRIVATE_ROOM"))game.act(2,"p2","s2",cmd("leave",a,flow));
            }
        }finally{game.close();}
    }
    private KingService.Command cmd(String action,Map<String,Object> s,String flow){
        return new KingService.Command(action,s==null?null:(String)s.get("roomCode"),"REORDER",flow,20,1,"MEDIUM",
            s==null?null:(String)s.get("matchId"),s==null?null:(Integer)s.get("round"),s==null?null:(Long)s.get("inputRevision"),UUID.randomUUID().toString(),null,null);
    }
    @Test void realistic500PvPRoomsBeforeNewEngines()throws Exception{
        var time=new KingServiceTest.Time();
        var game=new KingService(new KingBank(),mock(SimpMessagingTemplate.class),time,true);
        var rt=Runtime.getRuntime();var report=new LinkedHashMap<String,Object>();
        try{
            System.gc();report.put("baseline",game.memoryState());report.put("heapBaseline",rt.totalMemory()-rt.freeMemory());
            var field=KingService.class.getDeclaredField("rooms");field.setAccessible(true);
            @SuppressWarnings("unchecked") var registry=(Map<String,KingService.Room>)field.get(game);
            for(int n=0;n<500;n++){
                long host=n*2L+1,guest=host+1;
                var s=game.act(host,"p"+host,"s"+host,cmd("create",null,"PRIVATE_ROOM"));
                game.act(guest,"p"+guest,"s"+guest,cmd("join",s,"PRIVATE_ROOM"));
                game.act(host,"p"+host,"s"+host,cmd("ready",s,"PRIVATE_ROOM"));
                game.act(guest,"p"+guest,"s"+guest,cmd("ready",s,"PRIVATE_ROOM"));
                var r=registry.get(s.get("roomCode"));
                // Populate REAL retained types to a realistic high-water state. No unrelated buffers.
                r.round=Math.min(2,r.ids.size()-1);
                for(var p:r.players.values()){
                    p.score=2;p.completed=2;p.responseMs=12_000;p.revision=3;p.rematch=true;
                    p.correct.add(0);p.missed.add(1);p.queue.poll();p.queue.poll();
                    for(int receipt=0;receipt<128;receipt++)r.receipts.add(p.id+":"+UUID.randomUUID());
                }
                if(n==99){report.put("realisticRooms100",game.memoryState());report.put("heap100",rt.totalMemory()-rt.freeMemory());}
            }
            report.put("realisticRoomsMax",game.memoryState());report.put("heapPeak",rt.totalMemory()-rt.freeMemory());
            assertEquals(1000,game.memoryState().get("memberships"));assertEquals(128000,game.memoryState().get("receipts"));
            assertThrows(KingService.Rejection.class,()->game.act(1001,"p1001","s1001",cmd("create",null,"PRIVATE_ROOM")));
            for(var r:registry.values())for(var p:r.players.values())KingRoundEngine.finish(r,"SYNTHETIC_FINISH",null,time.ms);
            report.put("afterFinish",game.memoryState());report.put("heapAfterFinish",rt.totalMemory()-rt.freeMemory());
            time.ms+=KingConfig.FINISH_TTL;game.tick();System.gc();report.put("afterCleanup",game.memoryState());
            report.put("heapAfterCleanup",rt.totalMemory()-rt.freeMemory());assertEquals(0,game.memoryState().get("rooms"));assertEquals(0,game.memoryState().get("memberships"));
            report.put("roomCap",KingConfig.ROOM_CAP);report.put("receiptCap",KingConfig.RECEIPT_CAP);
            report.put("method","One JVM; 500 real two-human ready rooms, actual bounded state types populated synthetically; explicit GC requests, approximate observed live heap.");
            report.put("limitations","No exact per-room memory, host fit, throughput or production capacity inference. New engines not included in this pre-engine baseline.");
            String dir=System.getProperty("king.evidenceDir");if(dir!=null)new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(Path.of(dir,"memory-before-engines.json").toFile(),report);
        }finally{game.close();}
    }
}
