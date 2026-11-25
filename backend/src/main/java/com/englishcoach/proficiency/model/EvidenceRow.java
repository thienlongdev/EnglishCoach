package com.englishcoach.proficiency.model;

import java.math.BigDecimal;
import java.time.Instant;

/** One immutable row of {@code public.proficiency_evidence}. */
public record EvidenceRow(
        Long id,
        long userId,
        ProficiencySkill skill,
        EvidenceTier tier,
        EvidenceKind kind,
        EvidenceSource sourceModule,
        String sourceRef,
        String materialKey,
        BigDecimal rawScore,
        ProficiencyCefr contentCefr,
        BigDecimal quality,
        int observedRating,
        double tierWeight,
        Instant occurredAt
) {}
