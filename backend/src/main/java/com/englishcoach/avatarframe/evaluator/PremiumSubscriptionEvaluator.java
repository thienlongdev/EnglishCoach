package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.premium.entity.PremiumSubscription;
import com.englishcoach.premium.repository.PremiumSubscriptionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

@Component
@RequiredArgsConstructor
@Slf4j
public class PremiumSubscriptionEvaluator implements PrestigeMetricEvaluator {

    public static final String METRIC_TYPE = "PREMIUM_PLAN";
    public static final String METRIC_TYPE_ALT = "PREMIUM_SUBSCRIPTION";

    private final PremiumSubscriptionRepository subscriptionRepository;

    @Override
    public boolean supports(String metricType) {
        return METRIC_TYPE.equalsIgnoreCase(metricType) || METRIC_TYPE_ALT.equalsIgnoreCase(metricType);
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        String targetVal = requirement.getTargetValue() != null ? requirement.getTargetValue().trim() : "1";
        int targetMonths;
        String displayTarget;

        if ("PLAN_12_MONTHS".equalsIgnoreCase(targetVal) || "12".equals(targetVal)) {
            targetMonths = 12;
            displayTarget = "Gói 12 Tháng";
        } else if ("PLAN_3_MONTHS".equalsIgnoreCase(targetVal) || "3".equals(targetVal)) {
            targetMonths = 3;
            displayTarget = "Gói 3 Tháng";
        } else {
            targetMonths = 1;
            displayTarget = "Gói 1 Tháng";
        }

        if (userId == null) {
            return new MetricEvaluationResult(false, 0.0, targetMonths, 0.0, METRIC_TYPE, "Chưa kích hoạt", displayTarget);
        }

        int currentMonths = 0;
        String currentPlanName = "Chưa kích hoạt";
        try {
            List<PremiumSubscription> activeSubs = subscriptionRepository.findActiveSubscriptions(userId, Instant.now());
            if (activeSubs != null && !activeSubs.isEmpty()) {
                for (PremiumSubscription sub : activeSubs) {
                    if (sub.getPlan() != null) {
                        int months = sub.getPlan().getDurationMonths();
                        if (months > currentMonths) {
                            currentMonths = months;
                            currentPlanName = sub.getPlan().getName();
                        }
                    }
                }
            }
        } catch (Exception ex) {
            log.debug("Unable to read premium subscription for user {}: {}", userId, ex.getMessage());
        }

        boolean eligible = currentMonths >= targetMonths;
        double percent = eligible ? 100.0 : (currentMonths > 0 ? Math.min(99.0, Math.round(((double) currentMonths / targetMonths) * 1000.0) / 10.0) : 0.0);

        return new MetricEvaluationResult(
                eligible,
                currentMonths,
                targetMonths,
                percent,
                METRIC_TYPE,
                currentPlanName,
                displayTarget
        );
    }
}
