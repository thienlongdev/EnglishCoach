package com.englishcoach.writing.translation.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.*;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationGradeAiResponse {
    @JsonProperty("meaning_verdict")
    private String meaningVerdict;

    @JsonProperty("grammar_verdict")
    private String grammarVerdict;

    @JsonProperty("naturalness_verdict")
    private String naturalnessVerdict;

    @JsonProperty("overall_status")
    private String overallStatus;

    @JsonProperty("accepted")
    private Boolean accepted;

    @JsonProperty("headline_summary")
    private String headlineSummary;

    @JsonProperty("natural_suggestion")
    private String naturalSuggestion;

    @JsonProperty("issues")
    private List<TranslationIssueAiDto> issues;
}
