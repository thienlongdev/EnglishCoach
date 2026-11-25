package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
@Slf4j
public class VocabularyEvaluator implements PrestigeMetricEvaluator {

    public static final String METRIC_TYPE = "VOCAB_MASTERED";

    private final FlashcardRepository flashcardRepository;

    @Override
    public boolean supports(String metricType) {
        return METRIC_TYPE.equalsIgnoreCase(metricType);
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        double target = parseTarget(requirement.getTargetValue(), 1.0);
        if (userId == null) {
            return new MetricEvaluationResult(false, 0.0, target, 0.0, METRIC_TYPE, "0 từ", (int) target + " từ");
        }

        long masteredCount = flashcardRepository.countByUserIdAndStatus(userId, "MASTERED");

        boolean eligible = masteredCount >= target;
        double percent = target > 0
                ? Math.min(100.0, Math.round(((double) masteredCount / target) * 1000.0) / 10.0)
                : 100.0;

        return new MetricEvaluationResult(
                eligible,
                masteredCount,
                target,
                percent,
                METRIC_TYPE,
                masteredCount + " từ",
                (int) target + " từ"
        );
    }

    private double parseTarget(String val, double defaultVal) {
        try {
            return Double.parseDouble(val);
        } catch (Exception e) {
            log.warn("Failed to parse vocab target '{}', using default {}", val, defaultVal);
            return defaultVal;
        }
    }
}
