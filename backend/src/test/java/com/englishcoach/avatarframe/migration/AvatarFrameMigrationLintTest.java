package com.englishcoach.avatarframe.migration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.file.Files;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

class AvatarFrameMigrationLintTest {

    private static final String MIGRATION_PATH = "src/main/resources/db/migration/exams/V51__avatar_frame_core.sql";

    @Test
    @DisplayName("Migration Lint: V51 exists, adheres to table contracts, and seeds exactly 14 frames")
    void testMigrationLint() throws Exception {
        File migrationFile = new File(MIGRATION_PATH);
        if (!migrationFile.exists()) {
            migrationFile = new File("backend/" + MIGRATION_PATH);
        }
        assertThat(migrationFile).exists();
        assertThat(migrationFile.getName()).isEqualTo("V51__avatar_frame_core.sql");

        String sql = Files.readString(migrationFile.toPath());

        // 1. Verify table creations
        assertThat(sql).containsIgnoringCase("CREATE TABLE IF NOT EXISTS public.avatar_frame_series");
        assertThat(sql).containsIgnoringCase("CREATE TABLE IF NOT EXISTS public.avatar_frames");
        assertThat(sql).containsIgnoringCase("CREATE TABLE IF NOT EXISTS public.avatar_frame_requirements");
        assertThat(sql).containsIgnoringCase("CREATE TABLE IF NOT EXISTS public.user_avatar_frames");

        // 2. Verify single equipped frame partial unique index
        assertThat(sql).containsIgnoringCase("idx_user_avatar_frames_single_equipped");
        assertThat(sql).containsIgnoringCase("WHERE is_equipped = TRUE");

        // 3. Verify user foreign key on delete restrict (Rule: User data isolation law)
        assertThat(sql).containsIgnoringCase("REFERENCES public.users(id) ON DELETE RESTRICT");

        // 4. Verify exactly 14 frame inserts
        Pattern frameInsertPattern = Pattern.compile("INSERT\\s+INTO\\s+public\\.avatar_frames\\s*\\([\\s\\S]*?\\)\\s*VALUES\\s*\\((\\d+),", Pattern.CASE_INSENSITIVE);
        Matcher matcher = frameInsertPattern.matcher(sql);
        int frameCount = 0;
        while (matcher.find()) {
            frameCount++;
        }
        assertThat(frameCount)
                .as("Phase 1 seed contract requires exactly 14 prototype catalogue frames")
                .isEqualTo(14);

        // 5. Verify the prototype slugs
        String[] expectedSlugs = {
                "streak_flame_stage_1",
                "streak_flame_stage_2",
                "streak_flame_stage_3",
                "vocab_mastery_stage_1",
                "vocab_mastery_stage_2",
                "vocab_mastery_stage_3",
                "cefr_b2_scholar",
                "cefr_c1_master",
                "cefr_c2_sage",
                "ranked_gold",
                "ranked_master",
                "ranked_challenger",
                "legacy_founder_2026",
                "sss_dragon_emperor"
        };
        for (String slug : expectedSlugs) {
            assertThat(sql).contains("'" + slug + "'");
        }

        // 6. Verify zero fabricated economy (Rule 3)
        assertThat(sql.toLowerCase()).doesNotContain("knowledge_coins");
        assertThat(sql.toLowerCase()).doesNotContain("gems");
        assertThat(sql.toLowerCase()).doesNotContain("wallet");
    }
}
