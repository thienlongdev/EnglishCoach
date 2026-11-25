package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;

/**
 * Strategy interface for independent prestige metric evaluators.
 * Consumes authoritative existing domain data and derives eligibility.
 */
public interface PrestigeMetricEvaluator {

    /**
     * Determines whether this evaluator handles the given metric type.
     */
    boolean supports(String metricType);

    /**
     * Evaluates a requirement for a given user against authoritative domain data.
     *
     * @param userId Authenticated user ID (null for anonymous visitors)
     * @param requirement Authoritative requirement rule from database
     * @return Normalized evaluation result
     */
    MetricEvaluationResult evaluate(Long userId, AvatarFrameRequirement requirement);
}
