package com.englishcoach.speaking.dto;

import com.englishcoach.speaking.entity.SpeakingTurn;

import java.time.LocalDateTime;
import java.util.List;

public record SpeakingTurnDto(
        Long id,
        Long sessionId,
        String clientTurnId,
        Integer sequenceNumber,
        String speaker,
        String text,
        List<String> detectedVocabulary,
        Boolean isMocked,
        Integer durationSeconds,
        Integer pronunciationScore,
        Integer fluencyScore,
        Integer stressScore,
        Integer intonationScore,
        Integer rhythmScore,
        Integer segmentalScore,
        String engineVersion,
        String pronunciationResultJson,
        String audioRef,
        String synthesizedAudioRef,
        SpeakingTurnFeedbackDto feedback,
        LocalDateTime createdAt
) {
    public SpeakingTurnDto(
            Long id,
            Long sessionId,
            String clientTurnId,
            Integer sequenceNumber,
            String speaker,
            String text,
            List<String> detectedVocabulary,
            Boolean isMocked,
            Integer durationSeconds,
            Integer pronunciationScore,
            Integer fluencyScore,
            Integer stressScore,
            Integer intonationScore,
            Integer rhythmScore,
            Integer segmentalScore,
            String engineVersion,
            String pronunciationResultJson,
            String audioRef,
            SpeakingTurnFeedbackDto feedback,
            LocalDateTime createdAt
    ) {
        this(id, sessionId, clientTurnId, sequenceNumber, speaker, text, detectedVocabulary, isMocked,
                durationSeconds, pronunciationScore, fluencyScore, stressScore, intonationScore, rhythmScore,
                segmentalScore, engineVersion, pronunciationResultJson, audioRef, null, feedback, createdAt);
    }

    public static SpeakingTurnDto fromEntity(SpeakingTurn entity) {
        return fromEntity(entity, null);
    }

    public static SpeakingTurnDto fromEntity(SpeakingTurn entity, SpeakingTurnFeedbackDto feedback) {
        if (entity == null) return null;
        return new SpeakingTurnDto(
                entity.getId(),
                entity.getSession() != null ? entity.getSession().getId() : null,
                entity.getClientTurnId(),
                entity.getSequenceNumber(),
                entity.getSpeaker(),
                entity.getText(),
                entity.getDetectedVocabulary() != null ? List.copyOf(entity.getDetectedVocabulary()) : List.of(),
                entity.getIsMocked() != null ? entity.getIsMocked() : false,
                entity.getDurationSeconds(),
                entity.getPronunciationScore(),
                entity.getFluencyScore(),
                PronunciationV2ResponseDto.historicalStressScore(entity.getPronunciationResultJson()),
                entity.getIntonationScore(),
                entity.getRhythmScore(),
                entity.getSegmentalScore(),
                entity.getEngineVersion(),
                entity.getPronunciationResultJson(),
                entity.getAudioRef(),
                entity.getSynthesizedAudioRef(),
                feedback,
                entity.getCreatedAt()
        );
    }
}
