package com.englishcoach.avatarframe.migration;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * V67 against PostgreSQL 17 after the real V51 + V55: the three RANKED frames move from the unreachable PVP_RANK
 * thresholds to LEARNING_XP 1 000 / 10 000 / 30 000 (one requirement each), unlock type METRIC_THRESHOLD, no "rank"
 * manifest key; every other frame requirement unchanged; re-running V67 changes nothing; a RANK-source grant fits the CHECK.
 */
@Testcontainers(disabledWithoutDocker = true)
class AvatarFrameRankedXpMigrationTest {

    private static final Path DIR = Path.of("src/main/resources/db/migration/exams");
    private static PostgreSQLContainer<?> pg;
    private static Connection c;

    @BeforeAll
    static void start() throws Exception {
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        c = DriverManager.getConnection(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Statement st = c.createStatement()) {
            st.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY); INSERT INTO public.users VALUES (1);");
            for (String f : new String[]{"V51__avatar_frame_core.sql", "V55__avatar_frame_expansion.sql",
                    "V67__avatar_frame_ranked_learning_xp.sql"}) {
                st.execute(Files.readString(DIR.resolve(f)));
            }
        }
    }

    @AfterAll
    static void stop() throws Exception {
        if (c != null) c.close();
        if (pg != null) pg.stop();
    }

    private static Map<String, String> requirements(String where) throws Exception {
        Map<String, String> out = new LinkedHashMap<>();
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("""
                SELECT f.slug, r.metric_type || ' ' || r.operator || ' ' || r.target_value AS req
                FROM public.avatar_frames f JOIN public.avatar_frame_requirements r ON r.frame_id = f.id
                WHERE""" + " " + where + " ORDER BY f.id, r.id")) {
            while (rs.next()) out.merge(rs.getString(1), rs.getString(2), (a, b) -> a + " | " + b);
        }
        return out;
    }

    @Test
    @DisplayName("Vàng / Cao Thủ / Thách Đấu Ngôn Ngữ unlock on LEARNING_XP 1 000 / 10 000 / 30 000; no PVP_RANK requirement left")
    void rankedFramesUseLearningXp() throws Exception {
        assertThat(requirements("f.slug LIKE 'ranked_%'")).containsExactly(
                Map.entry("ranked_gold", "LEARNING_XP GTE 1000"),
                Map.entry("ranked_master", "LEARNING_XP GTE 10000"),
                Map.entry("ranked_challenger", "LEARNING_XP GTE 30000"));
        assertThat(requirements("r.metric_type = 'PVP_RANK'")).isEmpty();
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery("""
                SELECT COUNT(*) FROM public.avatar_frames
                WHERE slug LIKE 'ranked_%' AND unlock_type = 'METRIC_THRESHOLD' AND manifest_json -> 'rank' IS NULL""")) {
            rs.next();
            assertThat(rs.getInt(1)).isEqualTo(3);
        }
    }

    @Test
    @DisplayName("Other frames keep their requirements; V67 is idempotent; a RANK-source grant satisfies the source CHECK")
    void othersUntouchedAndIdempotent() throws Exception {
        Map<String, String> before = requirements("f.slug NOT LIKE 'ranked_%'");
        assertThat(before).containsEntry("streak_flame_stage_1", "STREAK_DAYS GTE 7")
                .containsEntry("cefr_c2_sage", "CEFR_LEVEL EQUALS C2");
        try (Statement st = c.createStatement()) {
            st.execute(Files.readString(DIR.resolve("V67__avatar_frame_ranked_learning_xp.sql")));
        }
        assertThat(requirements("f.slug NOT LIKE 'ranked_%'")).isEqualTo(before);
        assertThat(requirements("f.slug LIKE 'ranked_%'")).hasSize(3).allSatisfy((k, v) -> assertThat(v).startsWith("LEARNING_XP"));
        try (Statement st = c.createStatement()) {
            st.execute("""
                    INSERT INTO public.user_avatar_frames (user_id, frame_id, source, is_equipped)
                    SELECT 1, id, 'RANK', FALSE FROM public.avatar_frames WHERE slug = 'ranked_gold'""");
        }
    }
}
