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
public class SocraticPlanAiResponse {
    @JsonProperty("probing_questions")
    private List<String> probingQuestions;

    @JsonProperty("structural_prompts")
    private List<String> structuralPrompts;

    private String encouragement;

    @JsonProperty("suggested_items")
    private List<SocraticSuggestionItemDto> suggestedItems;
}

