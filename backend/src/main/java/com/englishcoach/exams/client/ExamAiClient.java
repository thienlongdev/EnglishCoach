package com.englishcoach.exams.client;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.*;
import org.springframework.stereotype.Component;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

import java.time.Duration;
import java.util.*;

@Slf4j
@Component
public class ExamAiClient {

    private final RestTemplate restTemplate;
    private final ExamsProperties properties;
    private final ObjectMapper objectMapper;

    public ExamAiClient(RestTemplateBuilder restTemplateBuilder, ExamsProperties properties, ObjectMapper objectMapper) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        int timeoutSec = properties.getAi().getTimeoutSeconds() > 0 ? Math.max(300, properties.getAi().getTimeoutSeconds()) : 300;
        org.springframework.http.client.SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
        factory.setConnectTimeout(10000);
        factory.setReadTimeout(timeoutSec * 1000);
        factory.setBufferRequestBody(true);
        this.restTemplate = new RestTemplate(factory);
    }

    /**
     * Runtime V4 Speaking Turn Evidence container.
     * Architectural Invariant: Turns carry concrete evidence and diagnostics only.
     * Never store or emit independent IELTS band values at the turn level.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SpeakingTurnEvidenceDto(
            String turnKey,
            int turnSequence,
            String partKey,
            String promptId,
            String promptText,
            UUID recordingId,
            Integer durationMs,
            String transcriptText,
            String transcriptStatus,
            String audioBase64,
            Map<String, Object> acousticEvidence,
            Map<String, Object> diagnostics,
            Double confidence,
            Map<String, Object> abstention
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record AiScoringRequest(
            String stageKey,
            ExamFamily family,
            SkillType skill,
            String taskType,
            String promptText,
            String responseText,
            String mediaUrl,
            String audioBase64,
            Map<String, Object> rubricCriteria,
            Map<String, Object> calibrationMeta,
            String snapshotHash,
            List<SpeakingTurnEvidenceDto> turns,
            String rubricVersion,
            String providerVersion,
            String requestHash
    ) {
        // Backwards-compatible constructor for existing callers
        public AiScoringRequest(
                String stageKey,
                ExamFamily family,
                SkillType skill,
                String taskType,
                String promptText,
                String responseText,
                String mediaUrl,
                String audioBase64,
                Map<String, Object> rubricCriteria,
                Map<String, Object> calibrationMeta
        ) {
            this(stageKey, family, skill, taskType, promptText, responseText, mediaUrl, audioBase64,
                    rubricCriteria, calibrationMeta, null, null, null, null, null);
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CriterionScoreDto(
            String criterion,
            Double score,
            String feedback,
            List<String> evidence
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record AiScoringResponse(
            String stageKey,
            boolean success,
            Double overallBand,
            List<CriterionScoreDto> criteria,
            Map<String, Object> turnDiagnostics,
            String evidenceHash,
            String outputHash,
            Map<String, Object> telemetry,
            String reviewerNotes,
            boolean reviewRequired,
            Map<String, Object> abstention,
            String errorMessage
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record EvidenceValidationRequest(
            String family,
            String skill,
            String snapshotHash,
            List<SpeakingTurnEvidenceDto> turns
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record EvidenceValidationResponse(
            boolean valid,
            String evidenceHash,
            int turnCount,
            List<String> partsPresent,
            boolean hasAcousticEvidence,
            boolean pronunciationAbstentionRequired,
            String abstentionReason
    ) {}

    public static class ExamAiException extends RuntimeException {
        private final boolean retryable;

        public ExamAiException(String message, boolean retryable, Throwable cause) {
            super(message, cause);
            this.retryable = retryable;
        }

        public boolean isRetryable() {
            return retryable;
        }
    }

    /**
     * Call the dedicated FastAPI Exams AI judge endpoint.
     */
    public AiScoringResponse evaluateProductiveStage(AiScoringRequest request) {
        String endpoint = properties.getAi().getUrl() + "/api/v1/exams/score";

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        if (properties.getAi().getApiKey() != null && !properties.getAi().getApiKey().isBlank()) {
            headers.setBearerAuth(properties.getAi().getApiKey());
        }

        try {
            byte[] bytes = objectMapper.writeValueAsBytes(request);
            headers.setContentLength(bytes.length);
            HttpEntity<byte[]> entity = new HttpEntity<>(bytes, headers);

            log.info("Sending AI scoring request to {} for stage {} family {} (payload length: {})", endpoint, request.stageKey(), request.family(), bytes.length);
            ResponseEntity<AiScoringResponse> response = restTemplate.postForEntity(endpoint, entity, AiScoringResponse.class);

            if (response.getStatusCode().is2xxSuccessful() && response.getBody() != null) {
                return response.getBody();
            }

            throw new ExamAiException("Empty or non-200 AI scoring response: " + response.getStatusCode(), true, null);
        } catch (ResourceAccessException e) {
            log.error("AI service connection failed at {}: {}", endpoint, e.getMessage());
            throw new ExamAiException("AI service connection failed: " + e.getMessage(), true, e);
        } catch (RestClientResponseException e) {
            boolean is5xx = e.getStatusCode().is5xxServerError();
            // Exams Phase 9: never log the body (it may echo learner responses / transcripts) — status + size only
            log.error("AI service HTTP error {} at {} (body length {})", e.getStatusCode(), endpoint,
                    e.getResponseBodyAsString() == null ? 0 : e.getResponseBodyAsString().length());
            throw new ExamAiException("AI service returned " + e.getStatusCode() + ": " + e.getResponseBodyAsString(), is5xx, e);
        } catch (Exception e) {
            log.error("Unexpected error during AI scoring at {}: {}", endpoint, e.getMessage());
            throw new ExamAiException("AI scoring execution failed: " + e.getMessage(), false, e);
        }
    }

    /**
     * Validate turn evidence contract without triggering scoring.
     */
    public EvidenceValidationResponse validateEvidenceContract(EvidenceValidationRequest request) {
        String endpoint = properties.getAi().getUrl() + "/api/v1/exams/validate-evidence";

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        if (properties.getAi().getApiKey() != null && !properties.getAi().getApiKey().isBlank()) {
            headers.setBearerAuth(properties.getAi().getApiKey());
        }

        try {
            byte[] bytes = objectMapper.writeValueAsBytes(request);
            headers.setContentLength(bytes.length);
            HttpEntity<byte[]> entity = new HttpEntity<>(bytes, headers);

            ResponseEntity<EvidenceValidationResponse> response = restTemplate.postForEntity(endpoint, entity, EvidenceValidationResponse.class);
            if (response.getStatusCode().is2xxSuccessful() && response.getBody() != null) {
                return response.getBody();
            }
            throw new ExamAiException("Empty or non-200 AI validate response: " + response.getStatusCode(), true, null);
        } catch (Exception e) {
            log.error("Evidence validation error at {}: {}", endpoint, e.getMessage());
            throw new ExamAiException("AI evidence validation failed: " + e.getMessage(), false, e);
        }
    }
}
