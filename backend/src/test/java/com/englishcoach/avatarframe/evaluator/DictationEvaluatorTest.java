package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.listening.repository.ExerciseAttemptRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class DictationEvaluatorTest {

    @Mock
    private ExerciseAttemptRepository exerciseAttemptRepository;

    @InjectMocks
    private DictationEvaluator dictationEvaluator;

    @Test
    @DisplayName("DictationEvaluator supports DICTATION_COMPLETED")
    void testSupports() {
        assertThat(dictationEvaluator.supports("DICTATION_COMPLETED")).isTrue();
        assertThat(dictationEvaluator.supports("dictation_completed")).isTrue();
        assertThat(dictationEvaluator.supports("VOCAB_MASTERED")).isFalse();
    }

    @Test
    @DisplayName("evaluate: below threshold returns eligible=false and exact partial percent")
    void testEvaluate_belowThreshold() {
        when(exerciseAttemptRepository.countCompletedDictationsByUserId(1L)).thenReturn(12L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("DICTATION_COMPLETED")
                .targetValue("30")
                .build();

        MetricEvaluationResult result = dictationEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(12.0);
        assertThat(result.targetValue()).isEqualTo(30.0);
        assertThat(result.percent()).isEqualTo(40.0);
        assertThat(result.displayCurrent()).isEqualTo("12 bài chính tả");
    }

    @Test
    @DisplayName("evaluate: exact threshold returns eligible=true and 100 percent")
    void testEvaluate_exactThreshold() {
        when(exerciseAttemptRepository.countCompletedDictationsByUserId(1L)).thenReturn(30L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("DICTATION_COMPLETED")
                .targetValue("30")
                .build();

        MetricEvaluationResult result = dictationEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isTrue();
        assertThat(result.currentValue()).isEqualTo(30.0);
        assertThat(result.percent()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("evaluate: null user safely returns 0 percent")
    void testEvaluate_nullUser() {
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("DICTATION_COMPLETED")
                .targetValue("30")
                .build();

        MetricEvaluationResult result = dictationEvaluator.evaluate(null, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(0.0);
        assertThat(result.percent()).isEqualTo(0.0);
    }
}
