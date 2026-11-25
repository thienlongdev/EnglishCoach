package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.service.UnifiedProgressService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
@Slf4j
public class StreakEvaluator implements PrestigeMetricEvaluator {

    public static final String METRIC_TYPE = "STREAK_DAYS";

    private final UnifiedProgressService unifiedProgressService;

    @Override
    public boolean supports(String metricType) {
        return METRIC_TYPE.equalsIgnoreCase(metricType);
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        double target = parseTarget(requirement.getTargetValue(), 1.0);
        if (userId == null) {
            return new MetricEvaluationResult(false, 0.0, target, 0.0, METRIC_TYPE, "0 ngày", (int) target + " ngày");
        }

        UnifiedStreakDto streak = unifiedProgressService.getStreak(userId);
        int currentStreak = streak != null ? Math.max(streak.currentStreakDays(), streak.longestStreakDays()) : 0;

        boolean eligible = currentStreak >= target;
        double percent = target > 0
                ? Math.min(100.0, Math.round(((double) currentStreak / target) * 1000.0) / 10.0)
                : 100.0;

        return new MetricEvaluationResult(
                eligible,
                currentStreak,
                target,
                percent,
                METRIC_TYPE,
                currentStreak + " ngày",
                (int) target + " ngày"
        );
    }

    private double parseTarget(String val, double defaultVal) {
        try {
            return Double.parseDouble(val);
        } catch (Exception e) {
            log.warn("Failed to parse streak target '{}', using default {}", val, defaultVal);
            return defaultVal;
        }
    }
}
