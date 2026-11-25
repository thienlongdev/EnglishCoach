package com.englishcoach.writing.translation.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.*;

import java.util.List;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationGradeAiRequest {
    @JsonProperty("source_vi")
    private String sourceVi;

    @JsonProperty("reference_en")
    private String referenceEn;

    @JsonProperty("submitted_en")
    private String submittedEn;

    @JsonProperty("topic_code")
    private String topicCode;

    @JsonProperty("difficulty_bucket")
    private String difficultyBucket;

    @JsonProperty("target_chunks")
    private List<Map<String, Object>> targetChunks;

    @JsonProperty("model")
    private String model;

    @JsonProperty("fallback_model")
    private String fallbackModel;
}
