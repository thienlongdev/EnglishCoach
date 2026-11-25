package com.englishcoach.common.event;

import com.englishcoach.exams.model.ExamTypes.ScoreMetric;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * Published once by {@code ExamJobWorker#executeSubmissionScoring} after the score artifact,
 * components and criteria are persisted. {@code metricScores} are server-computed standardized
 * scores (IELTS bands 0–9; TOEIC L/R 5–495, W/S 0–200, LR_TOTAL 10–990).
 */
public record ExamScoredEvent(
        Long userId,
        UUID attemptId,
        UUID submissionId,
        UUID artifactId,
        Integer runOrdinal,
        UUID formId,
        String family,
        String variant,
        String scope,
        String attemptMode,
        String resultStatus,
        Map<ScoreMetric, Double> metricScores,
        Instant occurredAt
) {}
