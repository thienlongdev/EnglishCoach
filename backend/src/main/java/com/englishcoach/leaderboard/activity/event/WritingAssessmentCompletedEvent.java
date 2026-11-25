package com.englishcoach.leaderboard.activity.event;

import java.time.Instant;

/**
 * Published once by {@code WritingSessionServiceImpl#evaluateAndPersistAssessment} after a
 * document assessment is saved as READY. {@code overallScore} is a 0–100 rubric score, NOT an
 * IELTS band.
 */
public record WritingAssessmentCompletedEvent(
        Long userId,
        String sessionId,
        String submissionId,
        String assessmentId,
        String taskId,
        Integer overallScore,
        Integer draftOrdinal,
        Instant occurredAt
) {}
