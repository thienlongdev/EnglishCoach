package com.englishcoach.common.contract;

import java.util.Map;

/**
 * Compact, stored Learning Path summary for Echo (goal, stage, today's task counts and remaining skills). Read-only:
 * never generates a plan, never calls AI. Empty map when the learner has no plan.
 */
public interface LearningPlanSummarySource {
    Map<String, Object> planSummary(long userId);
}
