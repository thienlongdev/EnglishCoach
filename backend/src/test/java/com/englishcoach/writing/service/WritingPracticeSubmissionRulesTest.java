package com.englishcoach.writing.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The free practice submission's substance checks: participation only, deterministic, never a quality score. */
class WritingPracticeSubmissionRulesTest {

    private static final String PROMPT = "Write a single paragraph explaining why reading every day can improve a person's life.";
    private static final String REAL = "Reading every day changes my life in small but important ways. In the morning I read a short "
            + "article with my coffee, and this habit helps me learn new words without stress. When I meet a difficult sentence, "
            + "I try to guess the meaning from the context before I use a dictionary. Over time my reading speed has improved, and I "
            + "feel more confident when I talk with colleagues about the news. Reading also calms me down after a busy day at work.";

    @Test
    void aRealParagraphPasses() {
        assertThat(WritingPracticeSubmissionService.substanceProblem(REAL, 80, PROMPT)).isNull();
    }

    @Test
    void shortRepetitiveCopiedOrNonEnglishTextIsRefused() {
        assertThat(WritingPracticeSubmissionService.substanceProblem("Reading is good for me.", 80, PROMPT)).isEqualTo("TOO_SHORT");
        assertThat(WritingPracticeSubmissionService.substanceProblem("good ".repeat(90), 80, PROMPT)).isEqualTo("REPETITIVE");
        // Vietnamese words never count as English words (no ASCII fragments of "Tôi", "thích", ...)
        assertThat(WritingPracticeSubmissionService.substanceProblem("Tôi rất thích đọc sách mỗi ngày vì nó giúp tôi ".repeat(12)
                + REAL.substring(0, 60), 10, PROMPT)).isEqualTo("NOT_ENGLISH");
        assertThat(WritingPracticeSubmissionService.countWords("Tôi thích đọc sách")).isZero();
        assertThat(WritingPracticeSubmissionService.substanceProblem(PROMPT + " Reading helps me.", 15, PROMPT)).isEqualTo("COPIED_PROMPT");
        assertThat(WritingPracticeSubmissionService.substanceProblem("12345 67890 ".repeat(60), 15, PROMPT)).isEqualTo("TOO_SHORT");
    }

    @Test
    void theTasksOwnMinimumIsUsedWithinBounds() throws Exception {
        ObjectMapper m = new ObjectMapper();
        assertThat(WritingPracticeSubmissionService.minWords(m.readTree("{\"targetWordCountMin\":80}"))).isEqualTo(80);
        assertThat(WritingPracticeSubmissionService.minWords(m.readTree("{\"targetWordCountMin\":5}"))).isEqualTo(15);
        assertThat(WritingPracticeSubmissionService.minWords(m.readTree("{}"))).isEqualTo(80);
        assertThat(WritingPracticeSubmissionService.countWords("It's a well-known fact, isn't it? 42")).isEqualTo(6);
    }
}
