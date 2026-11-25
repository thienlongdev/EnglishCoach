package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class VocabularyEvaluatorTest {

    @Mock
    private FlashcardRepository flashcardRepository;

    @InjectMocks
    private VocabularyEvaluator vocabularyEvaluator;

    @Test
    @DisplayName("VocabularyEvaluator supports VOCAB_MASTERED")
    void testSupports() {
        assertThat(vocabularyEvaluator.supports("VOCAB_MASTERED")).isTrue();
        assertThat(vocabularyEvaluator.supports("vocab_mastered")).isTrue();
        assertThat(vocabularyEvaluator.supports("STREAK_DAYS")).isFalse();
    }

    @Test
    @DisplayName("evaluate: below threshold returns eligible=false and progress")
    void testEvaluate_belowThreshold() {
        when(flashcardRepository.countByUserIdAndStatus(1L, "MASTERED")).thenReturn(45L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("VOCAB_MASTERED")
                .operator("GTE")
                .targetValue("100")
                .build();

        MetricEvaluationResult result = vocabularyEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(45.0);
        assertThat(result.targetValue()).isEqualTo(100.0);
        assertThat(result.percent()).isEqualTo(45.0);
    }

    @Test
    @DisplayName("evaluate: exact threshold returns eligible=true")
    void testEvaluate_exactThreshold() {
        when(flashcardRepository.countByUserIdAndStatus(1L, "MASTERED")).thenReturn(500L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("VOCAB_MASTERED")
                .operator("GTE")
                .targetValue("500")
                .build();

        MetricEvaluationResult result = vocabularyEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isTrue();
        assertThat(result.percent()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("evaluate: above threshold caps percent at 100")
    void testEvaluate_aboveThreshold() {
        when(flashcardRepository.countByUserIdAndStatus(1L, "MASTERED")).thenReturn(2500L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("VOCAB_MASTERED")
                .operator("GTE")
                .targetValue("2000")
                .build();

        MetricEvaluationResult result = vocabularyEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isTrue();
        assertThat(result.percent()).isEqualTo(100.0);
    }
}
