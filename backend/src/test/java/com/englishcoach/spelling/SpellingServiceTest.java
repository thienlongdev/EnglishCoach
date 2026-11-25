package com.englishcoach.spelling;

import com.englishcoach.sentinel.*;
import org.junit.jupiter.api.*;
import java.time.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static com.englishcoach.spelling.SpellingProtocol.*;
import static com.englishcoach.spelling.SpellingRules.*;

class SpellingServiceTest {
    static class Time extends Clock {long t=100000;public ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(ZoneId z){return this;}public Instant instant(){return Instant.ofEpochMilli(t);}public long millis(){return t;}}
    Time time;SpellingService service;SentinelService sentinel;SpellingResults results;
    @BeforeEach void init(){time=new Time();var catalog=mock(SpellingCatalog.class);when(catalog.available()).thenReturn(true);
        when(catalog.choose(anyInt(),anySet())).thenAnswer(i->new SpellingCatalog.Word("ocean",i.getArgument(0),"test","",new SpellingCatalog.Clip("clip.wav",1000,"test")));
        results=mock(SpellingResults.class);when(results.name(anyLong())).thenAnswer(i->"User "+i.getArgument(0));when(results.save(any())).thenReturn(List.of("SCORE"));
        sentinel=new SentinelService(new SentinelStore(null){@Override public void write(SentinelAttempt.Change c){}@Override public void writeLater(SentinelAttempt.Change c){}},time);
        service=new SpellingService(catalog,results,mock(SpellingEvents.class),sentinel,time);
    }
    @AfterEach void close(){service.close();sentinel.close();}
    Command command(UUID room,Mode mode,String code,String text,String handle,UUID turn,Boolean ready){return new Command(UUID.randomUUID(),room,turn,mode,Difficulty.EASY,code,"LYRA","",text,handle,1L,null,null,null,ready,2);}
    String handle(long user){var b=sentinel.begin(user,SentinelPolicy.ECHO_SPELLING,true,1);return b.id()+"."+b.token();}
    State act(long u,String action,Command c){return service.act(u,"s"+u,action,c);}
    State spelling(UUID room,long user){State s=service.state(user,room);time.t=s.deadline()+1;service.tick();s=service.state(user,room);time.t=s.deadline()+1;service.tick();s=service.state(user,room);
        long speaker=Long.parseLong(s.turn().player());service.audio(speaker,room,s.turn().id());time.t+=1001;
        return act(speaker,"heard",command(room,null,null,null,null,s.turn().id(),null));}
    @Test void twoMembersCompleteAuthoritativeMatchAndCannotWriteEachOthersTurns()throws Exception{
        var a=act(1,"create",command(null,Mode.MULTIPLAYER,null,null,null,null,null));var b=act(2,"join",command(null,null,a.code(),null,null,null,null));
        assertEquals(a.roomId(),b.roomId());assertEquals("2",b.self());assertEquals(2,b.players().size());
        String h1=handle(1),h2=handle(2);act(1,"ready",command(a.roomId(),null,null,null,h1,null,true));act(2,"ready",command(a.roomId(),null,null,null,h2,null,true));
        act(1,"start",command(a.roomId(),null,null,null,h1,null,null));var turn=spelling(a.roomId(),1);
        assertThrows(Exception.class,()->act(2,"answer",command(a.roomId(),null,null,"ocean",h2,turn.turn().id(),null)));
        time.t+=800;var answer=command(a.roomId(),null,null,"ocean",h1,turn.turn().id(),null);act(1,"answer",answer);act(1,"answer",answer);
        assertEquals(1,service.state(1,a.roomId()).players().getFirst().correct());
        time.t=service.state(1,a.roomId()).deadline()+1;service.tick();var next=service.state(2,a.roomId());assertEquals("2",next.turn().player());
        time.t=next.deadline()+1;service.tick();next=service.state(2,a.roomId());service.audio(2,a.roomId(),next.turn().id());time.t+=1001;act(2,"heard",command(a.roomId(),null,null,null,h2,next.turn().id(),null));
        time.t+=800;act(2,"answer",command(a.roomId(),null,null,"wrong",h2,next.turn().id(),null));time.t=service.state(1,a.roomId()).deadline()+1;service.tick();
        assertEquals("1",service.state(1,a.roomId()).winner());
        for(int i=0;i<100&&!service.state(1,a.roomId()).saved();i++)Thread.sleep(10);
        assertTrue(service.state(1,a.roomId()).saved());verify(results,times(2)).save(any());
    }
    @Test void reconnectWithoutStrictSecretVoidsInsteadOfRestoringRankedAttempt(){String handle=handle(1);var s=act(1,"create",command(null,Mode.ENDLESS,null,null,handle,null,null));
        var recovered=service.act(1,"new-session","rejoin",command(s.roomId(),null,null,null,null,null,null));assertEquals(Phase.ABORTED,recovered.phase());assertEquals("VOIDED_RELOAD",recovered.players().getFirst().integrity());}
    @Test void reconnectWithSecretRetainsMatchAndRefusesOldSocket(){String handle=handle(1);var s=act(1,"create",command(null,Mode.ENDLESS,null,null,handle,null,null));
        var recovered=service.act(1,"new-session","rejoin",command(s.roomId(),null,null,null,handle,null,null));assertEquals(s.matchId(),recovered.matchId());
        assertThrows(Exception.class,()->act(1,"ping",command(s.roomId(),null,null,null,handle,null,null)));}
    @Test void audioAndRoomAreMembershipScoped(){var s=act(1,"create",command(null,Mode.PRACTICE,null,null,null,null,null));
        assertThrows(Exception.class,()->service.state(2,s.roomId()));assertThrows(Exception.class,()->service.audio(2,s.roomId(),UUID.randomUUID()));}
    @Test void strictModeCannotStartWithoutAcknowledgedAttempt(){assertThrows(Exception.class,()->act(1,"create",command(null,Mode.ENDLESS,null,null,null,null,null)));}
}
