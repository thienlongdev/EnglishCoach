package com.englishcoach.speaking.dto;

import com.fasterxml.jackson.annotation.JsonAlias;
import java.util.List;

public record CreateCustomScenarioRequestDto(
        String topic,
        String cefrLevel,
        String context,
        String learnerRole,
        String aiRole,
        @JsonAlias({"learnerGoal", "missionGoal", "learnerMission", "goal", "learner_goal"})
        String mission,
        List<String> targetVocabulary,
        @JsonAlias({"desiredTurns", "target_turns"})
        Integer targetTurns,
        @JsonAlias({"estimatedMinutes", "estimated_duration"})
        String estimatedDuration,
        @JsonAlias({"voiceId", "voice_id", "defaultVoiceId", "default_voice_id"})
        String voiceId
) {
    public CreateCustomScenarioRequestDto(
            String topic,
            String cefrLevel,
            String context,
            String learnerRole,
            String aiRole,
            String mission,
            List<String> targetVocabulary,
            Integer targetTurns,
            String estimatedDuration
    ) {
        this(topic, cefrLevel, context, learnerRole, aiRole, mission, targetVocabulary, targetTurns, estimatedDuration, null);
    }
}
