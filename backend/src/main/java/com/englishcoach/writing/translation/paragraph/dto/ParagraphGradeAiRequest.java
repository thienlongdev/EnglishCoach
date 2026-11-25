package com.englishcoach.writing.translation.paragraph.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphGradeAiRequest {

    @JsonProperty("source_vi")
    private String sourceVi;

    @JsonProperty("reference_en")
    private String referenceEn;

    @JsonProperty("submitted_en")
    private String submittedEn;

    @JsonProperty("genre")
    @Builder.Default
    private String genre = "GENERAL";

    @JsonProperty("topic")
    @Builder.Default
    private String topic = "GENERAL";

    @JsonProperty("model")
    private String model;

    @JsonProperty("fallback_model")
    private String fallbackModel;
}
