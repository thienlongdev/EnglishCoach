package com.englishcoach.speaking.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonAlias;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class QuickCheckCorrectionDto {
    private String type; // GRAMMAR, NATURALNESS, WORD_CHOICE, COLLOCATION
    private String original;
    private String suggestion;
    @JsonAlias("explanation_vi")
    private String explanationVi;
}
