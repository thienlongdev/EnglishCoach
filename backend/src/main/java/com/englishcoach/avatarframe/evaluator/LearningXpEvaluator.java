package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.leaderboard.activity.rollup.ActivityRankRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * {@code LEARNING_XP}: cumulative learning XP = all-time Activity points (the capped, append-only score_events ledger
 * rolled up into leaderboard_activity_daily — flashcards, Card Blast, PvP, dictation, shadowing, roleplay, writing,
 * exams). Server-side, daily-capped (no farming), no purchase path. Replaces the unreachable PVP_RANK thresholds of the
 * RANKED lineage (V67). READ-ONLY: never writes leaderboard data and changes no XP, ranking or PvP / ELO logic.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class LearningXpEvaluator implements PrestigeMetricEvaluator {

    public static final String METRIC_TYPE = "LEARNING_XP";

    private final ActivityRankRepository activityRanks;

    @Override
    public boolean supports(String metricType) {
        return METRIC_TYPE.equalsIgnoreCase(metricType);
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        double target = parseTarget(requirement.getTargetValue());
        if (userId == null) {
            return new MetricEvaluationResult(false, 0.0, target, 0.0, METRIC_TYPE, "0 XP", (long) target + " XP");
        }
        long xp = 0;
        try {
            xp = Math.max(0, activityRanks.allTimePoints(userId));
        } catch (Exception ex) {
            log.debug("Unable to read learning XP for user {}: {}", userId, ex.getMessage());
        }
        boolean eligible = target > 0 && xp >= target;
        double percent = target > 0 ? Math.min(100.0, Math.round((xp / target) * 1000.0) / 10.0) : 0.0;
        return new MetricEvaluationResult(eligible, xp, target, percent, METRIC_TYPE, xp + " XP", (long) target + " XP");
    }

    private double parseTarget(String val) {
        try {
            return Math.max(0, Double.parseDouble(val));
        } catch (Exception e) {
            log.warn("Invalid LEARNING_XP target '{}' (requirement never satisfied)", val);
            return 0.0;
        }
    }
}
