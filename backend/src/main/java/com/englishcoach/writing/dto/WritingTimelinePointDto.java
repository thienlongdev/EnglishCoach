package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class WritingTimelinePointDto {
    private String sessionId;
    private String taskTitle;
    private Instant completedAt;
    private int wordCount;
    private Integer draft1Score;
    private Integer finalScore;
    private Integer revisionGain;
}
