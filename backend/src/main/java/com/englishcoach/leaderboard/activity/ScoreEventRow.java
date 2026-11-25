package com.englishcoach.leaderboard.activity;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * One immutable row of {@code public.score_events}. {@code eligiblePoints} is computed once at
 * insert time (after the module's daily cap) and never changes.
 */
public record ScoreEventRow(
        Long id,
        Long userId,
        ActivitySource sourceModule,
        String sourceRef,
        SkillGroup skillGroup,
        BigDecimal base,
        Cefr cefrLevel,
        BigDecimal cefrMult,
        BigDecimal qualityMult,
        BigDecimal relativeMult,
        int rawPoints,
        int eligiblePoints,
        boolean capped,
        Instant occurredAt,
        Instant createdAt
) {}
