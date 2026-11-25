package com.englishcoach.quizrush;

import com.englishcoach.kingofenglish.KingCorpus;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class RushPersistenceTest {
    @Test void actualFlywayPersistenceIsolationReplayCompletionAndRestart(){
        try(var pg=new PostgreSQLContainer<>("postgres:17");var corpus=new KingCorpus("REVIEW_PREVIEW")){
            pg.start();var ds=new DriverManagerDataSource(pg.getJdbcUrl(),pg.getUsername(),pg.getPassword());var jdbc=new JdbcTemplate(ds);
            jdbc.execute("CREATE TABLE public.users(id BIGINT PRIMARY KEY);INSERT INTO public.users VALUES(1),(2);CREATE SCHEMA exams;CREATE TABLE exams.test_baseline(id INT)");
            var flyway=Flyway.configure().dataSource(ds).schemas("exams").defaultSchema("exams").locations("classpath:db/migration/exams").baselineOnMigrate(true).baselineVersion("78").target("79").load();
            assertEquals(1,flyway.migrate().migrationsExecuted);assertEquals("79",flyway.info().current().getVersion().toString());
            var json=new ObjectMapper();var repo=new RushRepository(jdbc,json);var questions=new RushQuestions(corpus);var service=new RushService(questions,repo);var tx=new TransactionTemplate(new DataSourceTransactionManager(ds));
            var request=new RushDtos.Start(UUID.randomUUID(),"EASY","MIXED",3);var session=tx.execute(s->service.start(1,request));
            assertEquals(session.id(),tx.execute(s->service.start(1,request)).id());assertThrows(RushException.class,()->service.get(2,session.id()));
            assertThrows(RushException.class,()->tx.execute(s->service.finish(1,session.id())));
            assertFalse(json.writeValueAsString(session).contains("answerId"));assertEquals(0,session.review().size());
            // Skybound course: one reading segment per question, doors never fewer later, momentum starts at zero.
            assertEquals(RushCompetition.HARDCORE,session.courseVersion());assertEquals(3,session.boundaries().size());assertEquals(0,session.streak());assertEquals(3,session.walls().size());assertEquals("STATIC",session.walls().getFirst().kind());
            // Skybound Trials: the server's stored plan (walls, obstacle zones, rising walls) is the session's course.
            var stored=repo.get(1,session.id());var pinned=stored.questions;assertEquals(stored.boundaries,session.boundaries());assertEquals(stored.hazards,session.hazards());assertEquals(stored.rising,session.rising());assertEquals(stored.walls,session.walls());assertEquals(stored.orbs,session.orbs());
            assertEquals(3,session.rising().size());assertTrue(RushReforged.hazards(session.hazards(),0).isEmpty());assertFalse(session.hazards().isEmpty());
            for(int i=1;i<pinned.size();i++)assertTrue(pinned.get(i).options().size()>=pinned.get(i-1).options().size());
            var first=repo.get(1,session.id()).questions.getFirst();UUID wrong=first.options().stream().filter(o->!o.id().equals(first.answerId())).findFirst().orElseThrow().id();
            UUID receipt=UUID.randomUUID();var wrongRequest=new RushDtos.Answer(receipt,first.id(),wrong);
            var rejected=tx.execute(s->service.answer(1,session.id(),wrongRequest));assertFalse(rejected.correct());assertEquals(1,rejected.session().incorrect());
            assertTrue(tx.execute(s->service.answer(1,session.id(),wrongRequest)).repeated());assertEquals(1,service.get(1,session.id()).incorrect());
            assertThrows(RushException.class,()->tx.execute(s->service.answer(1,session.id(),new RushDtos.Answer(receipt,first.id(),first.answerId()))));
            assertThrows(RushException.class,()->tx.execute(s->service.answer(1,session.id(),new RushDtos.Answer(UUID.randomUUID(),first.id(),UUID.randomUUID()))));
            assertEquals(0,rejected.session().streak());
            int[] expectedStreak={0,1,2};
            for(int i=0;i<3;i++){var q=repo.get(1,session.id()).questions.get(i);var result=tx.execute(s->service.answer(1,session.id(),new RushDtos.Answer(UUID.randomUUID(),q.id(),q.answerId())));assertTrue(result.correct());
                assertEquals(expectedStreak[i],result.session().streak(),"a gate opened after a mistake earns no momentum; first-try gates do");}
            var finished=tx.execute(s->service.finish(1,session.id()));assertEquals("FINISHED",finished.status());assertEquals(3,finished.review().size());assertEquals(1,finished.incorrect());assertEquals(2,finished.bestStreak());
            assertEquals(finished,tx.execute(s->service.finish(1,session.id())));assertEquals(1,service.history(1).size());assertEquals(0,service.history(2).size());
            var restart=new RushService(questions,new RushRepository(jdbc,json));assertEquals(finished,restart.get(1,session.id()));assertNull(restart.active(1));
            assertThrows(org.springframework.dao.DataIntegrityViolationException.class,()->jdbc.update("DELETE FROM public.users WHERE id=1"));
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM public.quiz_rush_sessions",Integer.class));
        }catch(com.fasterxml.jackson.core.JsonProcessingException e){throw new AssertionError(e);}
    }
}
