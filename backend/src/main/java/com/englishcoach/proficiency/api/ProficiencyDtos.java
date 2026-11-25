package com.englishcoach.proficiency.api;

import jakarta.validation.constraints.NotNull;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/** DTOs of the minimal Proficiency API (Phase 2 Step 3). */
public final class ProficiencyDtos {

    private ProficiencyDtos() {}

    public record OverallDto(Integer rating, String currentCefr, Integer peakRating, String peakCefr,
                             double confidence, String status, String confidenceLabel) {}

    public record SkillDto(String skill, Integer rating, String cefr, double confidence, String status,
                           Instant lastEvidenceAt) {}

    /**
     * @param placementCta     url of the placement entry point, or null when every active skill
     *                         already has T1 evidence
     * @param placementFormIds configured per-skill placement form ids (may be empty)
     */
    public record ProficiencyMeResponse(OverallDto overall, List<SkillDto> skills, String placementCta,
                                        Map<String, String> placementFormIds, boolean showOnProficiencyBoard) {}

    public record VisibilityRequest(@NotNull Boolean showOnProficiencyBoard) {}

    public record VisibilityResponse(boolean showOnProficiencyBoard) {}
}
