package com.englishcoach.writing.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.englishcoach.writing.enums.AssessmentStatus;
import lombok.*;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class DocumentAssessmentResultDto {
    private String assessmentId;
    private String submissionId;
    private Integer draftOrdinal;
    private AssessmentStatus status;
    private Integer overallScore;

    @JsonProperty("id")
    public String getId() {
        return assessmentId;
    }

    @Builder.Default
    private List<DimensionVerdictDto> dimensionVerdicts = new ArrayList<>();

    @Builder.Default
    private List<FeedbackIssueDto> prioritizedIssues = new ArrayList<>();

    @Builder.Default
    private List<FeedbackIssueDto> allIssues = new ArrayList<>();

    @Builder.Default
    private List<String> strengths = new ArrayList<>();

    private String summary;
    private Instant createdAt;
}
