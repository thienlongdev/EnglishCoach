package com.englishcoach.speaking.dto;

import com.fasterxml.jackson.annotation.JsonAlias;

public record SpeakingSessionRequest(
        String mode,
        Long scenarioId,
        String sourceType,
        Long sourceId,
        @JsonAlias({"voice_id", "voiceId", "selectedVoiceId"})
        String voiceId
) {
    public SpeakingSessionRequest(String mode, Long scenarioId, String sourceType, Long sourceId) {
        this(mode, scenarioId, sourceType, sourceId, null);
    }
}
