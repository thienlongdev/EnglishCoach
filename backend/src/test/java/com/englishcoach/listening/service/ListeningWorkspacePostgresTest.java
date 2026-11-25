package com.englishcoach.listening.service;

import com.englishcoach.auth.policy.AdminIdentityService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

/** Real PostgreSQL: additive migration, account/lesson/version isolation and revision races. */
class ListeningWorkspacePostgresTest {
    static PostgreSQLContainer<?> db;static JdbcTemplate jdbc;static DriverManagerDataSource ds;
    final ObjectMapper mapper=new ObjectMapper();AdminIdentityService admins;ListeningWorkspaceService service;
    @BeforeAll static void start() throws Exception {
        db=new PostgreSQLContainer<>("postgres:17");db.start();ds=new DriverManagerDataSource(db.getJdbcUrl(),db.getUsername(),db.getPassword());jdbc=new JdbcTemplate(ds);
        jdbc.execute("CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(1),(2)");
        jdbc.execute("CREATE TABLE listening_materials(id bigint PRIMARY KEY,owner_user_id bigint,is_system boolean,source_type text)");
        jdbc.execute("CREATE TABLE transcript_segments(id bigint PRIMARY KEY,listening_material_id bigint REFERENCES listening_materials(id),start_time_ms int,end_time_ms int,text text)");
        jdbc.execute("CREATE TABLE listening_exercises(id bigint PRIMARY KEY,listening_material_id bigint,transcript_segment_id bigint,expected_answer text)");
        jdbc.execute("CREATE TABLE listening_sessions(id bigint PRIMARY KEY,user_id bigint,listening_material_id bigint)");
        jdbc.execute("CREATE TABLE exercise_attempts(id bigint PRIMARY KEY,listening_session_id bigint,listening_exercise_id bigint,raw_user_answer text,is_correct boolean,accuracy_percentage double precision,primary_error_category text)");
        jdbc.execute(new String(new ClassPathResource("db/migration/exams/V104__listening_checkpoints_and_translation_cache.sql").getInputStream().readAllBytes(),StandardCharsets.UTF_8));
    }
    @AfterAll static void stop(){if(db!=null)db.stop();}
    @BeforeEach void setup(){
        jdbc.execute("TRUNCATE listening_checkpoints,listening_translation_cache,exercise_attempts,listening_sessions,listening_exercises,transcript_segments,listening_materials");
        jdbc.update("INSERT INTO listening_materials VALUES(10,NULL,true,'VIDEO'),(11,1,false,'DOCUMENT'),(12,2,false,'VIDEO'),(13,NULL,false,'VIDEO')");
        jdbc.update("INSERT INTO transcript_segments VALUES(101,10,0,1000,'When we arrived,'),(102,10,1000,2000,'it was raining.'),(111,11,NULL,NULL,'The children are reading together.'),(121,12,0,1000,'Private text')");
        admins=mock(AdminIdentityService.class);when(admins.isOfficialAdmin(2L)).thenReturn(true);
        service=new ListeningWorkspaceService(jdbc,mapper,new DataSourceTransactionManager(ds),admins);
    }
    ListeningWorkspaceService.Save request(ListeningWorkspaceService.Checkpoint checkpoint,long segment,String draft){
        var state=mapper.createObjectNode();state.put("selectedSegmentId",segment);state.put("position",.7);var entry=state.putObject("entries").putObject(Long.toString(segment));entry.put("draft",draft);entry.put("status","draft");
        return new ListeningWorkspaceService.Save(checkpoint.contentVersion(),checkpoint.revision(),state);
    }
    @Test void existingVideoAndNewUntimedDocumentInitializeWithoutReimportAndKeepOwnersAndLessonsSeparate(){
        var old=service.get(1,10);assertThat(old.revision()).isZero();assertThat(jdbc.queryForObject("SELECT count(*) FROM listening_checkpoints",Integer.class)).isZero();
        service.save(1,10,request(old,102,"it was"));
        var fresh=service.get(1,11);service.save(1,11,request(fresh,111,"The children"));
        assertThat(service.get(1,10).state().path("entries").path("102").path("draft").asText()).isEqualTo("it was");
        assertThat(service.get(1,11).state().path("entries").path("111").path("draft").asText()).isEqualTo("The children");
        assertThat(service.get(2,10).state().path("entries").isEmpty()).isTrue();
        assertThatThrownBy(()->service.get(2,11)).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(()->service.save(2,11,request(fresh,111,"stolen"))).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(()->service.get(1,13)).isInstanceOf(ResponseStatusException.class);
        verifyNoInteractions(admins);
    }
    @Test void revisedTranscriptArchivesOldDraftInsteadOfMappingByIndex(){
        var original=service.get(1,10);service.save(1,10,request(original,102,"old draft"));
        jdbc.update("UPDATE transcript_segments SET text='A different statement.' WHERE id=102");
        var revised=service.get(1,10);assertThat(revised.contentVersion()).isNotEqualTo(original.contentVersion());assertThat(revised.state().path("entries").isEmpty()).isTrue();
        assertThatThrownBy(()->service.save(1,10,request(original,102,"late old draft"))).isInstanceOf(ResponseStatusException.class);
        assertThat(jdbc.queryForObject("SELECT state->'entries'->'102'->>'draft' FROM listening_checkpoints",String.class)).isEqualTo("old draft");
    }
    @Test void competingSavesHaveOneWinnerAndLateResponseCannotOverwrite(){
        var initial=service.get(1,10);var first=service.save(1,10,request(initial,101,"new draft"));
        assertThat(first.revision()).isEqualTo(1);
        assertThatThrownBy(()->service.save(1,10,request(initial,102,"stale tab"))).isInstanceOf(ResponseStatusException.class);
        assertThat(service.get(1,10).state().path("entries").has("102")).isFalse();
    }
    @Test void lazyLegacyAttemptHydrationIsOwnerAndMaterialScoped(){
        jdbc.update("INSERT INTO listening_exercises VALUES(1,10,101,'When we arrived,'),(2,10,102,'it was raining.')");
        jdbc.update("INSERT INTO listening_sessions VALUES(1,1,10),(2,2,10)");
        jdbc.update("INSERT INTO exercise_attempts VALUES(1,1,1,'When we arrived',true,100,'EXACT_MATCH'),(2,2,2,'someone else',false,20,'WRONG_WORD')");
        var state=service.get(1,10).state();assertThat(state.path("entries").path("101").path("draft").asText()).isEqualTo("When we arrived");assertThat(state.path("entries").has("102")).isFalse();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM exercise_attempts",Integer.class)).isEqualTo(2);
    }
    ListeningWorkspaceService.TranslationSubmit pairs(String version,String engine,Map<String,String> pairs){return new ListeningWorkspaceService.TranslationSubmit(version,engine,pairs);}
    @Test void devicePairsAreValidatedScopedAndNeverOverwritten(){
        var initial=service.translations(1,10);assertThat(initial.translations()).isEmpty();
        var mine=service.submit(1,10,pairs(initial.contentVersion(),"opus-mt-en-vi",Map.of("101","Khi chúng tôi đến,","102","it was raining.")));
        assertThat(mine.translations()).containsEntry("101","Khi chúng tôi đến,").doesNotContainKey("102");
        service.submit(1,10,pairs(initial.contentVersion(),"opus-mt-en-vi",Map.of("101","Bản dịch sau")));
        assertThat(service.translations(1,10).translations().get("101")).isEqualTo("Khi chúng tôi đến,");
        assertThat(service.translations(3,10).translations()).isEmpty();
        service.submit(2,10,pairs(initial.contentVersion(),"chrome-translator",Map.of("102","trời đang mưa.")));
        assertThat(service.translations(3,10).translations()).containsOnlyKeys("102");
        jdbc.update("INSERT INTO listening_translation_cache VALUES(10,?,'listening-pairs-1:p:m','{\"101\":\"Khi chúng tôi tới,\"}'::jsonb,now())",initial.contentVersion());
        assertThat(service.translations(1,10).translations()).containsEntry("101","Khi chúng tôi tới,").containsEntry("102","trời đang mưa.");
        assertThatThrownBy(()->service.submit(1,10,pairs(initial.contentVersion(),"opus-mt-en-vi",Map.of("121","x")))).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(()->service.submit(1,10,pairs(initial.contentVersion(),"paid-llm",Map.of("101","x")))).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(()->service.submit(1,10,pairs("stale","opus-mt-en-vi",Map.of("101","x")))).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(()->service.submit(1,12,pairs(initial.contentVersion(),"opus-mt-en-vi",Map.of("121","x")))).isInstanceOf(ResponseStatusException.class);
        jdbc.update("UPDATE transcript_segments SET text='They are dancing.' WHERE id=102");assertThat(service.translations(1,10).translations()).isEmpty();
    }
    @Test void privateLessonPairsStayWithTheirOwner(){
        var version=service.translations(1,11).contentVersion();
        service.submit(1,11,pairs(version,"opus-mt-en-vi",Map.of("111","Bọn trẻ đang cùng nhau đọc sách.")));
        assertThat(service.translations(1,11).translations()).containsEntry("111","Bọn trẻ đang cùng nhau đọc sách.");
        assertThatThrownBy(()->service.translations(2,11)).isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(()->service.submit(2,11,pairs(version,"opus-mt-en-vi",Map.of("111","x")))).isInstanceOf(ResponseStatusException.class);
    }
    @Test void obviouslyBrokenOutputsAreRejected(){
        assertThat(ListeningWorkspaceService.acceptable("  ","Hello there")).isNull();
        assertThat(ListeningWorkspaceService.acceptable("The children are reading.","The children are reading.")).isNull();
        assertThat(ListeningWorkspaceService.acceptable("và và và và và và","and")).isNull();
        assertThat(ListeningWorkspaceService.acceptable("x".repeat(200),"Hi")).isNull();
        assertThat(ListeningWorkspaceService.acceptable("Vâng","OK")).isEqualTo("Vâng");
        assertThat(ListeningWorkspaceService.acceptable("với giọng la, la, la, la, la, la, la, la, la phóng đại.","with exaggerated la, la, la, la, la, la, la, la, la.")).isNotNull();
        assertThat(ListeningWorkspaceService.acceptable("Xin\u0000 chào","Hello")).isEqualTo("Xin chào");
    }
    @Test void malformedOrForeignSegmentPayloadCannotPersist(){
        var initial=service.get(1,10);
        assertThatThrownBy(()->service.save(1,10,request(initial,111,"wrong lesson"))).isInstanceOf(ResponseStatusException.class);
        var invalid=request(initial,101,"x");((com.fasterxml.jackson.databind.node.ObjectNode)invalid.state()).put("position",-1);
        assertThatThrownBy(()->service.save(1,10,invalid)).isInstanceOf(ResponseStatusException.class);
    }
}
