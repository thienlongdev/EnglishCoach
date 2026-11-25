package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.writing.enums.WritingSessionStage;
import com.englishcoach.writing.repository.WritingSessionRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class WritingEvaluatorTest {

    @Mock
    private WritingSessionRepository writingSessionRepository;

    @InjectMocks
    private WritingEvaluator writingEvaluator;

    @Test
    @DisplayName("WritingEvaluator supports WRITING_ESSAYS_COMPLETED and WRITING_COMPLETED")
    void testSupports() {
        assertThat(writingEvaluator.supports("WRITING_ESSAYS_COMPLETED")).isTrue();
        assertThat(writingEvaluator.supports("writing_completed")).isTrue();
        assertThat(writingEvaluator.supports("STREAK_DAYS")).isFalse();
    }

    @Test
    @DisplayName("evaluate: below threshold returns eligible=false and exact partial percent")
    void testEvaluate_belowThreshold() {
        when(writingSessionRepository.countByUserIdAndStage(1L, WritingSessionStage.COMPLETED)).thenReturn(4L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("WRITING_ESSAYS_COMPLETED")
                .targetValue("10")
                .build();

        MetricEvaluationResult result = writingEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(4.0);
        assertThat(result.targetValue()).isEqualTo(10.0);
        assertThat(result.percent()).isEqualTo(40.0);
        assertThat(result.displayCurrent()).isEqualTo("4 bài viết");
    }

    @Test
    @DisplayName("evaluate: exact threshold returns eligible=true and 100 percent")
    void testEvaluate_exactThreshold() {
        when(writingSessionRepository.countByUserIdAndStage(1L, WritingSessionStage.COMPLETED)).thenReturn(10L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("WRITING_ESSAYS_COMPLETED")
                .targetValue("10")
                .build();

        MetricEvaluationResult result = writingEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isTrue();
        assertThat(result.currentValue()).isEqualTo(10.0);
        assertThat(result.percent()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("evaluate: above threshold returns eligible=true and 100 percent")
    void testEvaluate_aboveThreshold() {
        when(writingSessionRepository.countByUserIdAndStage(1L, WritingSessionStage.COMPLETED)).thenReturn(25L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("WRITING_ESSAYS_COMPLETED")
                .targetValue("10")
                .build();

        MetricEvaluationResult result = writingEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isTrue();
        assertThat(result.currentValue()).isEqualTo(25.0);
        assertThat(result.percent()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("evaluate: null user safely returns 0 percent")
    void testEvaluate_nullUser() {
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("WRITING_ESSAYS_COMPLETED")
                .targetValue("10")
                .build();

        MetricEvaluationResult result = writingEvaluator.evaluate(null, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(0.0);
        assertThat(result.percent()).isEqualTo(0.0);
    }
}
