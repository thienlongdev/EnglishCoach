package com.englishcoach.speaking.dto;

import com.englishcoach.speaking.entity.SpeakingScenario;

import java.time.LocalDateTime;

public record SpeakingScenarioSummaryDto(
        Long id,
        String title,
        String description,
        String cefrLevel,
        String category,
        String learnerRole,
        String aiRole,
        Integer estimatedMinutes,
        Boolean isCustom,
        String defaultVoiceId,
        LocalDateTime createdAt
) {
    public SpeakingScenarioSummaryDto(
            Long id,
            String title,
            String description,
            String cefrLevel,
            String category,
            String learnerRole,
            String aiRole,
            Integer estimatedMinutes,
            Boolean isCustom,
            LocalDateTime createdAt
    ) {
        this(id, title, description, cefrLevel, category, learnerRole, aiRole, estimatedMinutes, isCustom, "us_female", createdAt);
    }

    public static SpeakingScenarioSummaryDto fromEntity(SpeakingScenario entity) {
        if (entity == null) return null;
        boolean custom = entity.getOwnerUserId() != null || Boolean.FALSE.equals(entity.getIsSystem());
        String description = entity.getDescription();
        if (!custom) {
            description = com.englishcoach.speaking.service.SpeakingScenarioLocalization.getLocalizedDescription(entity.getTitle(), description);
        }
        String voice = entity.getDefaultVoiceId() != null && !entity.getDefaultVoiceId().isBlank()
                ? entity.getDefaultVoiceId()
                : "us_female";

        return new SpeakingScenarioSummaryDto(
                entity.getId(),
                entity.getTitle(),
                description,
                entity.getCefrLevel() != null ? entity.getCefrLevel().name() : null,
                entity.getCategory() != null ? entity.getCategory().name() : null,
                entity.getLearnerRole(),
                entity.getAiRole(),
                entity.getEstimatedMinutes(),
                custom,
                voice,
                entity.getCreatedAt()
        );
    }
}
