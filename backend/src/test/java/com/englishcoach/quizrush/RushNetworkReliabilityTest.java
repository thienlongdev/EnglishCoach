package com.englishcoach.quizrush;

import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.flashcard.pvp.security.StompAuthChannelInterceptor;
import com.englishcoach.flashcard.pvp.service.CardBlastPvPService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.MessageBuilder;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.transaction.PlatformTransactionManager;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Codex audit 2026-10-25, reproduced and closed:
 * - one room's database work never stalls another room: the question-exposure read of a new race and the paired rematch
 *   write used to run inside the one room lock (another room's input waited 606 ms, its tick 605 ms);
 * - the transport keeps a legitimate Rush cadence: the shared 30 messages / s STOMP limit dropped 5 of 35 without a word;
 * - an older lease overtaken by a newer one is stale, not an error; the snapshot carries what the browser replays from.
 */
class RushNetworkReliabilityTest {
    static final long SLOW_MS=600;
    /** Writes are instant except a rematch pair (slow); `room` is served for reads of rooms not in memory. */
    static class Repository extends RushCompetitiveRepository {
        volatile RushCompetitiveService.Room room;final AtomicInteger rematches=new AtomicInteger();
        Repository(){super(null,new ObjectMapper(),mock(PlatformTransactionManager.class));}
        @Override public void write(Stored s){}
        @Override public void writeRematch(Stored a,Stored b){sleep();rematches.incrementAndGet();}
        @Override public RushCompetitiveService.Room byRequest(long user,UUID id){return null;}
        @Override public List<RushCompetitiveService.Room> recover(){return List.of();}
        @Override public RushCompetitiveService.Room get(long user,UUID id){var r=room;if(r!=null&&r.id.equals(id))return r;throw new RushException(404,"ROOM_NOT_FOUND");}
    }
    static void sleep(){try{Thread.sleep(SLOW_MS);}catch(InterruptedException e){Thread.currentThread().interrupt();}}
    static long millis(Runnable work){long t=System.nanoTime();work.run();return (System.nanoTime()-t)/1_000_000;}
    static RushCompetitiveService service(Repository repo,RushCompetitivePersistenceTest.Time time,RushExposure exposure){
        var questions=mock(RushQuestions.class);when(questions.available()).thenReturn(true);when(questions.version()).thenReturn("test");
        when(questions.select(any(),anySet(),anyLong())).thenReturn(RushCompetitionTest.race(2).questions);
        return new RushCompetitiveService(questions,repo,mock(SimpMessagingTemplate.class),time,exposure,Runnable::run);
    }
    static RushCompetitiveService.Command bots(){return new RushCompetitiveService.Command(null,null,UUID.randomUUID(),new RushCompetitiveService.Setup("EASY","MIXED",3,"MEDIUM"),null,null,null,null,null,null,null);}
    /** A running Echo Bots race of account 1 (ticks past the countdown). */
    @SuppressWarnings("unchecked") static Map<String,Object> race(RushCompetitiveService service,RushCompetitivePersistenceTest.Time time){
        var room=service.act(1,"fixture1","socket1","bots",bots());
        for(int i=0;i<70;i++){time.ms+=50;service.tick(.05);}assertEquals("RUNNING",service.get(1,(UUID)room.get("roomId")).get("status"));return room;
    }
    static void input(RushCompetitiveService service,Map<String,Object> room,long seq){service.act(1,"fixture1","socket1","input",RushCompetitivePersistenceTest.command(room,null,null,null,null,new RushCompetition.Input(seq,0,null,false,0,0,1),null,null));}

    @Test void aNewRaceReadsItsQuestionExposureOutsideTheRoomLock()throws Exception{
        var repo=new Repository();var time=new RushCompetitivePersistenceTest.Time();
        var service=service(repo,time,user->{if(user==2)sleep();return Set.of();});
        var room=race(service,time);
        var other=CompletableFuture.supplyAsync(()->service.act(2,"fixture2","socket2","bots",bots()));
        Thread.sleep(100);
        long in=millis(()->input(service,room,0)),ticks=millis(()->{for(int i=0;i<5;i++){time.ms+=50;service.tick(.05);}});
        assertTrue(in<150,"input waited for another account's exposure read: "+in+" ms");
        assertTrue(ticks<300,"ticks waited for another account's exposure read: "+ticks+" ms");
        assertNotNull(other.get(5,TimeUnit.SECONDS).get("roomId"));
        @SuppressWarnings("unchecked") var metrics=service.metrics();assertTrue(((Number)metrics.get("maxInputLockWaitMicros")).doubleValue()<150_000,"metrics: "+metrics);
        assertTrue(((Number)metrics.get("maxTickLockWaitMicros")).doubleValue()<150_000,"metrics: "+metrics);service.close();
    }

    /** Fixture 2026-10-26: the first Echo Bots creation held the lock 1.96 s (question selection + course plan inside it). */
    @Test void aNewRaceIsSelectedAndPlannedOutsideTheRoomLock()throws Exception{
        var repo=new Repository();var time=new RushCompetitivePersistenceTest.Time();var slow=new java.util.concurrent.atomic.AtomicBoolean();
        var questions=mock(RushQuestions.class);when(questions.available()).thenReturn(true);when(questions.version()).thenReturn("test");
        when(questions.select(any(),anySet(),anyLong())).thenAnswer(a->{if(slow.get())sleep();return RushCompetitionTest.race(2).questions;});
        var service=new RushCompetitiveService(questions,repo,mock(SimpMessagingTemplate.class),time,u->Set.of(),Runnable::run);
        var room=race(service,time);slow.set(true);
        var other=CompletableFuture.supplyAsync(()->service.act(2,"fixture2","socket2","bots",bots()));
        Thread.sleep(100);
        long in=millis(()->input(service,room,0)),ticks=millis(()->{for(int i=0;i<5;i++){time.ms+=50;service.tick(.05);}});
        assertTrue(in<150,"input waited for another race's preparation: "+in+" ms");assertTrue(ticks<300,"ticks waited for another race's preparation: "+ticks+" ms");
        assertNotNull(other.get(5,TimeUnit.SECONDS).get("roomId"));service.close();
    }

    @Test @SuppressWarnings("unchecked") void aRematchWritesBothRoomsOutsideTheRoomLock()throws Exception{
        var repo=new Repository();var time=new RushCompetitivePersistenceTest.Time();var service=service(repo,time,user->Set.of());
        var room=race(service,time);
        // Account 2's finished Echo Bots race (read from the store, as after a restart).
        var finished=new RushCompetitiveService.Room();finished.id=UUID.randomUUID();finished.owner=2;finished.mode="BOTS";finished.setup=new RushCompetitiveService.Setup("EASY","MIXED",3,"MEDIUM");
        finished.createdAt=finished.updatedAt=finished.savedAt=time.ms;finished.invitation="0".repeat(32);
        finished.race=new RushCompetition.Race(RushCompetitionTest.race(2).questions,7,"EASY",RushCompetition.HARDCORE);finished.race.contentVersion="test";finished.race.status="FINISHED";
        var human=new RushCompetition.Racer("p1",2L,"Explorer 1",null);var bot=new RushCompetition.Racer("p2",null,"Echo 1","MEDIUM");
        for(var p:List.of(human,bot)){p.phase="FINISHED";p.ready=true;finished.race.racers.add(p);}
        repo.room=finished;
        var view=Map.<String,Object>of("roomId",finished.id,"matchId",finished.race.matchId);
        service.act(2,"fixture2","socket2","rejoin",RushCompetitivePersistenceTest.command(view,UUID.randomUUID(),null,null,null,null,null,null));
        var rematch=CompletableFuture.supplyAsync(()->service.act(2,"fixture2","socket2","rematch",RushCompetitivePersistenceTest.command(view,UUID.randomUUID(),null,null,null,null,null,null)));
        Thread.sleep(100);
        long in=millis(()->input(service,room,0)),ticks=millis(()->{for(int i=0;i<5;i++){time.ms+=50;service.tick(.05);}});
        assertTrue(in<150,"input waited for another room's rematch write: "+in+" ms");assertTrue(ticks<300,"ticks waited for another room's rematch write: "+ticks+" ms");
        var next=rematch.get(5,TimeUnit.SECONDS);assertEquals(1,repo.rematches.get(),"one paired write");assertNotEquals(finished.race.matchId,next.get("matchId"));
        service.close();
    }

    @Test void anOlderLeaseOvertakenByANewerOneIsStaleNotAnError(){
        var r=RushCompetitionTest.race(2);var p=r.racers.getFirst();
        RushCompetition.input(r,p,new RushCompetition.Input(5,1,null,false,0,0,1));
        assertDoesNotThrow(()->RushCompetition.input(r,p,new RushCompetition.Input(4,-1,null,true,0,0,0)),"seq 4 arrived after seq 5");
        assertEquals(1,p.horizontal);assertEquals(5,p.lastSeq);
        // A replay of an applied lease with different content is still refused.
        assertThrows(RushException.class,()->RushCompetition.input(r,p,new RushCompetition.Input(5,-1,null,false,0,0,1)));
    }

    @Test @SuppressWarnings("unchecked") void theSnapshotCarriesTheReplayStartOfItsOwnRacerOnly(){
        var repo=new Repository();var time=new RushCompetitivePersistenceTest.Time();var service=service(repo,time,user->Set.of());
        var room=race(service,time);input(service,room,0);
        var view=service.get(1,(UUID)room.get("roomId"));var personal=(Map<String,Object>)view.get("personal");
        assertTrue(personal.containsKey("inputAt")&&personal.containsKey("jumpAt")&&personal.containsKey("landAt"));
        assertTrue(((Number)personal.get("inputAt")).doubleValue()>=0,"the lease's race time");
        for(var player:(List<Map<String,Object>>)view.get("players"))assertFalse(player.containsKey("inputAt")||player.containsKey("jumpAt"),"never another racer's timing");
        service.close();
    }

    /** The STOMP edge, then the room service: a legitimate second of Rush traffic passes whole; a flood stays bounded. */
    @Test void aLegitimateRushCadencePassesTheTransportAndTheService()throws Exception{
        var interceptor=new StompAuthChannelInterceptor(mock(JwtDecoder.class),mock(CustomJwtAuthenticationConverter.class),mock(CardBlastPvPService.class));
        var user=new UsernamePasswordAuthenticationToken(new UserDetailsImpl(1L,"u@test","p",List.of()),null,List.of());
        var channel=mock(MessageChannel.class);
        var repo=new Repository();var time=new RushCompetitivePersistenceTest.Time();var service=service(repo,time,u->Set.of());var room=race(service,time);
        // One browser second: 30 leases (the client's own ceiling), a ping and a dash, all inside the same second.
        int passed=0;long seq=0;
        for(int i=0;i<32;i++){
            String action=i==30?"ping":i==31?"dash":"input";
            if(interceptor.preSend(frame("rush-session","/app/quiz-rush/"+action,user),channel)==null)continue;passed++;
            if(action.equals("input"))input(service,room,seq++);else service.act(1,"fixture1","socket1",action,RushCompetitivePersistenceTest.command(room,UUID.randomUUID(),null,null,null,null,null,null));
        }
        assertEquals(32,passed,"no legitimate Rush frame dropped at the edge");
        // Another session's ordinary traffic keeps the shared 30 a second.
        int other=0;for(int i=0;i<35;i++)if(interceptor.preSend(frame("pvp-session","/app/pvp/answer",user),channel)!=null)other++;
        assertEquals(30,other);
        // A flood on the Rush namespace is still bounded per session.
        int flood=0;for(int i=0;i<200;i++)if(interceptor.preSend(frame("flood-session","/app/quiz-rush/input",user),channel)!=null)flood++;
        assertEquals(64,flood);
        service.close();
    }
    private static Message<byte[]> frame(String session,String destination,UsernamePasswordAuthenticationToken user){
        var h=StompHeaderAccessor.create(StompCommand.SEND);h.setSessionId(session);h.setDestination(destination);h.setUser(user);h.setLeaveMutable(true);
        return MessageBuilder.createMessage(new byte[0],h.getMessageHeaders());
    }
}
