package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.listening.entity.ListeningProfile;
import com.englishcoach.listening.repository.ListeningProfileRepository;
import com.englishcoach.listening.repository.ListeningSessionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Optional;
import java.util.Set;

@Component
@RequiredArgsConstructor
@Slf4j
public class ListeningEvaluator implements PrestigeMetricEvaluator {

    private static final Set<String> SUPPORTED_METRICS = Set.of(
            "LISTENING_HOURS",
            "LISTENING_TIME",
            "LISTENING_SESSIONS_COMPLETED"
    );

    private final ListeningProfileRepository listeningProfileRepository;
    private final ListeningSessionRepository listeningSessionRepository;

    @Override
    public boolean supports(String metricType) {
        return metricType != null && SUPPORTED_METRICS.contains(metricType.toUpperCase());
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        double target = parseTarget(requirement.getTargetValue(), 1.0);
        String metricType = requirement.getMetricType() != null ? requirement.getMetricType().toUpperCase() : "LISTENING_HOURS";

        if (userId == null) {
            String defaultDisplayTarget = "LISTENING_SESSIONS_COMPLETED".equals(metricType)
                    ? ((int) target + " buổi nghe")
                    : ((int) target + " giờ nghe");
            return new MetricEvaluationResult(false, 0.0, target, 0.0, metricType, "0", defaultDisplayTarget);
        }

        if ("LISTENING_SESSIONS_COMPLETED".equals(metricType)) {
            long sessions = 0L;
            try {
                sessions = listeningSessionRepository.countCompletedSessionsByUserId(userId);
            } catch (Exception ex) {
                log.warn("Failed to retrieve completed listening sessions for user {}: {}", userId, ex.getMessage());
            }

            boolean eligible = sessions >= target;
            double percent = target > 0
                    ? Math.min(100.0, Math.round(((double) sessions / target) * 1000.0) / 10.0)
                    : 100.0;

            return new MetricEvaluationResult(
                    eligible,
                    sessions,
                    target,
                    percent,
                    metricType,
                    sessions + " buổi nghe",
                    (int) target + " buổi nghe"
            );
        } else {
            double currentHours = 0.0;
            try {
                Optional<ListeningProfile> profileOpt = listeningProfileRepository.findByUserId(userId);
                if (profileOpt.isPresent() && profileOpt.get().getTotalListeningTimeSeconds() != null) {
                    currentHours = Math.round((profileOpt.get().getTotalListeningTimeSeconds() / 3600.0) * 10.0) / 10.0;
                }
            } catch (Exception ex) {
                log.warn("Failed to retrieve listening profile for user {}: {}", userId, ex.getMessage());
            }

            boolean eligible = currentHours >= target;
            double percent = target > 0
                    ? Math.min(100.0, Math.round((currentHours / target) * 1000.0) / 10.0)
                    : 100.0;

            return new MetricEvaluationResult(
                    eligible,
                    currentHours,
                    target,
                    percent,
                    metricType,
                    currentHours + " giờ nghe",
                    (int) target + " giờ nghe"
            );
        }
    }

    private double parseTarget(String val, double defaultVal) {
        try {
            return Double.parseDouble(val);
        } catch (Exception e) {
            log.warn("Failed to parse listening target '{}', using default {}", val, defaultVal);
            return defaultVal;
        }
    }
}
