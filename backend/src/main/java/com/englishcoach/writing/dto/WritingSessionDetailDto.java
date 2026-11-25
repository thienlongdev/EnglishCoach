package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class WritingSessionDetailDto {
    private WritingSessionDto session;
    private Map<String, Object> task;
    private List<DraftSummaryDto> drafts;
    private DocumentAssessmentResultDto finalAssessment;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class DraftSummaryDto {
        private String id;
        private Integer ordinal;
        private String content;
        private Integer wordCount;
        private Instant createdAt;
        private Integer overallScore;
        private String assessmentId;
    }
}
