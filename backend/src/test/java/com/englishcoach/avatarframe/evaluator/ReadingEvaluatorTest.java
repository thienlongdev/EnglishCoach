package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.reading.repository.UserReadingProgressRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ReadingEvaluatorTest {

    @Mock
    private UserReadingProgressRepository userReadingProgressRepository;

    @InjectMocks
    private ReadingEvaluator readingEvaluator;

    @Test
    @DisplayName("ReadingEvaluator supports READING_MATERIALS_COMPLETED and READING_COMPLETED")
    void testSupports() {
        assertThat(readingEvaluator.supports("READING_MATERIALS_COMPLETED")).isTrue();
        assertThat(readingEvaluator.supports("reading_completed")).isTrue();
        assertThat(readingEvaluator.supports("STREAK_DAYS")).isFalse();
    }

    @Test
    @DisplayName("evaluate: below threshold returns eligible=false and exact partial percent")
    void testEvaluate_belowThreshold() {
        when(userReadingProgressRepository.countCompletedMaterialsByUserId(1L)).thenReturn(8L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("READING_MATERIALS_COMPLETED")
                .targetValue("10")
                .build();

        MetricEvaluationResult result = readingEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(8.0);
        assertThat(result.targetValue()).isEqualTo(10.0);
        assertThat(result.percent()).isEqualTo(80.0);
        assertThat(result.displayCurrent()).isEqualTo("8 bài đọc");
        assertThat(result.displayTarget()).isEqualTo("10 bài đọc");
    }

    @Test
    @DisplayName("evaluate: exact threshold returns eligible=true and 100 percent")
    void testEvaluate_exactThreshold() {
        when(userReadingProgressRepository.countCompletedMaterialsByUserId(1L)).thenReturn(25L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("READING_MATERIALS_COMPLETED")
                .targetValue("25")
                .build();

        MetricEvaluationResult result = readingEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isTrue();
        assertThat(result.currentValue()).isEqualTo(25.0);
        assertThat(result.percent()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("evaluate: above threshold returns eligible=true and capped at 100 percent")
    void testEvaluate_aboveThreshold() {
        when(userReadingProgressRepository.countCompletedMaterialsByUserId(1L)).thenReturn(50L);
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("READING_MATERIALS_COMPLETED")
                .targetValue("25")
                .build();

        MetricEvaluationResult result = readingEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isTrue();
        assertThat(result.currentValue()).isEqualTo(50.0);
        assertThat(result.percent()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("evaluate: null user safely returns 0 percent without throwing exception")
    void testEvaluate_nullUser() {
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("READING_MATERIALS_COMPLETED")
                .targetValue("10")
                .build();

        MetricEvaluationResult result = readingEvaluator.evaluate(null, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(0.0);
        assertThat(result.percent()).isEqualTo(0.0);
    }
}
