package com.englishcoach.quizrush;

import com.englishcoach.kingofenglish.KingCorpus;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import java.time.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class RushCompetitivePersistenceTest {
    static class Time extends Clock {long ms=1700000000000L;public ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(ZoneId z){return this;}public Instant instant(){return Instant.ofEpochMilli(ms);}}
    static final RushCompetitiveService.Setup SETUP=new RushCompetitiveService.Setup("EASY","MIXED",3,null);
    static RushCompetitiveService.Command command(Map<String,Object> s,UUID request,Boolean ready,String target,String skill,RushCompetition.Input input,UUID question,UUID option){return new RushCompetitiveService.Command(s==null?null:(UUID)s.get("roomId"),s==null?null:(UUID)s.get("matchId"),request,SETUP,null,ready,target,skill,input,question,option);}
    static Map<String,Object> act(RushCompetitiveService service,long user,String action,Map<String,Object> s){return service.act(user,"fixture"+user,"socket"+user,action,command(s,UUID.randomUUID(),true,null,null,null,null,null));}
    @Test @SuppressWarnings("unchecked") void durableRealSourceTwoThroughFiveFinishIsolationReplayRematchAndRestart()throws Exception {
        try(var pg=new PostgreSQLContainer<>("postgres:17");var corpus=new KingCorpus("REVIEW_PREVIEW")){
            pg.start();var ds=new DriverManagerDataSource(pg.getJdbcUrl(),pg.getUsername(),pg.getPassword());var jdbc=new JdbcTemplate(ds);jdbc.execute("CREATE TABLE public.users(id BIGINT PRIMARY KEY);INSERT INTO public.users VALUES(1),(2),(3),(4),(5),(6);CREATE SCHEMA exams;CREATE TABLE exams.test_baseline(id INT)");
            var migration=Flyway.configure().dataSource(ds).schemas("exams").defaultSchema("exams").locations("classpath:db/migration/exams").baselineOnMigrate(true).baselineVersion("80").target("81").load();assertEquals(1,migration.migrate().migrationsExecuted);
            var json=new ObjectMapper();var repo=new RushCompetitiveRepository(jdbc,json,new DataSourceTransactionManager(ds));var questions=new RushQuestions(corpus);var time=new Time();var service=new RushCompetitiveService(questions,repo,mock(SimpMessagingTemplate.class),time);
            for(int humans=2;humans<=5;humans++){
                var s=humans==5?service.act(1,"fixture1","socket1","create",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),new RushCompetitiveService.Setup("EASY","MIXED",20,null),null,null,null,null,null,null,null)):act(service,1,"create",null);UUID id=(UUID)s.get("roomId");String invitation=(String)s.get("invitation");
                for(int user=2;user<=humans;user++)service.act(user,"fixture"+user,"socket"+user,"join",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),null,invitation,null,null,null,null,null,null));
                assertThrows(RushException.class,()->service.get(6,id));assertThrows(RushException.class,()->service.act(6,"fixture6","socket6","rejoin",command(s,UUID.randomUUID(),null,null,null,null,null,null)));
                var start=command(s,UUID.randomUUID(),null,null,null,null,null,null);assertThrows(RushException.class,()->service.act(2,"fixture2","socket2","start",start));
                for(int user=1;user<=humans;user++)act(service,user,"ready",s);
                service.act(1,"fixture1","socket1","start",start);service.act(1,"fixture1","socket1","start",start);assertEquals("COUNTDOWN",service.get(1,id).get("status"));
                var pinned=repo.get(1,id).race.questions;long[] seq=new long[humans];int[] jumps=new int[humans];
                // 25 ms decisions: version 7 stones and crumbling tiles are timed; a 50 ms control loop fell on them (bots decide every 120 Hz step)
                for(int frame=0;frame<20000&&!service.get(1,id).get("status").equals("FINISHED");frame++){
                    for(int user=1;user<=humans;user++){
                        var view=service.get(user,id);var players=(List<Map<String,Object>>)view.get("players");String you=(String)view.get("you");var own=players.stream().filter(p->p.get("id").equals(you)).findFirst().orElseThrow();String phase=(String)own.get("phase");int cp=((Number)own.get("checkpoint")).intValue();
                        assertTrue(((List<?>)view.get("review")).isEmpty());assertFalse(json.writeValueAsString(view).contains("answerId"));
                        if(phase.equals("FINISHED"))continue;double target=500;
                        // An arbitrary dash during a planned leap invalidates the pilot's predicted trajectory.
                        double y=((Number)own.get("y")).doubleValue();
                        boolean safeDash=((List<RushTrials.Hazard>)view.getOrDefault("hazards",List.of())).stream()
                            .noneMatch(h->y>h.from()-460&&y<h.to()+160);
                        var bounds=(List<Double>)view.get("boundaries");
                        safeDash&=cp>=bounds.size()||bounds.get(cp)-y>900;
                        if(frame%164==0&&safeDash&&phase.equals("RUNNING")&&!view.get("status").equals("COUNTDOWN"))act(service,user,"dash",view);
                        if(cp<pinned.size()){var q=pinned.get(cp);var question=(RushDtos.Question)view.get("question");int index=0;for(int i=0;i<question.options().size();i++)if(question.options().get(i).id().equals(q.answerId()))index=i;target=RushCompetition.center(index,question.options().size());
                            if(phase.equals("VALIDATING")){var answer=command(view,UUID.randomUUID(),null,null,null,null,q.id(),q.answerId());var first=service.act(user,"fixture"+user,"socket"+user,"answer",answer);var second=service.act(user,"fixture"+user,"socket"+user,"answer",answer);assertEquals(first.get("personal"),second.get("personal"));}}
                        // Version 6: a person steers (forward / lateral input, jumps) — the shared planner stands in for them.
                        var pilot=RushReforgedTest.pilot6(view,target);if(pilot[2]>0)jumps[user-1]++;
                        service.act(user,"fixture"+user,"socket"+user,"input",command(view,null,null,null,null,new RushCompetition.Input(seq[user-1]++,pilot[0],null,false,jumps[user-1],0,pilot[1]),null,null));
                    }time.ms+=25;service.tick(.025);
                }
                var finished=service.get(1,id);assertEquals("FINISHED",finished.get("status"));assertEquals(humans,((List<?>)finished.get("players")).size());assertEquals(humans==5?20:3,((List<?>)finished.get("review")).size());assertTrue(((List<Map<String,Object>>)finished.get("players")).stream().allMatch(p->p.get("phase").equals("FINISHED")),"humans "+humans+" "+finished.get("reason")+" t="+finished.get("elapsed")+" "+((List<Map<String,Object>>)finished.get("players")).stream().map(p->p.get("id")+":"+p.get("phase")+":cp"+p.get("checkpoint")+":y"+Math.round(((Number)p.get("y")).doubleValue())).toList()+" racers="+repo.get(1,id).race.racers.stream().map(p->p.id+" x"+Math.round(p.x)+" y"+Math.round(p.y)+" c"+p.connected+" f"+p.falls+" k"+p.knocks+" m"+p.mistakes+" seen"+p.seenAt+" in"+p.inputAt+" seq"+p.lastSeq).toList()+" walls="+repo.get(1,id).race.walls.stream().map(RushReforged.Wall::kind).toList()+" bounds="+repo.get(1,id).race.boundaries.subList(0,3)+" hz="+repo.get(1,id).race.hazards.stream().map(h->h.checkpoint()+h.kind()+h.tier()).toList());
                for(int user=1;user<=humans;user++)act(service,user,"rematch",finished);
                var previous=repo.get(1,id);assertEquals("FINISHED",previous.race.status);assertNotNull(previous.successor);var next=service.get(1,previous.successor);assertNotEquals(finished.get("matchId"),next.get("matchId"));assertTrue(repo.history(1).stream().anyMatch(r->r.id.equals(id)));
                for(int user=1;user<=humans;user++)act(service,user,"leave",next);
            }
            var live=act(service,1,"create",null);UUID liveId=(UUID)live.get("roomId");service.act(2,"fixture2","socket2","join",new RushCompetitiveService.Command(null,null,UUID.randomUUID(),null,(String)live.get("invitation"),null,null,null,null,null,null));act(service,1,"ready",live);act(service,2,"ready",live);act(service,1,"start",live);for(int i=0;i<40;i++){for(int user=1;user<=2;user++)service.act(user,"fixture"+user,"socket"+user,"input",command(live,null,null,null,null,new RushCompetition.Input(i,0,500.0,false),null,null));time.ms+=100;service.tick(.1);}live=service.get(1,liveId);assertEquals("RUNNING",live.get("status"));assertTrue(((Number)live.get("elapsed")).doubleValue()>0);service.close();time.ms+=120000;
            var recovered=new RushCompetitiveService(questions,repo,mock(SimpMessagingTemplate.class),time);var restore=recovered.get(1,liveId);assertEquals("SERVER_RECOVERED",restore.get("recovery"));assertEquals(live.get("elapsed"),restore.get("elapsed"));assertThrows(RushException.class,()->act(recovered,1,"ready",restore));act(recovered,1,"rejoin",restore);act(recovered,1,"leave",restore);act(recovered,2,"rejoin",restore);act(recovered,2,"leave",restore);recovered.close();
            var large=repo.history(1).stream().filter(r->r.race.questions.size()==20).findFirst().orElseThrow();for(int user=1;user<=5;user++){final String prefix=user+":";int count=(int)large.receipts.keySet().stream().filter(k->k.startsWith(prefix)).count();for(int i=count;i<512;i++)large.receipts.put(prefix+UUID.randomUUID(),new RushCompetitiveService.Receipt("0".repeat(64),false));}assertTrue(json.writeValueAsBytes(large).length>262144);assertTrue(json.writeValueAsBytes(large).length<900000);repo.save(large);assertEquals(large.receipts.size(),repo.get(1,large.id).receipts.size());
            assertEquals(9,jdbc.queryForObject("SELECT count(*) FROM public.quiz_rush_rooms",Integer.class));assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM public.quiz_rush_members WHERE active",Integer.class));
            assertThrows(org.springframework.dao.DataIntegrityViolationException.class,()->jdbc.update("DELETE FROM public.users WHERE id=1"));
        }
    }
}
