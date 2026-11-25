package com.englishcoach.speaking.dto;

import com.englishcoach.speaking.entity.SpeakingTurnFeedback;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.LocalDateTime;
import java.util.List;

public record SpeakingTurnFeedbackDto(
        Long id,
        Long turnId,
        String summary,
        String positiveFeedback,
        List<TurnCorrectionDto> corrections,
        Boolean isMocked,
        LocalDateTime createdAt
) {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    public static SpeakingTurnFeedbackDto fromEntity(SpeakingTurnFeedback entity) {
        if (entity == null) return null;

        List<TurnCorrectionDto> correctionsList = List.of();
        if (entity.getCorrectionsJson() != null && !entity.getCorrectionsJson().isBlank()) {
            try {
                correctionsList = MAPPER.readValue(entity.getCorrectionsJson(), new TypeReference<List<TurnCorrectionDto>>() {});
            } catch (Exception e) {
                correctionsList = List.of();
            }
        }

        return new SpeakingTurnFeedbackDto(
                entity.getId(),
                entity.getTurn() != null ? entity.getTurn().getId() : null,
                entity.getSummary(),
                entity.getPositiveFeedback(),
                correctionsList,
                entity.getIsMocked() != null ? entity.getIsMocked() : false,
                entity.getCreatedAt()
        );
    }
}
