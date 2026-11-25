package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.listening.repository.ExerciseAttemptRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
@RequiredArgsConstructor
@Slf4j
public class DictationEvaluator implements PrestigeMetricEvaluator {

    public static final String METRIC_TYPE = "DICTATION_COMPLETED";

    private final ExerciseAttemptRepository exerciseAttemptRepository;

    @Override
    public boolean supports(String metricType) {
        return METRIC_TYPE.equalsIgnoreCase(metricType);
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        double target = parseTarget(requirement.getTargetValue(), 1.0);

        if (userId == null) {
            return new MetricEvaluationResult(false, 0.0, target, 0.0, METRIC_TYPE, "0 bài chính tả", (int) target + " bài chính tả");
        }

        long completedDictations = 0L;
        try {
            completedDictations = exerciseAttemptRepository.countCompletedDictationsByUserId(userId);
        } catch (Exception ex) {
            log.warn("Failed to retrieve completed dictations for user {}: {}", userId, ex.getMessage());
        }

        boolean eligible = completedDictations >= target;
        double percent = target > 0
                ? Math.min(100.0, Math.round(((double) completedDictations / target) * 1000.0) / 10.0)
                : 100.0;

        return new MetricEvaluationResult(
                eligible,
                completedDictations,
                target,
                percent,
                METRIC_TYPE,
                completedDictations + " bài chính tả",
                (int) target + " bài chính tả"
        );
    }

    private double parseTarget(String val, double defaultVal) {
        try {
            return Double.parseDouble(val);
        } catch (Exception e) {
            log.warn("Failed to parse dictation target '{}', using default {}", val, defaultVal);
            return defaultVal;
        }
    }
}
