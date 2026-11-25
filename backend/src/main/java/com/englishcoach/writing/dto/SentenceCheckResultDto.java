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
public class SentenceCheckResultDto {
    private String assessmentId;
    private String submissionId;
    private AssessmentStatus status;
    private Boolean grammaticallyCorrect;

    @JsonProperty("id")
    public String getId() {
        return assessmentId;
    }
    private String analysisStatus;
    private String coverageSummary;

    @Builder.Default
    private List<DimensionVerdictDto> dimensionVerdicts = new ArrayList<>();

    @Builder.Default
    private List<FeedbackIssueDto> issues = new ArrayList<>();

    private String suggestedImprovement;
    private String explanation;
    private Instant createdAt;

    private String correctedSentence;
    private String originalText;
}
