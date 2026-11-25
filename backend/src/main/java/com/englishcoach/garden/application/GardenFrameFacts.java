package com.englishcoach.garden.application;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.avatarframe.evaluator.MetricEvaluationResult;
import com.englishcoach.avatarframe.evaluator.PrestigeMetricEvaluator;
import com.englishcoach.avatarframe.service.FrameAudience;
import com.englishcoach.avatarframe.service.GardenFrameCatalog;
import com.englishcoach.garden.config.GardenProperties;
import com.englishcoach.garden.infra.EstateRepository;
import com.englishcoach.garden.infra.KnowledgeRepository;
import com.englishcoach.garden.infra.MonumentRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.text.NumberFormat;
import java.util.Locale;
import java.util.Set;

/**
 * The stored garden facts the Echo Garden profile frames are earned from, exposed to the avatar-frame module in its own
 * terms: a {@link PrestigeMetricEvaluator} for the metrics of V87 and the {@link FrameAudience} of the GARDEN lineage.
 *
 * <ul>
 *   <li>{@code GARDEN_LEARNING_DAYS} — verified learning days of the Knowledge Tree ({@code garden_monument});</li>
 *   <li>{@code GARDEN_MONUMENT_ERA} — its era, 0–4;</li>
 *   <li>{@code GARDEN_HARVESTS} — lifetime harvests (the crop mastery counters);</li>
 *   <li>{@code GARDEN_GRADUATIONS} — graduated memory trees;</li>
 *   <li>{@code GARDEN_COIN} — a frame that is bought in the garden: never "eligible", so the frame engine can never
 *   grant it for free; the requirement only carries the price for display.</li>
 * </ul>
 * Read only, never anything the client reports. A learner without garden access has no garden facts (0) and is not
 * offered the lineage; a read failure counts as "not reached" (a frame is never granted on an error).
 */
@Slf4j
@Component
public class GardenFrameFacts implements PrestigeMetricEvaluator, FrameAudience {

    public static final String LEARNING_DAYS = "GARDEN_LEARNING_DAYS";
    public static final String MONUMENT_ERA = "GARDEN_MONUMENT_ERA";
    public static final String HARVESTS = "GARDEN_HARVESTS";
    public static final String GRADUATIONS = "GARDEN_GRADUATIONS";
    private static final Set<String> METRICS = Set.of(LEARNING_DAYS, MONUMENT_ERA, HARVESTS, GRADUATIONS, GardenFrameCatalog.UNLOCK_COIN);

    private final GardenAccessService access;
    private final GardenProperties properties;
    private final MonumentRepository monument;
    private final EstateRepository estate;
    private final KnowledgeRepository knowledge;

    public GardenFrameFacts(GardenAccessService access, GardenProperties properties, MonumentRepository monument,
                            EstateRepository estate, KnowledgeRepository knowledge) {
        this.access = access;
        this.properties = properties;
        this.monument = monument;
        this.estate = estate;
        this.knowledge = knowledge;
    }

    /** The player's stored value of a metric (0 without garden access, without a garden, or when the read fails). */
    public long value(long userId, String metric) {
        if (!access.allowed(userId)) return 0;
        try {
            return switch (metric) {
                case LEARNING_DAYS -> {
                    var m = monument.row(userId);
                    yield m == null ? 0 : m.learningDays();
                }
                case MONUMENT_ERA -> {
                    var m = monument.row(userId);
                    yield m == null ? 0 : m.era();
                }
                case HARVESTS -> estate.harvests(userId);
                case GRADUATIONS -> knowledge.forestCount(userId);
                default -> 0;
            };
        } catch (RuntimeException e) {
            log.debug("garden frame fact {} unavailable for user {}: {}", metric, userId, e.getMessage());
            return 0;
        }
    }

    // ------------------------------------------------------------------ PrestigeMetricEvaluator

    @Override
    public boolean supports(String metricType) {
        return metricType != null && METRICS.contains(metricType);
    }

    @Override
    public MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement) {
        String metric = requirement.getMetricType();
        double target;
        try {
            target = Double.parseDouble(requirement.getTargetValue().trim());
        } catch (RuntimeException e) {
            return new MetricEvaluationResult(false, 0, 1, 0, metric, "—", "—");
        }
        NumberFormat nf = NumberFormat.getIntegerInstance(Locale.forLanguageTag("vi-VN"));
        if (GardenFrameCatalog.UNLOCK_COIN.equals(metric)) {
            return new MetricEvaluationResult(false, 0, target, 0, metric, "Mua tại Echo Garden", nf.format((long) target) + " Đồng Echo");
        }
        long have = userId == null || target <= 0 ? 0 : value(userId, metric);
        boolean ok = userId != null && target > 0 && have >= target;
        double percent = target <= 0 ? 0 : Math.min(100.0, 100.0 * have / target);
        return new MetricEvaluationResult(ok, have, target, percent, metric, nf.format(have), nf.format((long) target));
    }

    // ------------------------------------------------------------------ FrameAudience

    @Override
    public boolean offered(Long userId, String lineage) {
        if (!GardenFrameCatalog.LINEAGE.equals(lineage)) return true;
        return userId != null && properties.isFramesEnabled() && access.allowed(userId);
    }
}
