package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.flashcard.pvp.entity.PvpRating;
import com.englishcoach.flashcard.pvp.repository.PvpRatingRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Optional;

@Component
@RequiredArgsConstructor
@Slf4j
public class PvpRankEvaluator implements PrestigeMetricEvaluator {

    public static final String METRIC_TYPE = "PVP_RANK";

    private final PvpRatingRepository pvpRatingRepository;

    @Override
    public boolean supports(String metricType) {
        return METRIC_TYPE.equalsIgnoreCase(metricType);
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        String targetRank = requirement.getTargetValue() != null ? requirement.getTargetValue().toUpperCase().trim() : "RANK";

        // Read authoritative raw ELO from pvp_ratings (CardBlastPvPService: base 1000, K=32)
        int currentElo = 1000;
        boolean hasRatingRecord = false;
        if (userId != null) {
            try {
                Optional<PvpRating> ratingOpt = pvpRatingRepository.findById(userId);
                if (ratingOpt.isPresent() && ratingOpt.get().getRating() != null) {
                    currentElo = ratingOpt.get().getRating();
                    hasRatingRecord = true;
                }
            } catch (Exception ex) {
                log.debug("Unable to read PVP rating for user {}: {}", userId, ex.getMessage());
            }
        }

        String displayCurrent = userId == null
                ? "Chưa xếp hạng"
                : (hasRatingRecord ? currentElo + " ELO" : "1000 ELO (Mặc định)");

        // [UNVERIFIED AUDIT ENFORCEMENT]:
        // Rank tiers (GOLD, MASTER, CHALLENGER) and numeric thresholds (1200, 1500, 2000)
        // are UNVERIFIED in the backend/domain models and configuration.
        // Repository Law: No unverified threshold may control ownership or grant eligibility.
        // The requirement is marked unverified/unavailable (eligible = false, target = 0.0) until
        // an authoritative season rank engine is established.
        // Integration remains strictly READ-ONLY. No PvP scoring, Elo formula, or gameplay is altered.
        boolean eligible = false;
        double targetElo = 0.0;
        double percent = 0.0;
        String displayTarget = targetRank + " (Chưa mở)";

        return new MetricEvaluationResult(
                eligible,
                currentElo,
                targetElo,
                percent,
                METRIC_TYPE,
                displayCurrent,
                displayTarget
        );
    }
}
