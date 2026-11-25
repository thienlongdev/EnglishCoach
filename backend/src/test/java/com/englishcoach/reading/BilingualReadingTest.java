package com.englishcoach.reading;

import com.englishcoach.reading.service.BilingualReadingImporter;
import com.englishcoach.reading.service.BilingualReadingService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.*;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import static org.assertj.core.api.Assertions.*;

/** Disposable PostgreSQL qualification; never uses application database credentials. */
class BilingualReadingTest {
    static PostgreSQLContainer<?> db;
    static NamedParameterJdbcTemplate jdbc;
    static TransactionTemplate tx;
    @BeforeAll static void setup() throws Exception {
        db = new PostgreSQLContainer<>("postgres:17"); db.start();
        var ds = new DriverManagerDataSource(db.getJdbcUrl(), db.getUsername(), db.getPassword());
        jdbc = new NamedParameterJdbcTemplate(ds);
        tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
        try (var in = new ClassPathResource("db/migration/exams/V75__bilingual_reading.sql").getInputStream()) {
            jdbc.getJdbcTemplate().execute(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }
    @AfterAll static void stop() { if (db != null) db.stop(); }
    @BeforeEach void clear() { jdbc.getJdbcTemplate().execute("TRUNCATE public.bilingual_reading_segments,public.bilingual_reading_materials RESTART IDENTITY"); }
    BilingualReadingImporter.Result run(boolean apply, boolean updates, String digest) {
        return tx.execute(s -> new BilingualReadingImporter(jdbc, true).run(apply, updates, digest));
    }
    @Test void dryRunConfirmationIdempotencyAndSegmentRepair() {
        var preview = run(false, false, null);
        assertThat(preview.inserted()).isEqualTo(194);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM public.bilingual_reading_materials", Map.of(), Integer.class)).isZero();
        assertThatThrownBy(() -> run(true, false, "wrong")).hasMessageContaining("digest");
        assertThat(run(true, false, preview.manifestSha256()).inserted()).isEqualTo(194);
        var repeat = run(true, false, preview.manifestSha256());
        assertThat(repeat.inserted()).isZero(); assertThat(repeat.updated()).isZero(); assertThat(repeat.skipped()).isEqualTo(194);
        jdbc.getJdbcTemplate().execute("DELETE FROM public.bilingual_reading_segments WHERE material_id=1 AND position=1");
        assertThatThrownBy(() -> run(true, false, preview.manifestSha256())).hasMessageContaining("update approval");
        assertThat(run(true, true, preview.manifestSha256()).updated()).isEqualTo(1);
    }
    @Test void countsMetadataDetailPairOrderAndMissingTitle() throws Exception {
        var preview = run(false, false, null); run(true, false, preview.manifestSha256());
        var service = new BilingualReadingService(jdbc);
        var catalog = service.catalog("");
        assertThat(catalog.totalElements()).isEqualTo(194);
        assertThat(catalog.articleCount()).isEqualTo(112); assertThat(catalog.storyCount()).isEqualTo(82);
        assertThat(service.catalog("ARTICLE").content()).hasSize(112);
        assertThat(service.catalog("STORY").content()).hasSize(82);
        assertThat(catalog.content().stream().filter(c -> c.titleVi() == null)).hasSize(12);
        String encoded = new ObjectMapper().writeValueAsString(catalog);
        assertThat(encoded).doesNotContain("segments", "sourceHash", "ownerUserId", "text_en", "canonicalDocument");
        assertThat(encoded.length()).isLessThan(100_000);
        for (var card : catalog.content()) {
            var detail = service.detail(card.id());
            assertThat(detail.segments()).isNotEmpty();
            for (int i=0; i<detail.segments().size(); i++) {
                assertThat(detail.segments().get(i).position()).isEqualTo(i+1);
                assertThat(detail.segments().get(i).en()).isNotBlank(); assertThat(detail.segments().get(i).vi()).isNotBlank();
            }
        }
        assertThatThrownBy(() -> service.detail(99999L)).isInstanceOf(org.springframework.web.server.ResponseStatusException.class);
        assertThatThrownBy(() -> service.catalog("PRIVATE")).isInstanceOf(IllegalArgumentException.class);
    }
}
