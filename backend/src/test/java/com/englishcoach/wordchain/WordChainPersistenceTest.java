package com.englishcoach.wordchain;

import com.englishcoach.progress.service.LearningEventService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.testcontainers.containers.PostgreSQLContainer;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class WordChainPersistenceTest {
    @Test void flywayResultPersistenceIsolationAndLearningIdempotency() {
        try(var postgres=new PostgreSQLContainer<>("postgres:17")) {
            postgres.start();
            var ds=new DriverManagerDataSource(postgres.getJdbcUrl(),postgres.getUsername(),postgres.getPassword());
            var jdbc=new JdbcTemplate(ds);
            jdbc.execute("CREATE TABLE public.users(id BIGINT PRIMARY KEY); INSERT INTO public.users VALUES(1),(2)");
            jdbc.execute("CREATE SCHEMA exams; CREATE TABLE exams.test_baseline(id INT)");
            jdbc.execute("""
                CREATE TABLE public.learning_activity_events(user_id BIGINT NOT NULL REFERENCES public.users(id),
                activity_type TEXT NOT NULL,source_ref TEXT NOT NULL,occurred_at TIMESTAMPTZ NOT NULL,
                UNIQUE(user_id,activity_type,source_ref))
                """);
            // Test fixture represents pre-V70 schema. Run the real migration through the canonical Flyway location.
            var flyway=Flyway.configure().dataSource(ds).schemas("exams").defaultSchema("exams")
                .locations("classpath:db/migration/exams").baselineOnMigrate(true).baselineVersion("69").target("70").load();
            assertEquals(1,flyway.migrate().migrationsExecuted);assertEquals("70",flyway.info().current().getVersion().toString());
            var learning=new LearningEventService(new NamedParameterJdbcTemplate(ds));
            var results=new WordChainResults(jdbc,new ObjectMapper(),new DataSourceTransactionManager(ds),learning);
            UUID id=UUID.randomUUID();var at=Instant.now();var data=Map.<Long,Map<String,Object>>of(1L,Map.of("acceptedCount",3,"status","FINISHED"));
            results.save(id,"SOLO",data,at);results.save(id,"SOLO",data,at);
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM public.word_chain_results",Integer.class));
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events",Integer.class));
            assertEquals(1,results.history(1).size());assertTrue(results.history(2).isEmpty());
            assertThrows(WordChainRules.Rejection.class,()->results.result(2,id));assertTrue(results.result(1,id).contains("FINISHED"));
            assertThrows(Exception.class,()->jdbc.update("DELETE FROM public.users WHERE id=1"));
            assertEquals(0,flyway.migrate().migrationsExecuted);
        }
    }
}
