package com.englishcoach.leaderboard.activity.event;

import java.time.Instant;

/**
 * Published once by {@code SpeakingShadowingService#recordAttempt} after the attempt is saved.
 * The scores are CLIENT-REPORTED (posted by the shadowing page) — never Proficiency evidence.
 * {@code pronunciationScore == null} means abstention.
 */
public record ShadowingAttemptRecordedEvent(
        Long userId,
        Long attemptId,
        Long sessionId,
        Long unitId,
        Long materialId,
        String contentCefr,
        Double pronunciationScore,
        Double accuracyScore,
        Double fluencyScore,
        Boolean mocked,
        Integer retryIndex,
        Instant occurredAt
) {}
