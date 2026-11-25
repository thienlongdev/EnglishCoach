package com.englishcoach.common.event;

import java.time.Instant;

/**
 * Published once by {@code SpeakingRoleplayService#processTurn} after the learner and assistant
 * turns are saved. Scores come from the AI pronunciation engine (server-side).
 */
public record RoleplayTurnRecordedEvent(
        Long userId,
        Long sessionId,
        Long learnerTurnId,
        Long scenarioId,
        String contentCefr,
        Integer pronunciationScore,
        Integer fluencyScore,
        Boolean asrMocked,
        Instant occurredAt
) {}
