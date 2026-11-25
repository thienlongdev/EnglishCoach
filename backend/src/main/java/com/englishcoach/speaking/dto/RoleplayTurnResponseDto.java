package com.englishcoach.speaking.dto;

import java.util.List;

public record RoleplayTurnResponseDto(
        Long sessionId,
        SpeakingTurnDto learnerTurn,
        SpeakingTurnDto assistantTurn,
        List<String> detectedVocabularyThisTurn,
        List<String> allDetectedVocabularySoFar,
        Boolean isTaskCompleted,
        Boolean isIdempotentReplay,
        Boolean isMocked,
        PronunciationV2ResponseDto pronunciationFeedback
) {
    public RoleplayTurnResponseDto(
            Long sessionId,
            SpeakingTurnDto learnerTurn,
            SpeakingTurnDto assistantTurn,
            List<String> detectedVocabularyThisTurn,
            List<String> allDetectedVocabularySoFar,
            Boolean isTaskCompleted,
            Boolean isIdempotentReplay,
            Boolean isMocked
    ) {
        this(
                sessionId,
                learnerTurn,
                assistantTurn,
                detectedVocabularyThisTurn,
                allDetectedVocabularySoFar,
                isTaskCompleted,
                isIdempotentReplay,
                isMocked,
                null
        );
    }
}
