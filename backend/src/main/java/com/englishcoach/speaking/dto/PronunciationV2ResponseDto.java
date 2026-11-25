package com.englishcoach.speaking.dto;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * Spring Boot DTO for Pronunciation Engine V2 Canonical Production Response.
 * Maps 1-to-1 with Python PronunciationV2Response schema.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class PronunciationV2ResponseDto {

    private String requestId;
    private String engineVersion;
    private String status; // COMPLETED, ABSTAINED, FAILED
    private String abstentionReason;
    private OverallScoreDto overall;
    private LexicalStressDto lexicalStress;

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class LexicalStressDto {
        private String method;
        private String status;
        private int assessed;
        private int matched;
        private List<Map<String, Object>> words;
    }
    private AudioQualityDto audioQuality;
    private ContentFidelityDto contentFidelity;
    private static final com.fasterxml.jackson.databind.ObjectMapper HISTORY_MAPPER = new com.fasterxml.jackson.databind.ObjectMapper();

    public static Integer historicalStressScore(String storedResult) {
        if (storedResult == null || storedResult.isBlank()) return null;
        try {
            var stress = HISTORY_MAPPER.readTree(storedResult).path("lexicalStress");
            if (stress.isMissingNode() || stress.isNull()) return null;
            var result = new PronunciationV2ResponseDto();
            result.lexicalStress = HISTORY_MAPPER.treeToValue(stress, LexicalStressDto.class);
            return result.measuredStressScore();
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            return null;
        }
    }

    public Integer measuredStressScore() {
        if (lexicalStress == null || !"ALIGNED_VOWEL_PROMINENCE_V1".equals(lexicalStress.method)
                || !"ASSESSED".equals(lexicalStress.status) || lexicalStress.assessed < 1
                || lexicalStress.matched < 0 || lexicalStress.matched > lexicalStress.assessed) return null;
        return (int) Math.round(100.0 * lexicalStress.matched / lexicalStress.assessed);
    }

    public PronunciationV2ResponseDto useMeasuredStress() {
        if (overall != null && "pronunciation-v2.2".equals(engineVersion)) overall.setStressScore(measuredStressScore());
        return this;
    }

    private List<WordAssessmentDto> words;
    private List<PhoneAssessmentDto> phones;
    private ProsodyDto prosody;
    private Map<String, Object> connectedSpeech;
    private List<String> strengths;
    private List<ActionablePriorityDto> priorities;
    private List<AbstentionItemDto> abstentions;
    private Map<String, Double> timing;
    private Map<String, Object> diagnostics;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class OverallScoreDto {
        private Integer overallScore;
        private Integer segmentalScore;
        private Integer stressScore;
        private Integer intonationScore;
        private Integer rhythmScore;
        private Integer fluencyScore;
        private Boolean passed;
        private String feedbackCategory;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class AudioQualityDto {
        private Double durationSec;
        private Double rmsEnergyDb;
        private Double snrEstimateDb;
        private Double snrDb;
        private Boolean isClipping;
        private Double clippingRatio;
        private Boolean isSilent;
        private Double silenceRatio;
        private Double speechRatio;
        private String qualityStatus; // GOOD, ACCEPTABLE, POOR, UNUSABLE
        private List<String> warnings;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ContentFidelityDto {
        private String fidelityStatus; // PASS, PARTIAL, QUARANTINED
        private Double wordMatchRatio;
        private Integer matchPercentage;
        private Integer matchedWordsCount;
        private Integer totalExpectedWords;
        private List<WordAlignmentItemDto> alignedWords;
        private List<MatchedIslandDto> matchedIslands;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class WordAlignmentItemDto {
        private Integer targetIndex;
        private String targetWord;
        private String recognizedWord;
        private String status; // MATCH, SUBSTITUTION, OMISSION, INSERTION, REPETITION, HESITATION
        private Double startTimeSec;
        private Double endTimeSec;
        private Double confidence;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class MatchedIslandDto {
        private Integer islandIndex;
        private Integer targetStartIdx;
        private Integer targetEndIdx;
        private List<String> words;
        private Double startTimeSec;
        private Double endTimeSec;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class WordAssessmentDto {
        private Integer wordIndex;
        private String word;
        private String status; // GOOD, NEEDS_WORK, UNCERTAIN, OFF_SCRIPT, OMITTED, NOT_SCORED
        private Integer accuracyScore;
        private Double stressAccuracy;
        private Integer expectedStress;
        private Integer observedStress;
        private List<PhoneAssessmentDto> phones;
        private Double startTimeMs;
        private Double endTimeMs;
        private Boolean actionable;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class PhoneAssessmentDto {
        private Integer phoneIndex;
        private Integer wordIndex;
        private String expectedPhone;
        private List<String> acceptedRealizations;
        private String qualityClass; // ACCEPTABLE, WEAK, UNCERTAIN, ERROR
        private Double qualityScore;
        private Double qualityConfidence;
        private Double alignmentConfidence;
        private String observedPhone;
        private Double observedPhoneConfidence;
        private String diagnosisType;
        private Map<String, Object> articulatoryDiff;
        private Double startTimeMs;
        private Double endTimeMs;
        private Boolean actionable;
        private String abstentionReason;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ProsodyDto {
        private Double speechRate;
        private Double articulationRate;
        private Double pauseDuration;
        private Integer pauseCount;
        private Double pauseRatio;
        private Double phonationRatio;
        @JsonProperty("nPviV")
        @JsonAlias({"vowelNpvi", "vowel_npvi", "npviV"})
        private Double nPviV;
        private Double varcoV;
        private Double meanF0;
        private Double medianF0;
        private List<Double> f0Contour;
        private Double f0ContourCorrelation;
        @JsonAlias({"terminal_slope"})
        private Object terminalSlope;
        @JsonAlias({"terminal_contour"})
        private String terminalContour;
        private Double humanHolisticFluencyScore;
        private Double taskConfidence;
        private String abstentionReason;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ActionablePriorityDto {
        private Integer priorityRank;
        private String targetType; // PHONE, STRESS, INTONATION, RHYTHM
        private String targetUnit;
        private String word;
        private String phone;
        private String observed;
        private String issue;
        private String instructionVi;
        private String instructionEn;
        private Map<String, Object> evidence;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class AbstentionItemDto {
        private String level; // UTTERANCE, WORD, PHONE, PROSODY_TASK
        private String scope;
        private String reason;
    }
}
