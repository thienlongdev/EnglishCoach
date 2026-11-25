package com.englishcoach.listening.service;

import com.englishcoach.listening.entity.*;
import com.englishcoach.listening.repository.*;
import com.englishcoach.premium.service.*;
import com.englishcoach.reading.service.ReadingService;
import com.englishcoach.speaking.service.SpeakingTtsService;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.core.io.ClassPathResource;
import org.springframework.mock.web.MockMultipartFile;
import org.testcontainers.containers.PostgreSQLContainer;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

/** Disposable PostgreSQL: real migration, transactions/locks and owner-scoped reads; no production access. */
class ListeningDocumentPostgresTest {
    static PostgreSQLContainer<?> db; static DriverManagerDataSource ds; static JdbcTemplate jdbc;
    @TempDir Path temp;
    ReadingService reading; SpeakingTtsService tts; PremiumUsageService usage;
    ListeningDocumentService service; ListeningDocumentAudio audio;
    @BeforeAll static void start() throws Exception {
        db=new PostgreSQLContainer<>("postgres:17");db.start();
        ds=new DriverManagerDataSource(db.getJdbcUrl(),db.getUsername(),db.getPassword());jdbc=new JdbcTemplate(ds);
        jdbc.execute("CREATE TABLE users(id bigint PRIMARY KEY); INSERT INTO users VALUES(1),(2)");
        jdbc.execute("CREATE TABLE listening_materials(id bigserial PRIMARY KEY,title text,audio_url text,owner_user_id bigint,is_system boolean,youtube_video_id text,duration_seconds int)");
        jdbc.execute("CREATE TABLE transcript_segments(id bigserial PRIMARY KEY,listening_material_id bigint REFERENCES listening_materials(id),text text,start_time_ms int,end_time_ms int)");
        jdbc.execute("CREATE TABLE listening_exercises(id bigserial PRIMARY KEY,listening_material_id bigint REFERENCES listening_materials(id),transcript_segment_id bigint REFERENCES transcript_segments(id),expected_answer text)");
        jdbc.execute("CREATE TABLE premium_feature_definitions(feature_key varchar(64) PRIMARY KEY,display_name text,description text,premium_required boolean,free_trial_limit int,premium_monthly_limit int,enabled boolean,sort_order int)");
        jdbc.execute("CREATE TABLE premium_ai_usage(id bigserial PRIMARY KEY,status text)");
        jdbc.execute(new String(new ClassPathResource("db/migration/exams/V91__listening_document_import.sql").getInputStream().readAllBytes(),java.nio.charset.StandardCharsets.UTF_8));
    }
    @AfterAll static void stop(){if(db!=null)db.stop();}
    @BeforeEach void setup() throws Exception {
        jdbc.execute("TRUNCATE listening_document_jobs,listening_exercises,transcript_segments,listening_materials,premium_ai_usage RESTART IDENTITY");
        jdbc.update("INSERT INTO listening_materials(title,audio_url,is_system) VALUES('Existing video','https://youtube.com/watch?v=abcdefghijk',true)");
        reading=mock(ReadingService.class);tts=mock(SpeakingTtsService.class);usage=mock(PremiumUsageService.class);
        var entitlement=mock(PremiumEntitlementService.class);
        var materials=mock(ListeningMaterialRepository.class);var segments=mock(TranscriptSegmentRepository.class);var exercises=mock(ListeningExerciseRepository.class);
        when(materials.saveAndFlush(any())).thenAnswer(call->{ListeningMaterial m=call.getArgument(0);
            if(m.getId()==null)m.setId(jdbc.queryForObject("INSERT INTO listening_materials(title,audio_url,owner_user_id,is_system,source_type,voice_id,duration_seconds) VALUES(?,?,?,false,'DOCUMENT',?,?) RETURNING id",Long.class,m.getTitle(),m.getAudioUrl(),m.getOwnerUserId(),m.getVoiceId(),m.getDurationSeconds()));
            else jdbc.update("UPDATE listening_materials SET audio_url=? WHERE id=?",m.getAudioUrl(),m.getId());return m;});
        when(segments.save(any())).thenAnswer(call->{TranscriptSegment s=call.getArgument(0);s.setId(jdbc.queryForObject("INSERT INTO transcript_segments(listening_material_id,text,start_time_ms,end_time_ms) VALUES(?,?,?,?) RETURNING id",Long.class,s.getListeningMaterial().getId(),s.getText(),s.getStartTimeMs(),s.getEndTimeMs()));return s;});
        when(exercises.save(any())).thenAnswer(call->{ListeningExercise e=call.getArgument(0);jdbc.update("INSERT INTO listening_exercises(listening_material_id,transcript_segment_id,expected_answer) VALUES(?,?,?)",e.getListeningMaterial().getId(),e.getTranscriptSegment().getId(),e.getExpectedAnswer());return e;});
        when(usage.reserveUsage(anyLong(),anyString(),anyString(),anyBoolean())).thenAnswer(c->jdbc.queryForObject("INSERT INTO premium_ai_usage(status) VALUES('RESERVED') RETURNING id",Long.class));
        doAnswer(c->{jdbc.update("UPDATE premium_ai_usage SET status='COMPLETED' WHERE id=?",c.getArgument(0,Long.class));return null;}).when(usage).commitReservation(anyLong());
        doAnswer(c->{jdbc.update("UPDATE premium_ai_usage SET status='RELEASED' WHERE id=?",c.getArgument(0,Long.class));return null;}).when(usage).releaseReservation(anyLong());
        when(tts.synthesizePrivatePassage(anyString(),anyString())).thenReturn(ListeningDocumentTest.wav(24017));
        audio=new ListeningDocumentAudio(temp);
        service=new ListeningDocumentService(jdbc,new DataSourceTransactionManager(ds),reading,tts,audio,materials,segments,exercises,usage,entitlement);
    }
    private ListeningDocumentService.Request request(){return new ListeningDocumentService.Request("My document","The morning sun warms our garden. We enjoy reading together.","uk_female");}
    @Test void completePersonalMaterialExactTextTimingIsolationReplayAndDeletion() {
        var job=service.create(1L,request());assertThat(job.status()).isEqualTo("QUEUED");verifyNoInteractions(tts);
        service.tick();var ready=service.get(1L,job.id());assertThat(ready.status()).isEqualTo("READY");
        assertThat(service.media(1L,ready.materialId()).exists()).isTrue();
        assertThatThrownBy(()->service.media(2L,ready.materialId())).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThatThrownBy(()->service.get(2L,job.id())).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThat(service.create(1L,request()).id()).isEqualTo(job.id());verify(tts,times(2)).synthesizePrivatePassage(eq("uk_female"),anyString());
        assertThat(jdbc.queryForList("SELECT text FROM transcript_segments ORDER BY start_time_ms",String.class)).containsExactly("The morning sun warms our garden.","We enjoy reading together.");
        assertThat(jdbc.queryForList("SELECT start_time_ms FROM transcript_segments ORDER BY start_time_ms",Integer.class)).containsExactly(0,1001);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM listening_exercises",Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM listening_materials WHERE is_system=true",Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT status FROM premium_ai_usage",String.class)).isEqualTo("COMPLETED");
        new org.springframework.transaction.support.TransactionTemplate(new DataSourceTransactionManager(ds)).executeWithoutResult(s->{service.deleteAudioAfterCommit(ready.materialId());jdbc.update("DELETE FROM listening_exercises");jdbc.update("DELETE FROM transcript_segments");jdbc.update("DELETE FROM listening_materials WHERE id=?",ready.materialId());});
        assertThatThrownBy(()->audio.load(1L,job.id())).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM listening_document_jobs",Integer.class)).isZero();
    }
    @Test void failurePublishesNothingAndRetryReleasesOnlyFailedUsage() {
        when(tts.synthesizePrivatePassage(anyString(),anyString())).thenThrow(new IllegalStateException("Unavailable"));
        var job=service.create(1L,request());service.tick();assertThat(service.get(1L,job.id()).status()).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM listening_materials WHERE is_system=false",Integer.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT status FROM premium_ai_usage",String.class)).isEqualTo("RELEASED");
        doReturn(uncheckedWav()).when(tts).synthesizePrivatePassage(anyString(),anyString());
        assertThat(service.create(1L,request()).id()).isEqualTo(job.id());service.tick();assertThat(service.get(1L,job.id()).status()).isEqualTo("READY");
        assertThat(jdbc.queryForList("SELECT status FROM premium_ai_usage ORDER BY id",String.class)).containsExactly("RELEASED","COMPLETED");
    }
    private byte[] uncheckedWav(){try{return ListeningDocumentTest.wav(24017);}catch(Exception e){throw new RuntimeException(e);}}
    @Test void concurrentDoubleSubmissionHasOneJobAndOneReservation() throws Exception {
        try(var pool=Executors.newFixedThreadPool(2)){
            var a=pool.submit(()->service.create(1L,request()));var b=pool.submit(()->service.create(1L,request()));
            assertThat(a.get(10,TimeUnit.SECONDS).id()).isEqualTo(b.get(10,TimeUnit.SECONDS).id());
        }
        assertThat(jdbc.queryForObject("SELECT count(*) FROM listening_document_jobs",Integer.class)).isEqualTo(1);
        verify(usage,times(1)).reserveUsage(anyLong(),eq(ListeningDocumentService.FEATURE),anyString(),anyBoolean());
    }
    @Test void reviewedExtractionReusesReadingWithoutPersistenceAndRejectsBadFiles() {
        var pdf=new MockMultipartFile("file","study.pdf","application/pdf","%PDF-1.7\nfixture".getBytes());
        when(reading.extractFile(pdf,"Study",null)).thenReturn(Map.of("extracted_text","Editable English extraction."));
        assertThat(service.extract(pdf,"Study")).isEqualTo("Editable English extraction.");
        assertThatThrownBy(()->service.extract(new MockMultipartFile("file","bad.pdf","application/pdf","not pdf".getBytes()),"Study")).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThatThrownBy(()->service.extract(new MockMultipartFile("file","bad.txt","text/plain","Some text".getBytes()),"Study")).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM listening_document_jobs",Integer.class)).isZero();verifyNoInteractions(tts);
    }
}
