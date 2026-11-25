package com.englishcoach.speaking.shadowing;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.common.security.UserDetailsImpl;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.containers.PostgreSQLContainer;

import javax.sql.DataSource;
import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * PostgreSQL 17 integration and security verification for {@link SpeakingShadowingCatalogController}
 * and {@link SpeakingShadowingCatalogService}.
 */
class SpeakingShadowingCatalogTest {

    private static PostgreSQLContainer<?> postgres;
    private static JdbcTemplate adminJdbc;
    private static SpeakingShadowingCatalogService service;
    private static SpeakingShadowingCatalogController controller;
    private static final AtomicInteger sqlQueryCounter = new AtomicInteger();
    private static final List<String> executedSqlStatements = new ArrayList<>();
    private static final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeAll
    static void startPostgres() throws Exception {
        postgres = new PostgreSQLContainer<>("postgres:17");
        postgres.start();

        DriverManagerDataSource rawDs = new DriverManagerDataSource(
                postgres.getJdbcUrl(),
                postgres.getUsername(),
                postgres.getPassword()
        );
        adminJdbc = new JdbcTemplate(rawDs);

        try (Connection conn = rawDs.getConnection(); Statement st = conn.createStatement()) {
            st.execute("""
                    CREATE TABLE public.users (
                        id BIGINT PRIMARY KEY,
                        email VARCHAR(255) NOT NULL
                    );
                    INSERT INTO public.users (id, email) VALUES (101, 'alice@example.com'), (202, 'bob@example.com');

                    CREATE TABLE public.listening_materials (
                        id BIGSERIAL PRIMARY KEY,
                        title VARCHAR(500) NOT NULL,
                        audio_url VARCHAR(1000) NOT NULL,
                        source_type VARCHAR(16) DEFAULT 'VIDEO',
                        voice_id VARCHAR(16),
                        duration_seconds INTEGER,
                        cefr_level VARCHAR(16),
                        topic VARCHAR(255),
                        accent VARCHAR(64),
                        owner_user_id BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
                        is_system BOOLEAN NOT NULL DEFAULT FALSE,
                        channel VARCHAR(255),
                        thumbnail VARCHAR(500),
                        youtube_video_id VARCHAR(50)
                    );

                    CREATE TABLE public.transcript_segments (
                        id BIGSERIAL PRIMARY KEY,
                        listening_material_id BIGINT NOT NULL REFERENCES public.listening_materials(id) ON DELETE CASCADE,
                        text TEXT NOT NULL,
                        words_json TEXT
                    );
                    """);
        }

        DataSource countingDs = wrapCountingDataSource(rawDs);
        service = new SpeakingShadowingCatalogService(new NamedParameterJdbcTemplate(countingDs));
        controller = new SpeakingShadowingCatalogController(service);
    }

    @AfterAll
    static void stopPostgres() {
        if (postgres != null) {
            postgres.stop();
        }
    }

    @BeforeEach
    void resetData() {
        adminJdbc.execute("TRUNCATE TABLE public.transcript_segments, public.listening_materials RESTART IDENTITY CASCADE");
        sqlQueryCounter.set(0);
        executedSqlStatements.clear();
    }

    private static DataSource wrapCountingDataSource(DataSource delegate) {
        return (DataSource) Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[]{DataSource.class},
                (proxy, method, args) -> {
                    Object result = method.invoke(delegate, args);
                    if ("getConnection".equals(method.getName()) && result instanceof Connection conn) {
                        return Proxy.newProxyInstance(
                                Connection.class.getClassLoader(),
                                new Class<?>[]{Connection.class},
                                (cProxy, cMethod, cArgs) -> {
                                    if (("prepareStatement".equals(cMethod.getName()) || "createStatement".equals(cMethod.getName()))
                                            && cArgs != null && cArgs.length > 0 && cArgs[0] instanceof String sql) {
                                        sqlQueryCounter.incrementAndGet();
                                        executedSqlStatements.add(sql);
                                    }
                                    return cMethod.invoke(conn, cArgs);
                                }
                        );
                    }
                    return result;
                }
        );
    }

    private static UserDetailsImpl principal(long id, String email) {
        User u = User.builder()
                .id(id)
                .email(email)
                .role(Role.ROLE_USER)
                .accountStatus("ACTIVE")
                .build();
        return UserDetailsImpl.build(u);
    }

    private long insertMaterial(
            String title,
            String audioUrl,
            String sourceType,
            Integer durationSeconds,
            String cefr,
            String topic,
            String accent,
            Long ownerUserId,
            boolean isSystem,
            String channel,
            String thumbnail,
            String youtubeVideoId
    ) {
        Long id = adminJdbc.queryForObject(
                """
                INSERT INTO public.listening_materials
                    (title, audio_url, source_type, duration_seconds, cefr_level, topic, accent,
                     owner_user_id, is_system, channel, thumbnail, youtube_video_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id
                """,
                Long.class,
                title, audioUrl, sourceType, durationSeconds, cefr, topic, accent,
                ownerUserId, isSystem, channel, thumbnail, youtubeVideoId
        );
        adminJdbc.update(
                "INSERT INTO public.transcript_segments (listening_material_id, text, words_json) VALUES (?, ?, ?)",
                id,
                "Heavy transcript segment text that must never be fetched by catalog",
                "[{\"word\":\"Heavy\",\"start\":0.0,\"end\":0.5}]"
        );
        return id;
    }

    @Test
    @DisplayName("Paginates 12 cards per page in deterministic id DESC order with single-RTT window count and zero transcript queries")
    void paginatesDeterministicallyInSingleRoundTrip() throws Exception {
        for (int i = 1; i <= 28; i++) {
            String vid = String.format("vid_%07d", i);
            insertMaterial(
                    "System Lesson " + i,
                    "https://www.youtube.com/watch?v=" + vid,
                    "VIDEO",
                    180 + i,
                    (i % 2 == 0) ? "B1" : "B2",
                    "Ideas & Talks",
                    "American",
                    null,
                    true,
                    "TED",
                    null,
                    null
            );
        }

        sqlQueryCounter.set(0);
        executedSqlStatements.clear();

        ResponseEntity<ShadowingCatalogPageDto> p0Resp = controller.getCatalog(
                principal(101L, "alice@example.com"),
                0, 12, null, null, null, "ALL", null
        );
        assertThat(p0Resp.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(p0Resp.getHeaders().getFirst(HttpHeaders.CACHE_CONTROL)).contains("no-store");

        ShadowingCatalogPageDto p0 = p0Resp.getBody();
        assertThat(p0).isNotNull();
        assertThat(p0.page()).isEqualTo(0);
        assertThat(p0.size()).isEqualTo(12);
        assertThat(p0.totalElements()).isEqualTo(28L);
        assertThat(p0.totalPages()).isEqualTo(3);
        assertThat(p0.hasPrevious()).isFalse();
        assertThat(p0.hasNext()).isTrue();
        assertThat(p0.content()).hasSize(12);

        // Single-RTT window query proof & zero transcript_segments access
        assertThat(sqlQueryCounter.get()).isEqualTo(1);
        assertThat(executedSqlStatements.get(0)).doesNotContainIgnoringCase("transcript_segments");
        assertThat(executedSqlStatements.get(0)).doesNotContainIgnoringCase("words_json");

        // Fallback YouTube video ID + thumbnail derived cleanly without exposing audioUrl/segments in JSON
        ShadowingMaterialCardDto newest = p0.content().get(0);
        assertThat(newest.title()).isEqualTo("System Lesson 28");
        assertThat(newest.youtubeVideoId()).isEqualTo("vid_0000028");
        assertThat(newest.thumbnail()).isEqualTo("https://i.ytimg.com/vi/vid_0000028/hqdefault.jpg");
        assertThat(newest.isSystem()).isTrue();

        JsonNode json = objectMapper.readTree(objectMapper.writeValueAsBytes(p0));
        JsonNode firstJson = json.get("content").get(0);
        assertThat(firstJson.has("isSystem")).isTrue();
        assertThat(firstJson.has("system")).isFalse();
        assertThat(firstJson.has("segments")).isFalse();
        assertThat(firstJson.has("audioUrl")).isFalse();
        assertThat(firstJson.has("ownerUserId")).isFalse();

        // Walk all 3 pages and verify strict descending IDs and 0 duplicates/gaps
        ShadowingCatalogPageDto p1 = controller.getCatalog(
                principal(101L, "alice@example.com"),
                1, 12, null, null, null, "ALL", null
        ).getBody();
        ShadowingCatalogPageDto p2 = controller.getCatalog(
                principal(101L, "alice@example.com"),
                2, 12, null, null, null, "ALL", null
        ).getBody();

        assertThat(p1).isNotNull();
        assertThat(p1.content()).hasSize(12);
        assertThat(p1.hasPrevious()).isTrue();
        assertThat(p1.hasNext()).isTrue();

        assertThat(p2).isNotNull();
        assertThat(p2.content()).hasSize(4);
        assertThat(p2.hasPrevious()).isTrue();
        assertThat(p2.hasNext()).isFalse();

        List<Long> allIds = new ArrayList<>();
        p0.content().forEach(c -> allIds.add(c.id()));
        p1.content().forEach(c -> allIds.add(c.id()));
        p2.content().forEach(c -> allIds.add(c.id()));
        assertThat(allIds).hasSize(28);
        Set<Long> uniqueIds = new HashSet<>(allIds);
        assertThat(uniqueIds).hasSize(28);
        for (int i = 1; i < allIds.size(); i++) {
            assertThat(allIds.get(i - 1)).isGreaterThan(allIds.get(i));
        }

        // Out-of-bounds page preserves true totalElements & totalPages
        ShadowingCatalogPageDto outOfBounds = controller.getCatalog(
                principal(101L, "alice@example.com"),
                9, 12, null, null, null, "ALL", null
        ).getBody();
        assertThat(outOfBounds).isNotNull();
        assertThat(outOfBounds.content()).isEmpty();
        assertThat(outOfBounds.totalElements()).isEqualTo(28L);
        assertThat(outOfBounds.totalPages()).isEqualTo(3);
    }

    @Test
    @DisplayName("AGENTS.md §21 P0 Isolation: excludes foreign private rows, quarantined unowned rows, anomalous system+owner rows, and DOCUMENT materials")
    void enforcesStrictUserIsolationAndDocumentExclusion() {
        long sysId = insertMaterial(
                "Shared System Lesson", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "VIDEO",
                120, "B1", "Culture", "British", null, true, "BBC", null, "dQw4w9WgXcQ"
        );
        long aliceVideoId = insertMaterial(
                "Alice Private Video", "https://www.youtube.com/watch?v=aaaaaaaaaaa", "VIDEO",
                90, "B2", "Work", "American", 101L, false, "Alice Channel", null, "aaaaaaaaaaa"
        );
        long aliceDocId = insertMaterial(
                "Alice Uploaded Document", "/storage/doc.wav", "DOCUMENT",
                60, "B2", "Work", "American", 101L, false, null, null, null
        );
        long bobVideoId = insertMaterial(
                "Bob Private Video", "https://www.youtube.com/watch?v=bbbbbbbbbbb", "VIDEO",
                95, "C1", "Science", "American", 202L, false, "Bob Channel", null, "bbbbbbbbbbb"
        );
        long quarantinedId = insertMaterial(
                "Quarantined Legacy Row", "https://www.youtube.com/watch?v=qqqqqqqqqqq", "VIDEO",
                110, "A2", "General", "American", null, false, "Legacy", null, "qqqqqqqqqqq"
        );
        long anomalousSystemOwnedId = insertMaterial(
                "Anomalous System Row With Owner", "https://www.youtube.com/watch?v=zzzzzzzzzzz", "VIDEO",
                100, "A2", "General", "American", 101L, true, "Corrupt", null, "zzzzzzzzzzz"
        );

        UserDetailsImpl alice = principal(101L, "alice@example.com");
        UserDetailsImpl bob = principal(202L, "bob@example.com");

        // Alice ALL -> sees ONLY sysId and aliceVideoId (NOT aliceDocId, NOT bobVideoId, NOT quarantinedId, NOT anomalousSystemOwnedId)
        ShadowingCatalogPageDto aliceAll = controller.getCatalog(alice, 0, 12, null, null, null, "ALL", null).getBody();
        assertThat(aliceAll).isNotNull();
        assertThat(aliceAll.content()).extracting(ShadowingMaterialCardDto::id)
                .containsExactly(aliceVideoId, sysId);

        // Alice SYSTEM -> sees ONLY sysId
        ShadowingCatalogPageDto aliceSys = controller.getCatalog(alice, 0, 12, null, null, null, "SYSTEM", null).getBody();
        assertThat(aliceSys).isNotNull();
        assertThat(aliceSys.content()).extracting(ShadowingMaterialCardDto::id).containsExactly(sysId);

        // Alice USER -> sees ONLY aliceVideoId
        ShadowingCatalogPageDto aliceUser = controller.getCatalog(alice, 0, 12, null, null, null, "USER", null).getBody();
        assertThat(aliceUser).isNotNull();
        assertThat(aliceUser.content()).extracting(ShadowingMaterialCardDto::id).containsExactly(aliceVideoId);

        // Bob ALL -> sees ONLY sysId and bobVideoId
        ShadowingCatalogPageDto bobAll = controller.getCatalog(bob, 0, 12, null, null, null, "ALL", null).getBody();
        assertThat(bobAll).isNotNull();
        assertThat(bobAll.content()).extracting(ShadowingMaterialCardDto::id)
                .containsExactly(bobVideoId, sysId);

        // Single-card lookup enforces identical 404 boundaries
        assertThat(controller.getCatalogCardById(alice, aliceVideoId).getBody()).isNotNull();
        assertThat(controller.getCatalogCardById(alice, sysId).getBody()).isNotNull();

        for (long forbiddenForAlice : List.of(bobVideoId, quarantinedId, aliceDocId, anomalousSystemOwnedId)) {
            assertThatThrownBy(() -> controller.getCatalogCardById(alice, forbiddenForAlice))
                    .isInstanceOf(ResponseStatusException.class)
                    .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        }
    }

    @Test
    @DisplayName("Clamps size to 1..24, filters by CEFR and accent, escapes SQL LIKE wildcards in q, and rejects anonymous callers")
    void clampsSizeFiltersAndEscapesWildcardSearch() {
        insertMaterial(
                "100% Natural_Speech \\ Guide", "https://www.youtube.com/watch?v=11111111111", "VIDEO",
                150, "C1", "Pronunciation", "British", null, true, "Oxford Studio", null, "11111111111"
        );
        insertMaterial(
                "1000 NaturalXSpeech Guide", "https://www.youtube.com/watch?v=22222222222", "VIDEO",
                150, "B1", "Daily English", "American", null, true, "US Studio", null, "22222222222"
        );
        for (int i = 0; i < 30; i++) {
            insertMaterial(
                    "Extra Lesson " + i, "https://www.youtube.com/watch?v=333333333" + String.format("%02d", i), null,
                    80, "A2", "Basics", "Australian", 101L, false, "Aussie", null, null
            );
        }

        UserDetailsImpl alice = principal(101L, "alice@example.com");

        // Size clamped 1..24
        ShadowingCatalogPageDto clampedHigh = controller.getCatalog(alice, -3, 999, null, null, null, "ALL", null).getBody();
        assertThat(clampedHigh).isNotNull();
        assertThat(clampedHigh.page()).isZero();
        assertThat(clampedHigh.size()).isEqualTo(24);
        assertThat(clampedHigh.content()).hasSize(24);

        ShadowingCatalogPageDto clampedLow = controller.getCatalog(alice, 0, 0, null, null, null, "ALL", null).getBody();
        assertThat(clampedLow).isNotNull();
        assertThat(clampedLow.size()).isEqualTo(1);
        assertThat(clampedLow.content()).hasSize(1);

        // Escaped %, _, and \ search matches ONLY the literal title, not "1000 NaturalXSpeech"
        ShadowingCatalogPageDto pctMatch = controller.getCatalog(alice, 0, 12, null, null, null, "ALL", "100%").getBody();
        assertThat(pctMatch).isNotNull();
        assertThat(pctMatch.content()).extracting(ShadowingMaterialCardDto::title)
                .containsExactly("100% Natural_Speech \\ Guide");

        ShadowingCatalogPageDto underscoreMatch = controller.getCatalog(alice, 0, 12, null, null, null, "ALL", "Natural_Speech").getBody();
        assertThat(underscoreMatch).isNotNull();
        assertThat(underscoreMatch.content()).extracting(ShadowingMaterialCardDto::title)
                .containsExactly("100% Natural_Speech \\ Guide");

        ShadowingCatalogPageDto backslashMatch = controller.getCatalog(alice, 0, 12, null, null, null, "ALL", "\\ Guide").getBody();
        assertThat(backslashMatch).isNotNull();
        assertThat(backslashMatch.content()).extracting(ShadowingMaterialCardDto::title)
                .containsExactly("100% Natural_Speech \\ Guide");

        // CEFR + Accent filtering
        ShadowingCatalogPageDto filtered = controller.getCatalog(alice, 0, 12, "c1", null, "british", "ALL", null).getBody();
        assertThat(filtered).isNotNull();
        assertThat(filtered.totalElements()).isEqualTo(1L);
        assertThat(filtered.content().get(0).cefrLevel()).isEqualTo("C1");

        // Invalid source -> 400
        assertThatThrownBy(() -> controller.getCatalog(alice, 0, 12, null, null, null, "PUBLIC_DUMP", null))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));

        // Anonymous caller -> AccessDeniedException, plus WebSecurityConfig protects /api/v1/speaking/**
        assertThatThrownBy(() -> controller.getCatalog(null, 0, 12, null, null, null, "ALL", null))
                .isInstanceOf(AccessDeniedException.class);
        assertThatThrownBy(() -> controller.getCatalogCardById(null, 1L))
                .isInstanceOf(AccessDeniedException.class);
    }

    @Test
    @DisplayName("WebSecurityConfig keeps /api/v1/speaking/shadowing/** authenticated (never permitAll)")
    void webSecurityConfigProtectsShadowingEndpoints() throws Exception {
        String securityConfig = Files.readString(Path.of("src/main/java/com/englishcoach/common/security/WebSecurityConfig.java"));
        assertThat(securityConfig).contains(".requestMatchers(\"/api/v1/speaking/**\").authenticated()");
        assertThat(securityConfig).doesNotContain("/api/v1/speaking/shadowing");
    }
}
