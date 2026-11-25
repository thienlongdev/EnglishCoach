package com.englishcoach.common.event;

import java.time.Instant;

/**
 * Published once by {@code ListeningServiceImpl#submitExerciseAttempt} after the attempt is saved.
 * {@code accuracyPct} (0–100) is computed server-side by {@code DictationScoringService}.
 */
public record DictationAttemptSubmittedEvent(
        Long userId,
        Long attemptId,
        Long exerciseId,
        Long materialId,
        Long listeningSessionId,
        String contentCefr,
        Double accuracyPct,
        Boolean correct,
        Instant occurredAt
) {}
