package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.flashcard.pvp.entity.PvpRating;
import com.englishcoach.flashcard.pvp.repository.PvpRatingRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PvpRankEvaluatorTest {

    @Mock
    private PvpRatingRepository pvpRatingRepository;

    @InjectMocks
    private PvpRankEvaluator pvpRankEvaluator;

    @Test
    @DisplayName("PvpRankEvaluator supports PVP_RANK")
    void testSupports() {
        assertThat(pvpRankEvaluator.supports("PVP_RANK")).isTrue();
        assertThat(pvpRankEvaluator.supports("pvp_rank")).isTrue();
        assertThat(pvpRankEvaluator.supports("STREAK_DAYS")).isFalse();
    }

    @Test
    @DisplayName("evaluate: preserves authoritative raw ELO but unverified thresholds do not control ownership")
    void testEvaluate_unverifiedThresholdsDoNotControlOwnership() {
        PvpRating rating = PvpRating.builder()
                .userId(1L)
                .rating(1600)
                .wins(50)
                .losses(20)
                .updatedAt(Instant.now())
                .build();
        when(pvpRatingRepository.findById(1L)).thenReturn(Optional.of(rating));

        AvatarFrameRequirement goldReq = AvatarFrameRequirement.builder()
                .metricType("PVP_RANK")
                .operator("EQUALS")
                .targetValue("GOLD")
                .build();
        AvatarFrameRequirement masterReq = AvatarFrameRequirement.builder()
                .metricType("PVP_RANK")
                .operator("EQUALS")
                .targetValue("MASTER")
                .build();
        AvatarFrameRequirement challengerReq = AvatarFrameRequirement.builder()
                .metricType("PVP_RANK")
                .operator("EQUALS")
                .targetValue("CHALLENGER")
                .build();

        MetricEvaluationResult goldResult = pvpRankEvaluator.evaluate(1L, goldReq);
        MetricEvaluationResult masterResult = pvpRankEvaluator.evaluate(1L, masterReq);
        MetricEvaluationResult challengerResult = pvpRankEvaluator.evaluate(1L, challengerReq);

        // Hard rule: Unverified thresholds MUST NOT control ownership
        assertThat(goldResult.eligible()).isFalse();
        assertThat(masterResult.eligible()).isFalse();
        assertThat(challengerResult.eligible()).isFalse();

        // Authoritative raw ELO preserved
        assertThat(goldResult.currentValue()).isEqualTo(1600.0);
        assertThat(goldResult.displayCurrent()).isEqualTo("1600 ELO");
        assertThat(goldResult.displayTarget()).contains("Chưa mở");
    }
}
