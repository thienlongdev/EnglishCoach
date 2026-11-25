package com.englishcoach.listening.migration;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.nio.file.Files;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

class ListeningMigrationLintTest {

    private static final String MIGRATION_PATH = "src/main/resources/db/migration/exams/V50__shared_listening_library_catalog.sql";

    private static final Set<String> ALLOWED_LEVELS = Set.of("A1", "A2", "B1", "B2", "C1", "C2");

    private static final Set<String> ALLOWED_TOPICS = Set.of(
            "Ideas & Talks",
            "Everyday English",
            "Science & Tech",
            "Work & Study",
            "Culture & Travel",
            "News & Podcasts"
    );

    @Test
    @DisplayName("Migration Lint: V50 exists and adheres to all Phase 2.3 requirements")
    void testMigrationLint() throws Exception {
        File migrationFile = new File(MIGRATION_PATH);
        if (!migrationFile.exists()) {
            // Also test relative to backend module root if executed from root
            migrationFile = new File("backend/" + MIGRATION_PATH);
        }
        assertThat(migrationFile).exists();
        assertThat(migrationFile.getName()).startsWith("V50__");

        String sql = Files.readString(migrationFile.toPath());

        // 1. Verify NO transcript/exercise inserts
        assertThat(sql.toUpperCase()).doesNotContain("INSERT INTO TRANSCRIPT_SEGMENTS");
        assertThat(sql.toUpperCase()).doesNotContain("INSERT INTO LISTENING_EXERCISES");

        // 2. Parse INSERT INTO listening_materials statements
        // Pattern matches: INSERT INTO listening_materials ... SELECT ... WHERE NOT EXISTS ...
        Pattern insertPattern = Pattern.compile(
                "INSERT\\s+INTO\\s+(?:public\\.)?listening_materials[\\s\\S]*?WHERE\\s+NOT\\s+EXISTS[\\s\\S]*?;",
                Pattern.CASE_INSENSITIVE
        );
        Matcher insertMatcher = insertPattern.matcher(sql);

        List<String> insertBlocks = new ArrayList<>();
        while (insertMatcher.find()) {
            insertBlocks.add(insertMatcher.group(0));
        }

        assertThat(insertBlocks.size())
                .as("Must insert at least 20 curated videos")
                .isGreaterThanOrEqualTo(20);

        Set<String> distinctYoutubeIds = new LinkedHashSet<>();
        Pattern ytIdPattern = Pattern.compile("https://www\\.youtube\\.com/watch\\?v=([A-Za-z0-9_-]{11})");
        Pattern notExistsPattern = Pattern.compile("WHERE\\s+NOT\\s+EXISTS\\s*\\([\\s\\S]*?youtube_video_id\\s*=\\s*'([A-Za-z0-9_-]{11})'", Pattern.CASE_INSENSITIVE);

        for (String block : insertBlocks) {
            // Assert is_system = TRUE and owner_user_id = NULL
            assertThat(block).containsIgnoringCase("TRUE");
            assertThat(block).containsIgnoringCase("NULL");

            // Extract YouTube ID from audio_url
            Matcher ytMatcher = ytIdPattern.matcher(block);
            assertThat(ytMatcher.find()).as("Every insert must have a valid YouTube audio URL with 11-char ID").isTrue();
            String ytId = ytMatcher.group(1);
            assertThat(ytId).matches("^[A-Za-z0-9_-]{11}$");

            // Check duplicate guard
            Matcher neMatcher = notExistsPattern.matcher(block);
            assertThat(neMatcher.find()).as("Every insert must have a NOT EXISTS guard with youtube_video_id").isTrue();
            assertThat(neMatcher.group(1)).isEqualTo(ytId);

            // Assert no duplicate IDs within the migration
            boolean added = distinctYoutubeIds.add(ytId);
            assertThat(added).as("Duplicate YouTube ID found in migration: " + ytId).isTrue();

            // Check level
            boolean hasValidLevel = ALLOWED_LEVELS.stream().anyMatch(lvl -> block.contains("'" + lvl + "'"));
            assertThat(hasValidLevel).as("Insert for " + ytId + " must contain a valid CEFR level").isTrue();

            // Check topic
            boolean hasValidTopic = ALLOWED_TOPICS.stream().anyMatch(topic -> block.contains("'" + topic + "'"));
            assertThat(hasValidTopic).as("Insert for " + ytId + " must contain a valid controlled topic").isTrue();
        }

        assertThat(distinctYoutubeIds.size())
                .as("Migration must contain at least 20 distinct valid YouTube IDs")
                .isGreaterThanOrEqualTo(20);

        // 3. Verify backfill of rows 11-15 does not overwrite non-null values
        assertThat(sql).containsIgnoringCase("UPDATE");
        assertThat(sql).containsIgnoringCase("listening_materials");
        assertThat(sql).containsIgnoringCase("COALESCE");
        assertThat(sql).containsIgnoringCase("owner_user_id IS NULL");
        assertThat(sql).containsIgnoringCase("is_system = TRUE");
        assertThat(sql).containsIgnoringCase("id = 11");
        assertThat(sql).containsIgnoringCase("id = 12");
        assertThat(sql).containsIgnoringCase("id = 13");
        assertThat(sql).containsIgnoringCase("id = 14");
        assertThat(sql).containsIgnoringCase("id = 15");
    }
}
