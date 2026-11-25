package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.writing.enums.WritingSessionStage;
import com.englishcoach.writing.repository.WritingSessionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
@RequiredArgsConstructor
@Slf4j
public class WritingEvaluator implements PrestigeMetricEvaluator {

    private static final Set<String> SUPPORTED_METRICS = Set.of(
            "WRITING_ESSAYS_COMPLETED",
            "WRITING_COMPLETED"
    );

    private final WritingSessionRepository writingSessionRepository;

    @Override
    public boolean supports(String metricType) {
        return metricType != null && SUPPORTED_METRICS.contains(metricType.toUpperCase());
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        double target = parseTarget(requirement.getTargetValue(), 1.0);
        String metricType = requirement.getMetricType() != null ? requirement.getMetricType().toUpperCase() : "WRITING_ESSAYS_COMPLETED";

        if (userId == null) {
            return new MetricEvaluationResult(false, 0.0, target, 0.0, metricType, "0 bài viết", (int) target + " bài viết");
        }

        long completedEssays = 0L;
        try {
            completedEssays = writingSessionRepository.countByUserIdAndStage(userId, WritingSessionStage.COMPLETED);
        } catch (Exception ex) {
            log.warn("Failed to retrieve completed writing essays for user {}: {}", userId, ex.getMessage());
        }

        boolean eligible = completedEssays >= target;
        double percent = target > 0
                ? Math.min(100.0, Math.round(((double) completedEssays / target) * 1000.0) / 10.0)
                : 100.0;

        return new MetricEvaluationResult(
                eligible,
                completedEssays,
                target,
                percent,
                metricType,
                completedEssays + " bài viết",
                (int) target + " bài viết"
        );
    }

    private double parseTarget(String val, double defaultVal) {
        try {
            return Double.parseDouble(val);
        } catch (Exception e) {
            log.warn("Failed to parse writing target '{}', using default {}", val, defaultVal);
            return defaultVal;
        }
    }
}
