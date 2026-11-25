package com.englishcoach.avatarframe.evaluator;

/**
 * Normalized result of a single metric requirement evaluation.
 * Server authoritative, never fabricated.
 */
public record MetricEvaluationResult(
    boolean eligible,
    double currentValue,
    double targetValue,
    double percent,
    String metricType,
    String displayCurrent,
    String displayTarget
) {}
