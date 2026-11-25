package com.englishcoach.writing.translation.paragraph.dto;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class ParagraphGradeAiResponse {

    @JsonProperty("accepted")
    private Boolean accepted;

    @JsonProperty("evaluation_status")
    @JsonAlias({"overall_status", "evaluation_status", "status"})
    private String evaluationStatus;

    @JsonProperty("overall_summary")
    @JsonAlias({"headline_summary", "overall_summary", "summary"})
    private String overallSummary;

    @JsonProperty("meaning_verdict")
    private String meaningVerdict;

    @JsonProperty("meaning_score")
    private Integer meaningScore;

    @JsonProperty("grammar_verdict")
    private String grammarVerdict;

    @JsonProperty("grammar_score")
    private Integer grammarScore;

    @JsonProperty("naturalness_verdict")
    private String naturalnessVerdict;

    @JsonProperty("naturalness_score")
    private Integer naturalnessScore;

    @JsonProperty("vocabulary_verdict")
    private String vocabularyVerdict;

    @JsonProperty("vocabulary_score")
    private Integer vocabularyScore;

    @JsonProperty("cohesion_verdict")
    private String cohesionVerdict;

    @JsonProperty("cohesion_score")
    private Integer cohesionScore;

    @JsonProperty("issues")
    @Builder.Default
    private List<ParagraphIssueItemAiDto> issues = new ArrayList<>();

    @JsonProperty("suggested_correction")
    private String suggestedCorrection;

    @JsonProperty("natural_alternative")
    @JsonAlias({"natural_suggestion", "natural_alternative", "suggestion"})
    private String naturalAlternative;

    @JsonProperty("model_id")
    private String modelId;

    @JsonProperty("generation_count")
    @Builder.Default
    private Integer generationCount = 1;

    @JsonProperty("latency_ms")
    private Long latencyMs;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ParagraphIssueItemAiDto {
        @JsonProperty("dimension")
        @JsonAlias({"dimension", "category"})
        private String dimension;

        @JsonProperty("issue_type")
        @JsonAlias({"issue_type", "type"})
        private String issueType;

        @JsonProperty("severity")
        private String severity;

        @JsonProperty("learner_span")
        @JsonAlias({"learner_span", "flagged_text"})
        private String learnerSpan;

        @JsonProperty("span_start")
        @JsonAlias({"span_start", "offset_start"})
        private Integer spanStart;

        @JsonProperty("span_end")
        @JsonAlias({"span_end", "offset_end"})
        private Integer spanEnd;

        @JsonProperty("message")
        private String message;

        @JsonProperty("suggestion")
        private String suggestion;
    }
}
