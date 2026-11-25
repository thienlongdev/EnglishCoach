package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.reading.repository.UserReadingProgressRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Set;

@Component
@RequiredArgsConstructor
@Slf4j
public class ReadingEvaluator implements PrestigeMetricEvaluator {

    private static final Set<String> SUPPORTED_METRICS = Set.of(
            "READING_MATERIALS_COMPLETED",
            "READING_COMPLETED"
    );

    private final UserReadingProgressRepository userReadingProgressRepository;

    @Override
    public boolean supports(String metricType) {
        return metricType != null && SUPPORTED_METRICS.contains(metricType.toUpperCase());
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        double target = parseTarget(requirement.getTargetValue(), 1.0);
        String metricType = requirement.getMetricType() != null ? requirement.getMetricType().toUpperCase() : "READING_MATERIALS_COMPLETED";

        if (userId == null) {
            return new MetricEvaluationResult(false, 0.0, target, 0.0, metricType, "0 bài đọc", (int) target + " bài đọc");
        }

        long completedMaterials = 0L;
        try {
            completedMaterials = userReadingProgressRepository.countCompletedMaterialsByUserId(userId);
        } catch (Exception ex) {
            log.warn("Failed to retrieve completed reading materials for user {}: {}", userId, ex.getMessage());
        }

        boolean eligible = completedMaterials >= target;
        double percent = target > 0
                ? Math.min(100.0, Math.round(((double) completedMaterials / target) * 1000.0) / 10.0)
                : 100.0;

        return new MetricEvaluationResult(
                eligible,
                completedMaterials,
                target,
                percent,
                metricType,
                completedMaterials + " bài đọc",
                (int) target + " bài đọc"
        );
    }

    private double parseTarget(String val, double defaultVal) {
        try {
            return Double.parseDouble(val);
        } catch (Exception e) {
            log.warn("Failed to parse reading target '{}', using default {}", val, defaultVal);
            return defaultVal;
        }
    }
}
