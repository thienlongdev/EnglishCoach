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
public class AdaptiveTaskAiResponse {
    private String title;
    private String prompt;
    private String guidance;
    private String audience;

    @JsonProperty("target_register")
    private String targetRegister;

    @JsonProperty("target_word_count_min")
    private Integer targetWordCountMin;

    @JsonProperty("target_word_count_max")
    private Integer targetWordCountMax;

    private List<String> requirements;

    @JsonProperty("elicited_patterns")
    private List<String> elicitedPatterns;
}
