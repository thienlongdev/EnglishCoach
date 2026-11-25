package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.service.UnifiedProgressService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class StreakEvaluatorTest {

    @Mock
    private UnifiedProgressService unifiedProgressService;

    @InjectMocks
    private StreakEvaluator streakEvaluator;

    @Test
    @DisplayName("StreakEvaluator supports STREAK_DAYS case-insensitively")
    void testSupports() {
        assertThat(streakEvaluator.supports("STREAK_DAYS")).isTrue();
        assertThat(streakEvaluator.supports("streak_days")).isTrue();
        assertThat(streakEvaluator.supports("VOCAB_MASTERED")).isFalse();
    }

    @Test
    @DisplayName("evaluate: below threshold returns eligible=false and exact partial percent")
    void testEvaluate_belowThreshold() {
        when(unifiedProgressService.getStreak(1L)).thenReturn(new UnifiedStreakDto(5, 5, true));
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("STREAK_DAYS")
                .operator("GTE")
                .targetValue("7")
                .build();

        MetricEvaluationResult result = streakEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(5.0);
        assertThat(result.targetValue()).isEqualTo(7.0);
        assertThat(result.percent()).isEqualTo(71.4);
    }

    @Test
    @DisplayName("evaluate: exact threshold returns eligible=true and 100 percent")
    void testEvaluate_exactThreshold() {
        when(unifiedProgressService.getStreak(1L)).thenReturn(new UnifiedStreakDto(30, 30, true));
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("STREAK_DAYS")
                .operator("GTE")
                .targetValue("30")
                .build();

        MetricEvaluationResult result = streakEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isTrue();
        assertThat(result.percent()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("evaluate: above threshold caps percent at 100.0")
    void testEvaluate_aboveThreshold() {
        when(unifiedProgressService.getStreak(1L)).thenReturn(new UnifiedStreakDto(120, 150, true));
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("STREAK_DAYS")
                .operator("GTE")
                .targetValue("100")
                .build();

        MetricEvaluationResult result = streakEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isTrue();
        assertThat(result.currentValue()).isEqualTo(150.0);
        assertThat(result.percent()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("evaluate: anonymous user returns 0 percent and eligible=false")
    void testEvaluate_anonymousUser() {
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("STREAK_DAYS")
                .operator("GTE")
                .targetValue("7")
                .build();

        MetricEvaluationResult result = streakEvaluator.evaluate(null, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(0.0);
        assertThat(result.percent()).isEqualTo(0.0);
    }
}
