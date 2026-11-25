package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.dto.AvatarFrameConditionDto;
import com.englishcoach.avatarframe.dto.AvatarFrameProgressDto;
import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.avatarframe.repository.AvatarFrameRequirementRepository;
import com.englishcoach.common.cache.BoundedTtlCache;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class PrestigeEvaluationEngine {

    private final List<PrestigeMetricEvaluator> evaluators;
    private final AvatarFrameRequirementRepository requirementRepository;

    // Immutable milestone requirements per frame (~40 frames): 15-minute TTL eliminates per-frame DB round-trips.
    private final BoundedTtlCache<Long, List<AvatarFrameRequirement>> requirementsCache =
            new BoundedTtlCache<>(256, Duration.ofMinutes(15).toMillis());

    /**
     * Batch-preloads requirements for a set of frames in a single IN query into the 15-minute cache.
     */
    public void preloadRequirements(Collection<Long> frameIds) {
        if (frameIds == null || frameIds.isEmpty()) {
            return;
        }
        List<Long> missing = new ArrayList<>();
        for (Long id : frameIds) {
            if (id != null && requirementsCache.getIfPresent(id) == null) {
                missing.add(id);
            }
        }
        if (missing.isEmpty()) {
            return;
        }
        List<AvatarFrameRequirement> rows = requirementRepository.findByFrameIdIn(missing);
        if (rows == null || rows.isEmpty()) {
            // Do not cache empty lists when batch query returned nothing (preserves unit tests stubbing only findByFrameId).
            return;
        }
        Map<Long, List<AvatarFrameRequirement>> grouped = new HashMap<>();
        for (AvatarFrameRequirement r : rows) {
            if (r != null && r.getFrame() != null && r.getFrame().getId() != null) {
                grouped.computeIfAbsent(r.getFrame().getId(), k -> new ArrayList<>()).add(r);
            }
        }
        for (Long id : missing) {
            List<AvatarFrameRequirement> list = grouped.get(id);
            requirementsCache.put(id, list == null ? List.of() : List.copyOf(list));
        }
    }

    public void evictRequirementsCache() {
        requirementsCache.clear();
    }

    private List<AvatarFrameRequirement> requirementsForFrame(Long frameId) {
        if (frameId == null) {
            return List.of();
        }
        List<AvatarFrameRequirement> cached = requirementsCache.get(frameId, id -> {
            List<AvatarFrameRequirement> rows = requirementRepository.findByFrameId(id);
            return rows == null || rows.isEmpty() ? List.of() : List.copyOf(rows);
        });
        return cached != null ? cached : List.of();
    }

    /**
     * Checks if a user meets all requirements for a given frame.
     * Supports multi-requirement composition (AND logic).
     */
    public boolean isFrameEligible(Long userId, Long frameId) {
        if (userId == null) {
            return false;
        }

        List<AvatarFrameRequirement> requirements = requirementsForFrame(frameId);
        if (requirements == null || requirements.isEmpty()) {
            return false;
        }

        for (AvatarFrameRequirement req : requirements) {
            PrestigeMetricEvaluator evaluator = findEvaluator(req.getMetricType());
            if (evaluator == null) {
                log.warn("No evaluator found for metricType={}", req.getMetricType());
                return false;
            }
            MetricEvaluationResult result = evaluator.evaluate(userId, req);
            if (!result.eligible()) {
                return false;
            }
        }

        return true;
    }

    /**
     * Computes the normalized, server-authoritative progress contract for a frame.
     * Decoupled from ownership and equipped state:
     * - progress.status reflects requirement eligibility: LOCKED, PROGRESSING, ELIGIBLE
     * - ownership DTO independently reflects owned, equipped, and expired states.
     */
    public AvatarFrameProgressDto computeProgress(
            Long userId,
            Long frameId,
            boolean isOwned,
            boolean isEquipped,
            boolean isExpired
    ) {
        List<AvatarFrameRequirement> requirements = requirementsForFrame(frameId);
        if (requirements == null || requirements.isEmpty()) {
            String status = isOwned ? "ELIGIBLE" : "LOCKED";
            return new AvatarFrameProgressDto(
                    0.0,
                    1.0,
                    isOwned ? 100.0 : 0.0,
                    "SPECIAL_GRANT",
                    status,
                    isOwned ? "Đã sở hữu" : "Khung đặc biệt",
                    "Đặc quyền / Di sản"
            );
        }

        List<MetricEvaluationResult> results = new ArrayList<>();
        for (AvatarFrameRequirement req : requirements) {
            PrestigeMetricEvaluator evaluator = findEvaluator(req.getMetricType());
            if (evaluator != null) {
                results.add(evaluator.evaluate(userId, req));
            } else {
                // Evaluator not connected / event entitlement engine not yet established
                results.add(new MetricEvaluationResult(
                        false,
                        0.0,
                        1.0,
                        0.0,
                        req.getMetricType(),
                        "Chưa kết nối",
                        req.getTargetValue() != null ? req.getTargetValue() : "Chưa mở"
                ));
            }
        }

        if (results.isEmpty()) {
            String status = isOwned ? "ELIGIBLE" : "LOCKED";
            return new AvatarFrameProgressDto(0.0, 1.0, isOwned ? 100.0 : 0.0, "SPECIAL_GRANT", status, "-", "-");
        }

        boolean allEligible = results.stream().allMatch(MetricEvaluationResult::eligible);

        // Bottleneck metric is the one with the lowest progress percent
        MetricEvaluationResult bottleneck = results.stream()
                .min(Comparator.comparingDouble(MetricEvaluationResult::percent))
                .orElse(results.get(0));

        double overallPercent = isOwned ? 100.0 : bottleneck.percent();
        String status = determineProgressStatus(isOwned, allEligible, overallPercent);

        List<AvatarFrameConditionDto> conditionDtos = null;
        if (results.size() > 1) {
            conditionDtos = results.stream()
                    .map(r -> new AvatarFrameConditionDto(
                            r.metricType(),
                            r.currentValue(),
                            r.targetValue(),
                            r.percent(),
                            r.displayCurrent(),
                            r.displayTarget()
                    ))
                    .toList();
        }

        return new AvatarFrameProgressDto(
                bottleneck.currentValue(),
                bottleneck.targetValue(),
                overallPercent,
                bottleneck.metricType(),
                status,
                bottleneck.displayCurrent(),
                bottleneck.displayTarget(),
                conditionDtos
        );
    }

    private String determineProgressStatus(
            boolean isOwned,
            boolean allEligible,
            double percent
    ) {
        if (isOwned || allEligible || percent >= 100.0) {
            return "ELIGIBLE";
        }
        if (percent > 0.0) {
            return "PROGRESSING";
        }
        return "LOCKED";
    }

    private PrestigeMetricEvaluator findEvaluator(String metricType) {
        if (metricType == null) return null;
        for (PrestigeMetricEvaluator eval : evaluators) {
            if (eval.supports(metricType)) {
                return eval;
            }
        }
        return null;
    }
}
