package com.englishcoach.writing.dto;

import com.englishcoach.writing.enums.WritingSessionStage;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class WritingSessionDto {
    private String id;
    private Long userId;
    private String taskId;
    private Map<String, Object> taskSnapshot;
    private WritingSessionStage stage;
    private String workingPlan;
    private String workingText;
    private Long currentRevision;
    private String activeAssessmentId;
    private String finalDraftId;
    private Boolean isFavorite;
    private Instant completedAt;
    private Instant createdAt;
    private Instant updatedAt;
}
