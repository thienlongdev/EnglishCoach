package com.englishcoach.speaking.dto;

import com.englishcoach.speaking.entity.SpeakingScenario;

import java.time.LocalDateTime;
import java.util.List;

public record SpeakingScenarioDto(
        Long id,
        String title,
        String description,
        String cefrLevel,
        String category,
        String learnerRole,
        String aiRole,
        String learnerGoal,
        List<String> targetVocabulary,
        List<String> targetGrammar,
        String initialAiMessage,
        List<String> successCriteria,
        String completionConditions,
        String evaluationRubric,
        List<String> optionalHints,
        Integer estimatedMinutes,
        Boolean isCustom,
        String defaultVoiceId,
        LocalDateTime createdAt
) {
    public SpeakingScenarioDto(
            Long id,
            String title,
            String description,
            String cefrLevel,
            String category,
            String learnerRole,
            String aiRole,
            String learnerGoal,
            List<String> targetVocabulary,
            List<String> targetGrammar,
            String initialAiMessage,
            List<String> successCriteria,
            String completionConditions,
            String evaluationRubric,
            List<String> optionalHints,
            Integer estimatedMinutes,
            Boolean isCustom,
            LocalDateTime createdAt
    ) {
        this(id, title, description, cefrLevel, category, learnerRole, aiRole, learnerGoal,
                targetVocabulary, targetGrammar, initialAiMessage, successCriteria, completionConditions,
                evaluationRubric, optionalHints, estimatedMinutes, isCustom, "us_female", createdAt);
    }

    public static SpeakingScenarioDto fromEntity(SpeakingScenario entity) {
        if (entity == null) return null;
        boolean custom = entity.getOwnerUserId() != null || Boolean.FALSE.equals(entity.getIsSystem());

        String description = entity.getDescription();
        String learnerGoal = entity.getLearnerGoal();
        List<String> successCriteria = entity.getSuccessCriteria() != null ? List.copyOf(entity.getSuccessCriteria()) : List.of();
        List<String> optionalHints = entity.getOptionalHints() != null ? List.copyOf(entity.getOptionalHints()) : List.of();

        if (!custom) {
            var loc = com.englishcoach.speaking.service.SpeakingScenarioLocalization.getLocalizedContent(entity.getTitle());
            if (loc != null) {
                description = loc.description();
                learnerGoal = loc.learnerGoal();
                successCriteria = loc.successCriteria();
                optionalHints = loc.optionalHints();
            }
        }

        String voice = entity.getDefaultVoiceId() != null && !entity.getDefaultVoiceId().isBlank()
                ? entity.getDefaultVoiceId()
                : "us_female";

        return new SpeakingScenarioDto(
                entity.getId(),
                entity.getTitle(),
                description,
                entity.getCefrLevel() != null ? entity.getCefrLevel().name() : null,
                entity.getCategory() != null ? entity.getCategory().name() : null,
                entity.getLearnerRole(),
                entity.getAiRole(),
                learnerGoal,
                entity.getTargetVocabulary() != null ? List.copyOf(entity.getTargetVocabulary()) : List.of(),
                entity.getTargetGrammar() != null ? List.copyOf(entity.getTargetGrammar()) : List.of(),
                entity.getInitialAiMessage(),
                successCriteria,
                entity.getCompletionConditions(),
                entity.getEvaluationRubric(),
                optionalHints,
                entity.getEstimatedMinutes(),
                custom,
                voice,
                entity.getCreatedAt()
        );
    }
}
