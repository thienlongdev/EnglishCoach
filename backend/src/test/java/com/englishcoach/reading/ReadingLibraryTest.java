package com.englishcoach.reading;

import com.englishcoach.reading.service.*;
import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.*;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import static org.assertj.core.api.Assertions.*;

/** Real PostgreSQL in a disposable container; never connects to application/production DB. */
class ReadingLibraryTest {
    static PostgreSQLContainer<?> db;
    static NamedParameterJdbcTemplate jdbc;
    static TransactionTemplate tx;
    static JsonNode corpus, registry;
    @BeforeAll static void setup() throws Exception {
        var mapper = new ObjectMapper();
        try (var in = new ClassPathResource("data/reading/corpus.json").getInputStream()) { corpus = mapper.readTree(in); }
        try (var in = new ClassPathResource("data/reading/sources.json").getInputStream()) { registry = mapper.readTree(in); }
        db = new PostgreSQLContainer<>("postgres:17").withStartupTimeout(Duration.ofSeconds(45));
        db.start();
        var ds = new DriverManagerDataSource(db.getJdbcUrl()+"?connectTimeout=5&socketTimeout=20",db.getUsername(),db.getPassword());
        jdbc = new NamedParameterJdbcTemplate(ds);
        jdbc.getJdbcTemplate().setQueryTimeout(15);
        tx = new TransactionTemplate(new DataSourceTransactionManager(ds)); tx.setTimeout(60);
        jdbc.getJdbcTemplate().execute("CREATE TABLE reading_materials(id BIGSERIAL PRIMARY KEY,title text,source_url text,content_text text,source_name text,difficulty_level text,word_count int,material_type text,content_mode text,is_system boolean NOT NULL,owner_user_id bigint,created_at timestamp)");
        jdbc.getJdbcTemplate().execute("CREATE TABLE user_reading_progress(id BIGSERIAL PRIMARY KEY,reading_material_id bigint,user_id bigint,scroll_percentage int,last_read_at timestamp)");
    }
    @AfterAll static void stop() { if (db != null) db.stop(); }
    @BeforeEach void clear() {
        jdbc.getJdbcTemplate().execute("TRUNCATE user_reading_progress,reading_materials RESTART IDENTITY");
        jdbc.getJdbcTemplate().execute("INSERT INTO reading_materials(title,content_text,word_count,is_system,owner_user_id) VALUES ('A private','A body',2,false,1),('B private','B body',2,false,2),('Quarantined','Hidden',1,false,NULL),('Malformed SYSTEM owner','Hidden',1,true,1)");
    }
    ReadingCorpusImporter importer(boolean enabled) { return new ReadingCorpusImporter(jdbc,enabled); }
    ReadingCorpusImporter.Result run(boolean apply, boolean updates, String digest) {
        return tx.execute(s -> importer(true).run(apply,updates,digest));
    }
    @Test void rightsFailClosedAndActualCorpusValidated() {
        ReadingCorpusValidator.validate(registry,corpus);
        assertThat(corpus.size()).isGreaterThanOrEqualTo(150);
        for (String field : List.of("sourceId","licenseCode","attribution","bodySha256","reviewStatus","sourceUrl","sourceSnapshotSha256","reviewedDate","transformationNote")) {
            JsonNode broken=corpus.deepCopy(); ((com.fasterxml.jackson.databind.node.ObjectNode)broken.get(0)).put(field,field.equals("transformationNote") ? "" : "unapproved");
            assertThatThrownBy(() -> ReadingCorpusValidator.validate(registry,broken)).as(field).isInstanceOf(IllegalArgumentException.class);
        }
        JsonNode duplicate=corpus.deepCopy(); ((com.fasterxml.jackson.databind.node.ArrayNode)duplicate).add(duplicate.get(0));
        assertThatThrownBy(() -> ReadingCorpusValidator.validate(registry,duplicate)).hasMessageContaining("Duplicate");
        JsonNode denied=registry.deepCopy(); for (var source : denied) ((com.fasterxml.jackson.databind.node.ObjectNode)source).put("fullTextAllowed",false);
        assertThatThrownBy(() -> ReadingCorpusValidator.validate(denied,corpus)).hasMessageContaining("rights");
    }
    @Test void dryRunOptInExactConfirmationIdempotencyAndUserPreservation() {
        jdbc.update("UPDATE reading_materials SET source_url=:url WHERE id IN (1,4)",Map.of("url",corpus.get(0).path("sourceUrl").asText()));
        var before=jdbc.queryForList("SELECT * FROM reading_materials ORDER BY id",Map.of());
        var preview=run(false,false,null);
        assertThat(preview.inserted()).isEqualTo(corpus.size());
        assertThat(jdbc.queryForList("SELECT * FROM reading_materials ORDER BY id",Map.of())).isEqualTo(before);
        assertThatThrownBy(() -> tx.execute(s -> importer(false).run(true,false,preview.manifestSha256()))).hasMessageContaining("disabled");
        assertThatThrownBy(() -> run(true,false,"incorrect")).hasMessageContaining("digest");
        assertThat(run(true,false,preview.manifestSha256()).inserted()).isEqualTo(corpus.size());
        var again=run(true,false,preview.manifestSha256());
        assertThat(again.inserted()).isZero(); assertThat(again.updated()).isZero(); assertThat(again.skipped()).isEqualTo(corpus.size());
        assertThat(jdbc.queryForList("SELECT * FROM reading_materials WHERE id<=4 ORDER BY id",Map.of())).isEqualTo(before);
    }
    @Test void changedOrDuplicateExistingContentRejectsAndRollsBack() {
        var preview=run(false,false,null); run(true,false,preview.manifestSha256());
        jdbc.getJdbcTemplate().execute("UPDATE reading_materials SET content_text='Externally changed' WHERE id=6");
        assertThatThrownBy(() -> run(true,false,preview.manifestSha256())).hasMessageContaining("update approval");
        assertThat(run(true,true,preview.manifestSha256()).updated()).isEqualTo(1);
        jdbc.getJdbcTemplate().execute("INSERT INTO reading_materials(title,source_url,is_system,owner_user_id) SELECT title,source_url,true,NULL FROM reading_materials WHERE id=5");
        assertThatThrownBy(() -> run(true,false,preview.manifestSha256())).hasMessageContaining("duplicate");
    }
    @Test void concurrentImportSerializesAndSecondRunSkips() throws Exception {
        String digest=run(false,false,null).manifestSha256();
        try (var pool=Executors.newFixedThreadPool(2)) {
            var a=pool.submit(() -> run(true,false,digest)); var b=pool.submit(() -> run(true,false,digest));
            var x=a.get(60,TimeUnit.SECONDS); var y=b.get(60,TimeUnit.SECONDS);
            assertThat(x.inserted()+y.inserted()).isEqualTo(corpus.size());
            assertThat(x.skipped()+y.skipped()).isEqualTo(corpus.size());
        }
    }
    @Test void metadataOnlyPaginationSearchFiltersRevisionAndIsolation() throws Exception {
        var preview=run(false,false,null); run(true,false,preview.manifestSha256());
        var service=new ReadingCatalogService(jdbc);
        var first=service.catalog(1L,"SYSTEM",0,18,"","","","recent");
        assertThat(first.totalElements()).isEqualTo(corpus.size()); assertThat(first.content()).hasSize(18);
        String json=new ObjectMapper().writeValueAsString(first);
        assertThat(json).doesNotContain("contentText","ownerUserId","scrollPercentage","A private","B private","Hidden");
        assertThat(json.length()).isLessThan(50000);
        var second=service.catalog(1L,"SYSTEM",1,18,"","","","recent");
        assertThat(first.content().stream().map(c -> c.id()).toList()).doesNotContainAnyElementsOf(second.content().stream().map(c -> c.id()).toList());
        assertThat(service.catalog(1L,"USER",0,18,"","","","recent").content()).extracting(c -> c.title()).containsExactly("A private");
        assertThat(service.catalog(2L,"USER",0,18,"","","","recent").content()).extracting(c -> c.title()).containsExactly("B private");
        assertThat(service.catalog(1L,"SYSTEM",0,18,"%","","","recent").totalElements()).isZero();
        assertThat(service.catalog(1L,"SYSTEM",0,18,"","unrecognized","","recent").totalElements()).isZero();
        var sample=first.content().get(0);
        assertThat(service.catalog(1L,"SYSTEM",0,18,"",sample.topic(),sample.difficultyLevel(),"recent").content()).allMatch(c -> c.topic().equals(sample.topic()) && c.difficultyLevel().equals(sample.difficultyLevel()));
        jdbc.getJdbcTemplate().execute("UPDATE reading_materials SET title='Changed title' WHERE id="+sample.id());
        service.evictSystemCatalog();
        assertThat(service.catalog(1L,"SYSTEM",0,18,"","","","recent").catalogRevision()).isNotEqualTo(first.catalogRevision());
        jdbc.getJdbcTemplate().execute("INSERT INTO user_reading_progress(reading_material_id,user_id,scroll_percentage,last_read_at) VALUES (1,1,40,NOW()),(2,2,80,NOW()),(4,1,30,NOW())");
        assertThat(service.progress(1L)).extracting(p -> p.materialId()).containsExactly(1L);
        assertThat(service.progress(2L)).extracting(p -> p.materialId()).containsExactly(2L);
        assertThatThrownBy(() -> service.catalog(null,"SYSTEM",0,18,"","","","recent")).isInstanceOf(org.springframework.security.access.AccessDeniedException.class);
    }
    @Test void catalogPayloadRemainsBoundedAtTenThousandRows() throws Exception {
        var preview=run(false,false,null); run(true,false,preview.manifestSha256());
        var service=new ReadingCatalogService(jdbc);
        var mapper=new ObjectMapper();
        long started=System.nanoTime();
        var curated=service.catalog(1L,"SYSTEM",0,18,"","","","recent");
        long curatedMicros=(System.nanoTime()-started)/1000;
        int curatedBytes=mapper.writeValueAsBytes(curated).length;
        jdbc.getJdbcTemplate().execute("INSERT INTO reading_materials(title,content_text,word_count,is_system,owner_user_id,created_at) SELECT 'Scale sample '||n,repeat('BODY_SENTINEL ',100),100,true,NULL,NOW() FROM generate_series(1,9850) n");
        service.evictSystemCatalog();
        started=System.nanoTime();
        var scaled=service.catalog(1L,"SYSTEM",0,18,"","","","recent");
        long scaledMicros=(System.nanoTime()-started)/1000;
        byte[] response=mapper.writeValueAsBytes(scaled);
        assertThat(scaled.totalElements()).isEqualTo(10000);
        assertThat(scaled.content()).hasSize(18);
        assertThat(response.length).isLessThan(30000);
        assertThat(new String(response,java.nio.charset.StandardCharsets.UTF_8)).doesNotContain("BODY_SENTINEL","contentText","content_text");
        assertThat(service.catalog(1L,"SYSTEM",555,18,"","","","recent").content()).hasSize(10);
        System.out.printf("READING_CATALOG_SAMPLE curatedRows=150 pageSize=18 bytes=%d serviceMicros=%d scaledRows=10000 bytes=%d serviceMicros=%d (disposable PostgreSQL; not production API/paint timing)%n",curatedBytes,curatedMicros,response.length,scaledMicros);
    }
}
