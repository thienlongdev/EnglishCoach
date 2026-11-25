package com.englishcoach.listening.dto;

import com.englishcoach.listening.entity.enums.ErrorCategory;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ExerciseAttemptResponse {
    private Long id;
    private Long listeningSessionId;
    private Boolean isCorrect;
    private Double accuracyPercentage;
    private ErrorCategory primaryErrorCategory;
    private String expectedAnswer; // Send back after attempt for feedback
    private String rawUserAnswer;
    private AiDiagnosticResponse diagnosticFeedback;
}
