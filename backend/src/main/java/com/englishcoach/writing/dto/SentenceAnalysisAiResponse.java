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
public class SentenceAnalysisAiResponse {

    @JsonProperty("grammatically_correct")
    private Boolean grammaticallyCorrect;

    @JsonProperty("analysis_status")
    private String analysisStatus;

    @JsonProperty("dimension_verdicts")
    @Builder.Default
    private List<DimensionVerdictDto> dimensionVerdicts = new ArrayList<>();

    @JsonProperty("issues")
    @Builder.Default
    private List<FeedbackIssueDto> issues = new ArrayList<>();

    @JsonProperty("suggested_improvement")
    private String suggestedImprovement;

    @JsonProperty("explanation")
    private String explanation;

    @JsonProperty("model_used")
    private String modelUsed;

    @JsonProperty("result_source")
    private String resultSource;
}
