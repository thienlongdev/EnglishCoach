package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.dto.AvatarFrameProgressDto;
import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.avatarframe.repository.AvatarFrameRequirementRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PrestigeEvaluationEngineTest {

    @Mock
    private AvatarFrameRequirementRepository requirementRepository;

    @Mock
    private PrestigeMetricEvaluator streakEvaluator;

    @Mock
    private PrestigeMetricEvaluator vocabEvaluator;

    private PrestigeEvaluationEngine engine;

    @BeforeEach
    void setUp() {
        lenient().when(streakEvaluator.supports("STREAK_DAYS")).thenReturn(true);
        lenient().when(vocabEvaluator.supports("VOCAB_MASTERED")).thenReturn(true);

        engine = new PrestigeEvaluationEngine(
                List.of(streakEvaluator, vocabEvaluator),
                requirementRepository
        );
    }

    @Test
    @DisplayName("isFrameEligible: multi-requirement requires ALL conditions met (AND composition)")
    void testIsFrameEligible_multiRequirement() {
        AvatarFrameRequirement r1 = AvatarFrameRequirement.builder().metricType("STREAK_DAYS").targetValue("365").build();
        AvatarFrameRequirement r2 = AvatarFrameRequirement.builder().metricType("VOCAB_MASTERED").targetValue("10000").build();
        when(requirementRepository.findByFrameId(14L)).thenReturn(List.of(r1, r2));

        // Case A: r1 eligible, r2 NOT eligible -> false
        when(streakEvaluator.evaluate(1L, r1))
                .thenReturn(new MetricEvaluationResult(true, 365, 365, 100.0, "STREAK_DAYS", "365 ngày", "365 ngày"));
        when(vocabEvaluator.evaluate(1L, r2))
                .thenReturn(new MetricEvaluationResult(false, 5000, 10000, 50.0, "VOCAB_MASTERED", "5000 từ", "10000 từ"));

        assertThat(engine.isFrameEligible(1L, 14L)).isFalse();

        // Case B: both eligible -> true
        when(vocabEvaluator.evaluate(1L, r2))
                .thenReturn(new MetricEvaluationResult(true, 10000, 10000, 100.0, "VOCAB_MASTERED", "10000 từ", "10000 từ"));

        assertThat(engine.isFrameEligible(1L, 14L)).isTrue();
    }

    @Test
    @DisplayName("computeProgress: correctly derives PROGRESSING status and bottleneck percent")
    void testComputeProgress_progressing() {
        AvatarFrameRequirement r1 = AvatarFrameRequirement.builder().metricType("STREAK_DAYS").targetValue("30").build();
        when(requirementRepository.findByFrameId(2L)).thenReturn(List.of(r1));
        when(streakEvaluator.evaluate(1L, r1))
                .thenReturn(new MetricEvaluationResult(false, 15, 30, 50.0, "STREAK_DAYS", "15 ngày", "30 ngày"));

        AvatarFrameProgressDto progress = engine.computeProgress(1L, 2L, false, false, false);

        assertThat(progress.status()).isEqualTo("PROGRESSING");
        assertThat(progress.percent()).isEqualTo(50.0);
        assertThat(progress.current()).isEqualTo(15.0);
        assertThat(progress.target()).isEqualTo(30.0);
    }

    @Test
    @DisplayName("computeProgress: derives ELIGIBLE status when requirement is satisfied, decoupled from equipped state")
    void testComputeProgress_equipped() {
        AvatarFrameRequirement r1 = AvatarFrameRequirement.builder().metricType("STREAK_DAYS").targetValue("7").build();
        when(requirementRepository.findByFrameId(1L)).thenReturn(List.of(r1));
        when(streakEvaluator.evaluate(1L, r1))
                .thenReturn(new MetricEvaluationResult(true, 10, 7, 100.0, "STREAK_DAYS", "10 ngày", "7 ngày"));

        AvatarFrameProgressDto progress = engine.computeProgress(1L, 1L, true, true, false);

        assertThat(progress.status()).isEqualTo("ELIGIBLE");
        assertThat(progress.percent()).isEqualTo(100.0);
    }
}
