package com.englishcoach.speaking.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * Canonical unified Shadowing analysis response.
 * Separates Whisper STT content match from Pronunciation V2.2 acoustic scoring.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class ShadowingAnalysisResponseDto {
    private String clientAttemptId;
    private String learnerTranscript;
    private Double accuracyScore; // Content match score (0-100) derived from Whisper transcript vs reference
    private Double pronunciationScore; // Real acoustic score (0-100) from Pronunciation V2.2, or null
    private Double fluencyScore; // Real fluency/prosody score from Pronunciation V2.2, or null
    private List<Map<String, Object>> wordAlignment; // Token DP content match alignment
    private PronunciationV2ResponseDto pronunciationV2; // Full structured V2.2 response
    private Boolean isMocked;
    private String feedback;
    private Integer durationSeconds;
    private String audioRef;
}
