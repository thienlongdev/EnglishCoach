package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.leaderboard.activity.rollup.ActivityRankRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

/** LEARNING_XP (V67 RANKED-lineage requirement): cumulative Activity XP, server-side, read-only. */
@ExtendWith(MockitoExtension.class)
class LearningXpEvaluatorTest {

    @Mock
    private ActivityRankRepository activityRanks;

    @InjectMocks
    private LearningXpEvaluator evaluator;

    private static AvatarFrameRequirement req(String target) {
        return AvatarFrameRequirement.builder().metricType("LEARNING_XP").operator("GTE").targetValue(target).build();
    }

    @Test
    @DisplayName("supports LEARNING_XP only")
    void supports() {
        assertThat(evaluator.supports("LEARNING_XP")).isTrue();
        assertThat(evaluator.supports("learning_xp")).isTrue();
        assertThat(evaluator.supports("PVP_RANK")).isFalse();
    }

    @Test
    @DisplayName("below threshold: 420 / 1000 XP, 42 %, not eligible")
    void belowThreshold() {
        when(activityRanks.allTimePoints(5L)).thenReturn(420);
        MetricEvaluationResult r = evaluator.evaluate(5L, req("1000"));
        assertThat(r.eligible()).isFalse();
        assertThat(r.currentValue()).isEqualTo(420.0);
        assertThat(r.targetValue()).isEqualTo(1000.0);
        assertThat(r.percent()).isEqualTo(42.0);
        assertThat(r.displayCurrent()).isEqualTo("420 XP");
        assertThat(r.displayTarget()).isEqualTo("1000 XP");
        assertThat(r.displayTarget()).doesNotContain("ELO").doesNotContain("Chưa mở");
    }

    @Test
    @DisplayName("crossing the threshold makes the frame eligible (unlock on the next reconcile)")
    void crossesThreshold() {
        when(activityRanks.allTimePoints(5L)).thenReturn(999, 1000, 10_250);
        assertThat(evaluator.evaluate(5L, req("1000")).eligible()).isFalse();
        assertThat(evaluator.evaluate(5L, req("1000")).eligible()).isTrue();
        MetricEvaluationResult over = evaluator.evaluate(5L, req("10000"));
        assertThat(over.eligible()).isTrue();
        assertThat(over.percent()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("anonymous viewer, broken target or read failure never grant")
    void neverGrantsOnBadInput() {
        assertThat(evaluator.evaluate(null, req("1000")).eligible()).isFalse();
        when(activityRanks.allTimePoints(6L)).thenReturn(50_000);
        assertThat(evaluator.evaluate(6L, req("GOLD")).eligible()).isFalse();
        when(activityRanks.allTimePoints(7L)).thenThrow(new IllegalStateException("db down"));
        MetricEvaluationResult r = evaluator.evaluate(7L, req("1000"));
        assertThat(r.eligible()).isFalse();
        assertThat(r.currentValue()).isEqualTo(0.0);
    }
}
