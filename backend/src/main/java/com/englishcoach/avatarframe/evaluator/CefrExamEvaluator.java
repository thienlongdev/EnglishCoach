package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.exams.model.ExamProfileRecords.IeltsProfileDto;
import com.englishcoach.exams.service.ExamProfileService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
@Slf4j
public class CefrExamEvaluator implements PrestigeMetricEvaluator {

    public static final String METRIC_TYPE = "CEFR_LEVEL";

    private final ExamProfileService examProfileService;

    @Override
    public boolean supports(String metricType) {
        return METRIC_TYPE.equalsIgnoreCase(metricType);
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        String targetCefr = requirement.getTargetValue() != null ? requirement.getTargetValue().toUpperCase().trim() : "B2";
        double targetIeltsScore = switch (targetCefr) {
            case "C2" -> 8.5;
            case "C1" -> 7.0;
            case "B2" -> 5.5;
            default -> 5.5;
        };

        if (userId == null) {
            return new MetricEvaluationResult(false, 0.0, targetIeltsScore, 0.0, METRIC_TYPE, "Chưa thi", targetCefr + " (IELTS " + targetIeltsScore + "+)");
        }

        double bestScore = 0.0;
        try {
            IeltsProfileDto ieltsProfile = examProfileService.getIeltsProfile(userId);
            if (ieltsProfile != null && ieltsProfile.overall() != null && ieltsProfile.overall().best() != null) {
                bestScore = ieltsProfile.overall().best();
            }
        } catch (Exception ex) {
            log.debug("Unable to read IELTS profile for user {}: {}", userId, ex.getMessage());
        }

        boolean eligible = bestScore >= targetIeltsScore;
        double percent = targetIeltsScore > 0
                ? Math.min(100.0, Math.round((bestScore / targetIeltsScore) * 1000.0) / 10.0)
                : 100.0;

        String displayCurrent = bestScore > 0 ? ("Band " + bestScore) : "Chưa có kết quả";
        String displayTarget = targetCefr + " (IELTS " + targetIeltsScore + "+)";

        return new MetricEvaluationResult(
                eligible,
                bestScore,
                targetIeltsScore,
                percent,
                METRIC_TYPE,
                displayCurrent,
                displayTarget
        );
    }
}
