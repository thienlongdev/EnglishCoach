package com.englishcoach.studyspace;
import com.englishcoach.speaking.arena.*;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import java.nio.file.*;
import java.sql.*;
import java.time.*;
import java.util.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class StudyCompletionPostgresTest {
    static PostgreSQLContainer<?> pg;static JdbcTemplate jdbc;static TransactionTemplate tx;static StudyPlannerService planner;
    @BeforeAll static void setup()throws Exception{
        pg=new PostgreSQLContainer<>("postgres:17");pg.start();
        var raw=new DriverManagerDataSource(pg.getJdbcUrl(),pg.getUsername(),pg.getPassword());
        try(var c=raw.getConnection();var s=c.createStatement()){
            s.execute("CREATE TABLE public.users(id bigint primary key,name text); INSERT INTO public.users VALUES(1,'Host'),(2,'Learner'),(3,'Private learner')");
            for(String f:List.of("V94__database_runtime_least_privilege.sql","V110__study_space.sql","V111__study_time_blocks.sql"))s.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/"+f)));
            s.execute("ALTER ROLE english_coach_app PASSWORD 'local-study-test'");
        }
        var app=new DriverManagerDataSource(pg.getJdbcUrl(),"english_coach_app","local-study-test");jdbc=new JdbcTemplate(app);tx=new TransactionTemplate(new DataSourceTransactionManager(app));planner=new StudyPlannerService(jdbc);
    }
    @AfterAll static void close(){if(pg!=null)pg.stop();}
    static StudyPlannerService.Block input(String recurrence){return new StudyPlannerService.Block(null,null,"Reading",Instant.parse("2026-03-07T14:00:00Z"),Instant.parse("2026-03-07T15:30:00Z"),"America/New_York",recurrence,LocalDate.parse("2026-04-07"),"English","Notes",2,0,0);}
    @Test void plannerOwnershipRevisionAndDst(){
        var b=tx.execute(t->planner.save(1,null,input("DAILY")));
        assertThat(planner.calendar(2,b.start(),b.start().plusSeconds(86400))).isEmpty();
        assertThatThrownBy(()->tx.execute(t->planner.save(2,b.id(),input("NONE")))).isInstanceOf(StudySpaceException.class).hasMessage("NOT_FOUND");
        assertThatThrownBy(()->tx.execute(t->planner.save(1,b.id(),input("NONE")))).isInstanceOf(StudySpaceException.class).hasMessage("STALE_REVISION");
        var occurrences=planner.calendar(1,b.start(),b.start().plusSeconds(3*86400));
        assertThat(occurrences).hasSize(4);assertThat(occurrences.get(1).start()).isEqualTo(Instant.parse("2026-03-08T13:00:00Z"));
        assertThat(occurrences).allSatisfy(o->assertThat(o.start().atZone(ZoneId.of("America/New_York")).getHour()).isEqualTo(9));
    }
    @Test void foreignTaskAndFocusSessionCannotBeLinked(){
        UUID task=UUID.randomUUID(),session=UUID.randomUUID();
        jdbc.update("INSERT INTO study_tasks(id,user_id,title) VALUES(?,2,'private')",task);
        var i=input("NONE");var foreign=new StudyPlannerService.Block(null,task,i.title(),i.start(),i.end(),i.timeZone(),i.recurrence(),i.until(),i.project(),i.notes(),i.priority(),0,0);
        assertThatThrownBy(()->tx.execute(t->planner.save(1,null,foreign))).hasMessage("TASK_NOT_FOUND");
        var b=tx.execute(t->planner.save(1,null,i));
        jdbc.update("INSERT INTO study_focus_sessions(id,user_id,mode,status,planned_seconds,focused_seconds,started_at) VALUES(?,2,'COUNTDOWN','COMPLETED',1500,1500,now())",session);
        assertThatThrownBy(()->tx.executeWithoutResult(t->planner.link(1,b.id(),session))).hasMessage("NOT_FOUND");
        jdbc.update("UPDATE study_focus_sessions SET user_id=1 WHERE id=?",session);
        tx.executeWithoutResult(t->planner.link(1,b.id(),session));tx.executeWithoutResult(t->planner.link(1,b.id(),session));
        assertThat(planner.blocks(1).stream().filter(x->x.id().equals(b.id())).findFirst().orElseThrow().focusedSeconds()).isEqualTo(1500);
        tx.executeWithoutResult(t->planner.delete(1,b.id()));
        assertThat(jdbc.queryForObject("SELECT count(*) FROM study_focus_sessions WHERE id=?",Integer.class,session)).isEqualTo(1);
    }
    static class Time extends Clock{long ms=Instant.parse("2026-11-02T00:00:00Z").toEpochMilli();public ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(ZoneId z){return this;}public Instant instant(){return Instant.ofEpochMilli(ms);}}
    @Test void roomPermissionTimerPresenceAndRevocation(){
        var voice=mock(ArenaVoice.class);var usage=mock(ArenaUsage.class);when(voice.available()).thenReturn(true);when(usage.configured()).thenReturn(true);when(voice.token(anyString(),anyString(),anyBoolean())).thenReturn("test-ticket");when(voice.url()).thenReturn("wss://test.livekit.cloud");var clock=new Time();
        var service=new StudySharedService(voice,usage,jdbc,clock);
        try{
            var created=service.create(1,"Study",2);UUID id=created.room().id();
            assertThatThrownBy(()->service.heartbeat(3,id)).hasMessage("ROOM_NOT_FOUND");
            var joined=service.join(2,created.invite());assertThat(joined.people()).hasSize(2);
            assertThatThrownBy(()->service.join(3,created.invite())).hasMessage("ROOM_FULL");
            assertThatThrownBy(()->service.timer(2,id,"start",25,joined.revision())).hasMessage("HOST_REQUIRED");
            var started=service.timer(1,id,"start",25,joined.revision());clock.ms+=10_000;
            assertThat(service.heartbeat(2,id).timer().deadline()).isEqualTo(started.timer().deadline());
            var ticket=service.ticket(2,id);assertThat(ticket.identity()).isNotBlank();verify(usage).open(anyString(),eq(ticket.identity()),eq(clock.ms));
            var muted=service.moderate(1,id,2,"mute");verify(voice).remove("ec-study-"+id,ticket.identity());assertThat(muted.people().stream().filter(x->x.id()==2).findFirst().orElseThrow().canSpeak()).isFalse();
            service.moderate(1,id,2,"remove");assertThatThrownBy(()->service.join(2,created.invite())).hasMessage("ROOM_NOT_FOUND");
            clock.ms+=121_000;service.sweep();assertThat(service.current(1)).isNull();verify(voice).close("ec-study-"+id);
        }finally{service.shutdown();}
    }
    @Test void providerFailureLeavesDurableCleanupReceipt(){
        var voice=mock(ArenaVoice.class);var usage=mock(ArenaUsage.class);when(voice.available()).thenReturn(true);when(usage.configured()).thenReturn(true);
        var service=new StudySharedService(voice,usage,jdbc,new Time());var created=service.create(3,"Silent",2);
        doThrow(new RuntimeException("provider unavailable")).when(voice).create(anyString(),anyInt());
        assertThatThrownBy(()->service.ticket(3,created.room().id())).hasMessage("provider unavailable");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM study_shared_voice_rooms WHERE id=?",Integer.class,created.room().id())).isEqualTo(1);
        service.shutdown();
    }
}
