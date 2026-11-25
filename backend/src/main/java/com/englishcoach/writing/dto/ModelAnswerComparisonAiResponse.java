package com.englishcoach.writing.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ModelAnswerComparisonAiResponse {
    @JsonProperty("exemplar_model_answer")
    private String exemplarModelAnswer;

    @JsonProperty("calibrated_level")
    private String calibratedLevel;

    @JsonProperty("structural_observations")
    private List<String> structuralObservations;

    @JsonProperty("lexical_alternatives")
    private List<String> lexicalAlternatives;

    @JsonProperty("coaching_summary")
    private String coachingSummary;
}
