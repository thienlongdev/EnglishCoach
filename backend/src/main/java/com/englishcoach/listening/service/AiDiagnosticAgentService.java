package com.englishcoach.listening.service;

import com.englishcoach.listening.dto.AiDiagnosticResponse;
import com.englishcoach.listening.entity.ExerciseAttempt;
import com.englishcoach.listening.entity.enums.ErrorCategory;
import org.springframework.stereotype.Service;

@Service
public class AiDiagnosticAgentService {

    public AiDiagnosticResponse analyzeListeningFailure(ExerciseAttempt attempt) {
        ErrorCategory category = attempt.getPrimaryErrorCategory();
        if (Boolean.TRUE.equals(attempt.getIsCorrect()) || category == null
                || category == ErrorCategory.MINOR_SPELLING || category == ErrorCategory.EXACT_MATCH) {
            return null;
        }
        String suggestion = switch (category) {
            case MISSING_WORD -> "Replay the sentence and listen for the missing word.";
            case EXTRA_WORD -> "Compare the extra word with the transcript.";
            default -> "Replay this section and compare the highlighted words with the transcript.";
        };
        return AiDiagnosticResponse.builder()
                .source("TOKEN_ALIGNMENT_RULE")
                .errorCategory(category)
                .explanation(suggestion)
                .build();
    }
}
