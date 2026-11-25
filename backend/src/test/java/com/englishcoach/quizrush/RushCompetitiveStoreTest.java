package com.englishcoach.quizrush;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * Production regression (owner report 2026-10-25: multiplayer stalls, running in place, backward snaps). The production
 * database is ~0.1 s away per statement; room writes used to run inside the one room lock, so every write froze every race.
 * Here each write takes 600 ms: ticks and movement input must still be served at once while writes are in flight.
 */
class RushCompetitiveStoreTest {
    static final long WRITE_MS=600;
    static class SlowRepository extends RushCompetitiveRepository {
        final AtomicInteger writes=new AtomicInteger();final AtomicBoolean fail=new AtomicBoolean();
        SlowRepository(){super(null,new ObjectMapper(),mock(PlatformTransactionManager.class));}
        @Override public void write(Stored room){sleep();writes.incrementAndGet();if(fail.get())throw new IllegalStateException("fixture storage unavailable");}
        @Override public void writeRematch(Stored a,Stored b){sleep();writes.addAndGet(2);}
        @Override public RushCompetitiveService.Room byRequest(long user,UUID id){return null;}
        @Override public List<RushCompetitiveService.Room> recover(){return List.of();}
        static void sleep(){try{Thread.sleep(WRITE_MS);}catch(InterruptedException e){Thread.currentThread().interrupt();}}
    }
    private static RushCompetitiveService service(SlowRepository repo,RushCompetitivePersistenceTest.Time time,ExecutorService store){
        var questions=mock(RushQuestions.class);when(questions.available()).thenReturn(true);when(questions.version()).thenReturn("test");when(questions.select(any(),anySet(),anyLong())).thenReturn(RushCompetitionTest.race(2).questions);
        return new RushCompetitiveService(questions,repo,mock(SimpMessagingTemplate.class),time,user->Set.of(),store);
    }
    private static long millis(Runnable work){long t=System.nanoTime();work.run();return (System.nanoTime()-t)/1_000_000;}

    @Test @SuppressWarnings("unchecked") void writesNeverHoldTheRoomLock()throws Exception{
        var repo=new SlowRepository();var time=new RushCompetitivePersistenceTest.Time();var store=Executors.newFixedThreadPool(2);
        var service=service(repo,time,store);
        // A command waits for its own write (durable before its acknowledgement)…
        var bots=new RushCompetitiveService.Command(null,null,UUID.randomUUID(),new RushCompetitiveService.Setup("EASY","MIXED",3,"MEDIUM"),null,null,null,null,null,null,null);
        var room=service.act(1,"fixture1","socket1","bots",bots);assertTrue(repo.writes.get()>=1);
        for(int i=0;i<70;i++){time.ms+=50;service.tick(.05);}assertEquals("RUNNING",service.get(1,(UUID)room.get("roomId")).get("status"));
        // …but a periodic save (every 5 s) is handed to the store: the tick returns at once.
        time.ms+=5001;long tick=millis(()->service.tick(.05));assertTrue(tick<150,"tick held by a write: "+tick+" ms");
        // While that write is in flight, movement input and further ticks are served without waiting for it.
        long input=millis(()->service.act(1,"fixture1","socket1","input",RushCompetitivePersistenceTest.command(room,null,null,null,null,new RushCompetition.Input(0,0,null,false,0,0,1),null,null)));
        assertTrue(input<150,"input held by a write: "+input+" ms");
        long ticks=millis(()->{for(int i=0;i<5;i++){time.ms+=50;service.tick(.05);}});assertTrue(ticks<300,"ticks held by a write: "+ticks+" ms");
        // Another room's command write (600 ms) runs beside the race: ticks keep their pace meanwhile.
        var other=CompletableFuture.supplyAsync(()->service.act(2,"fixture2","socket2","bots",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),new RushCompetitiveService.Setup("EASY","MIXED",3,"MEDIUM"),null,null,null,null,null,null,null)));
        Thread.sleep(100);long during=millis(()->{for(int i=0;i<5;i++){time.ms+=50;service.tick(.05);}});assertTrue(during<300,"ticks held by another room's write: "+during+" ms");
        assertNotNull(other.get(5,TimeUnit.SECONDS).get("roomId"));
        store.shutdown();assertTrue(store.awaitTermination(5,TimeUnit.SECONDS));service.close();
    }

    @Test void aFailedBackgroundWritePausesTheRoomUntilALaterWriteSucceeds()throws Exception{
        var repo=new SlowRepository();var time=new RushCompetitivePersistenceTest.Time();var store=Executors.newSingleThreadExecutor();
        var service=service(repo,time,store);
        var room=service.act(1,"fixture1","socket1","create",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),new RushCompetitiveService.Setup("EASY","MIXED",3,null),null,null,null,null,null,null,null));UUID id=(UUID)room.get("roomId");
        repo.fail.set(true);time.ms+=5001;service.tick(.05);Thread.sleep(WRITE_MS+300);
        assertEquals("PERSISTENCE_UNAVAILABLE",service.get(1,id).get("recovery"));
        assertThrows(RushException.class,()->RushCompetitivePersistenceTest.act(service,1,"ready",room));
        repo.fail.set(false);time.ms+=1001;service.tick(.05);Thread.sleep(WRITE_MS+300);
        assertEquals("",service.get(1,id).get("recovery"));
        store.shutdown();assertTrue(store.awaitTermination(5,TimeUnit.SECONDS));service.close();
    }
}
