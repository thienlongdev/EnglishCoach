package com.englishcoach.writing.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.*;

import java.util.ArrayList;
import java.util.List;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class DocumentAnalysisAiResponse {

    @JsonProperty("overall_score")
    private Integer overallScore;

    @JsonProperty("dimension_verdicts")
    @Builder.Default
    private List<DimensionVerdictDto> dimensionVerdicts = new ArrayList<>();

    @JsonProperty("issues")
    @Builder.Default
    private List<FeedbackIssueDto> issues = new ArrayList<>();

    @JsonProperty("strengths")
    @Builder.Default
    private List<String> strengths = new ArrayList<>();

    @JsonProperty("prioritized_issue_indices")
    @Builder.Default
    private List<Integer> prioritizedIssueIndices = new ArrayList<>();

    @JsonProperty("summary")
    private String summary;
}
