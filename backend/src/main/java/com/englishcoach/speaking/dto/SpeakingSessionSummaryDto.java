package com.englishcoach.speaking.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SpeakingSessionSummaryDto {
    private Long sessionId;
    private Long materialId;
    private String materialTitle;
    private String mode;
    private String status;
    private Integer sentencesPracticed;
    private Integer totalSentences;
    private Integer attemptCount;
    private Integer retryCount;
    private Integer resolvedTargetCount;
    private Integer durationSeconds;
    private Double averagePronunciationScore;
    private Double averageAccuracyScore;
    private String cefrLevel;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    public SpeakingSessionSummaryDto(
            Long sessionId,
            Long materialId,
            String materialTitle,
            String mode,
            String status,
            Integer sentencesPracticed,
            Integer totalSentences,
            Integer attemptCount,
            Integer retryCount,
            Integer resolvedTargetCount,
            LocalDateTime createdAt,
            LocalDateTime updatedAt
    ) {
        this(
                sessionId,
                materialId,
                materialTitle,
                mode,
                status,
                sentencesPracticed,
                totalSentences,
                attemptCount,
                retryCount,
                resolvedTargetCount,
                null,
                null,
                null,
                null,
                createdAt,
                updatedAt
        );
    }
}
