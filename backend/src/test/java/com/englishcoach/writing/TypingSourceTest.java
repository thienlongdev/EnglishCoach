package com.englishcoach.writing;

import com.englishcoach.writing.repository.TypingSourceRepository;
import com.englishcoach.writing.service.TypingSourceService;
import com.englishcoach.writing.controller.TypingSourceController;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;
import java.util.*;
import static org.assertj.core.api.Assertions.*;

/** Disposable PostgreSQL only: actual source queries, privacy, fidelity and bounded reads. */
class TypingSourceTest {
    static PostgreSQLContainer<?> db;
    static NamedParameterJdbcTemplate jdbc;
    TypingSourceService service;
    @BeforeAll static void setup() {
        db = new PostgreSQLContainer<>("postgres:17"); db.start();
        jdbc = new NamedParameterJdbcTemplate(new DriverManagerDataSource(db.getJdbcUrl(),db.getUsername(),db.getPassword()));
        var sql = jdbc.getJdbcTemplate();
        sql.execute("CREATE TABLE translation_sessions(id uuid PRIMARY KEY,user_id bigint)");
        sql.execute("CREATE TABLE translation_attempts(id uuid PRIMARY KEY,user_id bigint,session_id uuid,unit_id uuid,answer_text text,action text,accepted boolean,created_at timestamp)");
        sql.execute("CREATE TABLE translation_paragraph_sessions(id uuid PRIMARY KEY,user_id bigint)");
        sql.execute("CREATE TABLE translation_paragraph_session_items(id uuid PRIMARY KEY,session_id uuid)");
        sql.execute("CREATE TABLE translation_paragraph_attempts(id uuid PRIMARY KEY,user_id bigint,session_id uuid,session_item_id uuid,passage_id uuid,submitted_text text,action text,accepted boolean,created_at timestamp)");
        sql.execute("CREATE TABLE writing_sessions(id text PRIMARY KEY,user_id bigint,task_snapshot jsonb,working_text text,updated_at timestamp)");
        sql.execute("CREATE TABLE writing_submissions(id text PRIMARY KEY,user_id bigint,session_id text,kind text,content text,ordinal int,created_at timestamp)");
    }
    @AfterAll static void stop() { if(db!=null) db.stop(); }
    @BeforeEach void seed() {
        service = new TypingSourceService(new TypingSourceRepository(jdbc));
        jdbc.getJdbcTemplate().execute("TRUNCATE translation_attempts,translation_sessions,translation_paragraph_attempts,translation_paragraph_session_items,translation_paragraph_sessions,writing_submissions,writing_sessions");
        for(long user=1;user<=2;user++) {
            String session=UUID.randomUUID().toString(), unit=UUID.randomUUID().toString(), item=UUID.randomUUID().toString(), passage=UUID.randomUUID().toString();
            var params = new HashMap<String,Object>(Map.of("session",session,"unit",unit,"item",item,"passage",passage,"user",user,"text","Learner " + user + " writes English."));
            jdbc.update("INSERT INTO translation_sessions VALUES (:session::uuid,:user)",params);
            jdbc.update("INSERT INTO translation_attempts VALUES (gen_random_uuid(),:user,:session::uuid,:unit::uuid,:text,'SUBMIT',true,now()-interval '1 day')",params);
            jdbc.update("INSERT INTO translation_attempts VALUES (gen_random_uuid(),:user,:session::uuid,:unit::uuid,:text || ' Latest.','REVISE',true,now())",params);
            jdbc.update("INSERT INTO translation_attempts VALUES (gen_random_uuid(),:user,:session::uuid,:unit::uuid,'Skipped prompt','SKIP',null,now())",params);
            jdbc.update("INSERT INTO translation_paragraph_sessions VALUES (:session::uuid,:user)",params);
            jdbc.update("INSERT INTO translation_paragraph_session_items VALUES (:item::uuid,:session::uuid)",params);
            jdbc.update("INSERT INTO translation_paragraph_attempts VALUES (gen_random_uuid(),:user,:session::uuid,:item::uuid,:passage::uuid,:text || E'\\n\\nSecond  paragraph.','SUBMIT',true,now())",params);
            jdbc.update("INSERT INTO writing_sessions VALUES (:user::text,:user,'{\"title\":\"Assignment title only\"}'::jsonb,E'  Actual  saved body.\\n\\nNext paragraph.  ',now())",params);
            jdbc.update("INSERT INTO writing_submissions VALUES (:user::text,:user,:user::text,'COACH_DRAFT','Older draft body.',1,now())",params);
        }
    }
    @Test void authenticAnswersLatestAcceptedAndDraftBodyRemainExact() {
        for(String category:List.of("sentence","paragraph","draft")) {
            var page=service.list(1L,category,0); assertThat(page.content()).hasSize(1);
            assertThat(page.content().getFirst().text()).isNull();
            String body=service.detail(1L,category,page.content().getFirst().id()).text();
            if(category.equals("sentence")) assertThat(body).isEqualTo("Learner 1 writes English. Latest.");
            if(category.equals("paragraph")) assertThat(body).isEqualTo("Learner 1 writes English.\n\nSecond  paragraph.");
            if(category.equals("draft")) assertThat(body).isEqualTo("  Actual  saved body.\n\nNext paragraph.  ");
            assertThat(body).doesNotContain("Skipped prompt","Assignment title only");
        }
    }
    @Test void foreignAndMismatchedOwnershipNotFoundAndNoReadsMutate() {
        long before=jdbc.getJdbcTemplate().queryForObject("SELECT count(*) FROM translation_attempts",Long.class);
        for(String category:List.of("sentence","paragraph","draft")) {
            String id=service.list(1L,category,0).content().getFirst().id();
            assertThatThrownBy(()->service.detail(2L,category,id)).isInstanceOf(ResponseStatusException.class)
                .satisfies(e->assertThat(((ResponseStatusException)e).getStatusCode().value()).isEqualTo(404));
            assertThat(service.list(99L,category,0).content()).isEmpty();
        }
        jdbc.getJdbcTemplate().execute("UPDATE translation_sessions SET user_id=2 WHERE user_id=1");
        assertThat(service.list(1L,"sentence",0).content()).isEmpty();
        assertThat(jdbc.getJdbcTemplate().queryForObject("SELECT count(*) FROM translation_attempts",Long.class)).isEqualTo(before);
    }
    @Test void draftFallbackIsOwnedLatestSavedDraftAndCatalogIsBounded() {
        jdbc.getJdbcTemplate().execute("UPDATE writing_sessions SET working_text='' WHERE id='1'");
        assertThat(service.detail(1L,"draft","1").text()).isEqualTo("Older draft body.");
        jdbc.getJdbcTemplate().execute("INSERT INTO writing_submissions VALUES ('foreign',2,'1','COACH_DRAFT','Foreign body',9,now())");
        assertThat(service.detail(1L,"draft","1").text()).isEqualTo("Older draft body.");
        jdbc.getJdbcTemplate().execute("INSERT INTO writing_sessions SELECT 'many-'||i,1,'{}'::jsonb,'Saved English body',now() FROM generate_series(1,30) i");
        assertThat(service.list(1L,"draft",0).content()).hasSize(24);
        assertThat(service.list(1L,"draft",0).hasNext()).isTrue();
        assertThat(service.list(1L,"draft",1).content()).hasSize(7);
        assertThat(service.list(1L,"draft",1).hasNext()).isFalse();
    }
    @Test void invalidCategoryAndMissingPrincipalFailClosed() {
        assertThatThrownBy(()->service.list(1L,"prompts",0)).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(()->new TypingSourceController(service).list(null,"sentence",0)).isInstanceOf(AccessDeniedException.class);
    }
}
