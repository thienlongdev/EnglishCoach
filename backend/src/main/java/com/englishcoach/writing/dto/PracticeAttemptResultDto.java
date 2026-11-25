package com.englishcoach.writing.dto;

import com.englishcoach.writing.enums.PracticeEvaluationStatus;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PracticeAttemptResultDto {
    private String practiceId;
    private Integer attemptOrdinal;
    private Boolean isSuccess;
    private PracticeEvaluationStatus evaluationStatus;
    private String learnerAnswer;
    private String feedback;
    private String unlockedHint;
    private Boolean isCompleted;
    private Boolean masteryUpdated;
    private Integer newEstimatedMastery;
}
