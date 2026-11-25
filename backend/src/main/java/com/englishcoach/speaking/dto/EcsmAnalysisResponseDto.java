package com.englishcoach.speaking.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class EcsmAnalysisResponseDto {
    private String requestId;
    private String status;
    private String assessmentStatus; // NO_ISSUE_DETECTED, ISSUE_DETECTED, INSUFFICIENT_EVIDENCE, ASSESSMENT_UNAVAILABLE, PARTIAL
    private Double evidenceCoverage;
    private Double targetWordCoverage;
    private Double targetPhoneCoverage;
    private Double alignmentCoverage;
    private Integer contentMatchPercentage;
    private Double contentMatchRatio;
    private Double contentGateMinMatch;
    private String recognizedTranscript;
    private List<Integer> matchedTargetWordIndices;
    private Boolean sameAudioVerified;
    private String audioIdentity;
    private String attemptId;
    private String caseId;
    private String errorCode;
    private String errorMessage;
    private Boolean retryable;
    private AudioQualityDto quality;
    private Boolean segmentalAvailable;
    private Boolean prosodyAvailable;
    private Map<String, Object> assessment;
    private Map<String, Object> retryPlan;
    private Map<String, Object> retryComparison;
    private List<String> warnings;
    private List<String> gatingReasons;
    private String failureStage;
    private String exceptionType;
    private String internalReasonCode;
    private Map<String, Object> timings;
    private Map<String, Object> provenance;
    private Map<String, Object> auditTrace;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class AudioQualityDto {
        private Double durationSec;
        private Double rmsEnergyDb;
        private Double snrEstimateDb;
        private Boolean isClipping;
        private Boolean isSilent;
        private String qualityStatus;
    }
}
