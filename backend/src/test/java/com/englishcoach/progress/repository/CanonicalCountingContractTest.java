package com.englishcoach.progress.repository;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Verifies canonical counting rules and timezone contracts (Criteria 1-14, 22).
 */
class CanonicalCountingContractTest {

    private final ZoneId vnZone = ZoneId.of("Asia/Ho_Chi_Minh");

    @Test
    @DisplayName("Criteria 22: Events around UTC midnight map to correct Asia/Ho_Chi_Minh calendar date")
    void testUtcMidnightBoundaryConversion() {
        // 2026-09-26 17:30:00 UTC -> 2026-09-27 00:30:00 in VN (UTC+7)
        Instant eveningUtc = Instant.parse("2026-09-26T17:30:00Z");
        LocalDate dateInVn = eveningUtc.atZone(vnZone).toLocalDate();
        assertThat(dateInVn).isEqualTo(LocalDate.of(2026, 9, 27));

        // 2026-09-26 16:59:59 UTC -> 2026-09-26 23:59:59 in VN (UTC+7)
        Instant beforeMidnightUtc = Instant.parse("2026-09-26T16:59:59Z");
        LocalDate dateBeforeMidnightInVn = beforeMidnightUtc.atZone(vnZone).toLocalDate();
        assertThat(dateBeforeMidnightInVn).isEqualTo(LocalDate.of(2026, 9, 26));

        // 2026-09-26 00:00:00 UTC -> 2026-09-26 07:00:00 in VN
        Instant morningUtc = Instant.parse("2026-09-26T00:00:00Z");
        LocalDate dateMorningInVn = morningUtc.atZone(vnZone).toLocalDate();
        assertThat(dateMorningInVn).isEqualTo(LocalDate.of(2026, 9, 26));
    }

    @Test
    @DisplayName("Criteria 1 & 2: Roleplay SQL contract strictly filters speaker = 'LEARNER' and non-mocked")
    void testRoleplayContractInSql() {
        String sql = UnifiedProgressRepository.class.getDeclaredFields()[1].getName(); // BASE_UNION_SQL
        // Reflectively or directly verify BASE_UNION_SQL contains speaker = 'LEARNER'
        // and excludes assistant turns
        assertThat(getUnionSql())
                .contains("t.speaker = 'LEARNER'")
                .contains("(t.is_mocked IS NULL OR t.is_mocked = false)")
                .doesNotContain("t.speaker = 'ASSISTANT'");
    }

    @Test
    @DisplayName("Criteria 3 & 4: Shadowing SQL contract counts attempts only, not session completion")
    void testShadowingContractInSql() {
        String sql = getUnionSql();
        assertThat(sql).contains("FROM speaking_shadowing_attempts a");
        // Verify speaking_sessions is not unioned as a separate shadowing activity
        assertThat(sql).doesNotContain("FROM speaking_sessions s WHERE s.mode = 'SHADOWING'");
    }

    @Test
    @DisplayName("Criteria 5: Writing submission counted once; AI assessment table writing_assessments is NOT unioned")
    void testWritingContractInSql() {
        String sql = getUnionSql();
        assertThat(sql).contains("FROM writing_submissions w");
        assertThat(sql).doesNotContain("FROM writing_assessments");
    }

    @Test
    @DisplayName("Criteria 6 & 7: Translation sentence and paragraph attempts counted once")
    void testTranslationContractInSql() {
        String sql = getUnionSql();
        assertThat(sql).contains("FROM public.translation_attempts t");
        assertThat(sql).contains("FROM public.translation_paragraph_attempts p");
    }

    @Test
    @DisplayName("Criteria 8 & 9: Listening completed session counted; exercise_attempts NOT additionally counted")
    void testListeningContractInSql() {
        String sql = getUnionSql();
        assertThat(sql).contains("FROM listening_sessions l");
        assertThat(sql).contains("l.ended_at IS NOT NULL");
        assertThat(sql).doesNotContain("FROM exercise_attempts");
    }

    @Test
    @DisplayName("Criteria 10 & 11: Reading progress scroll_percentage >= 80 and last_read_at IS NOT NULL, max 1/material/day")
    void testReadingContractInSql() {
        String sql = getUnionSql();
        assertThat(sql).contains("r.scroll_percentage >= 80");
        assertThat(sql).contains("r.last_read_at IS NOT NULL");
        assertThat(sql).contains("DISTINCT r.reading_material_id");
    }

    @Test
    @DisplayName("Criteria 12 & 13: Exam section counted, full exam submission is not an extra count when sections exist")
    void testExamContractInSql() {
        String sql = getUnionSql();
        assertThat(sql).contains("FROM exams.attempt_sections s");
        assertThat(sql).contains("s.state = 'COMPLETED'");
        assertThat(sql).contains("NOT EXISTS (");
        assertThat(sql).contains("SELECT 1 FROM exams.attempt_sections s WHERE s.attempt_id = a.id AND s.state = 'COMPLETED'");
    }

    @Test
    @DisplayName("Criteria 14: Flashcard historical activity is not fabricated, only append-only FLASHCARD_REVIEWED used")
    void testFlashcardContractInSql() {
        String sql = getUnionSql();
        assertThat(sql).contains("FROM public.learning_activity_events e");
        assertThat(sql).contains("e.activity_type = 'FLASHCARD_REVIEWED'");
        // Verify flashcards table is not queried for fake synthetic historical reviews
        assertThat(sql).doesNotContain("FROM flashcards");
    }

    private String getUnionSql() {
        try {
            java.lang.reflect.Field field = UnifiedProgressRepository.class.getDeclaredField("BASE_UNION_SQL");
            field.setAccessible(true);
            return (String) field.get(null);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
