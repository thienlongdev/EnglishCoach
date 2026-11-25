package com.englishcoach.writing.dto;

import com.englishcoach.writing.enums.WritingSessionStage;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PortfolioSummaryItemDto {
    private String sessionId;
    private String taskId;
    private String taskTitle;
    private String category;
    private WritingSessionStage stage;
    private Integer draftCount;
    private Boolean isFavorite;
    private Instant completedAt;
    private Instant updatedAt;
    private Integer wordCount;
    private Integer overallScore;

    // Persisted Evidence for Before / After Comparative Diptych
    private String firstDraftPreview;
    private String finalDraftPreview;
    private Integer firstDraftWordCount;
    private Integer finalDraftWordCount;
    private Integer firstDraftScore;
    private Integer finalDraftScore;
    private Integer firstDraftIssueCount;
    private Integer finalDraftIssueCount;
}
