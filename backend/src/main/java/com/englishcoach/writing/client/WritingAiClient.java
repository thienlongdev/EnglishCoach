package com.englishcoach.writing.client;

import com.englishcoach.writing.dto.DimensionVerdictDto;
import com.englishcoach.writing.dto.SentenceAnalysisAiResponse;
import com.englishcoach.writing.enums.DimensionStatus;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.util.*;

@Slf4j
@Component
public class WritingAiClient {

    private final String aiBaseUrl;
    private final RestTemplate restTemplate;
    private final String sentenceLabModel;
    private final String sentenceLabFallbackModel;

    public WritingAiClient(
            @Value("${ai.base-url:${ai.service.url:http://localhost:8000}}") String aiBaseUrl,
            @Value("${ai.timeout.connect:10000}") int connectTimeout,
            @Value("${ai.timeout.read:120000}") int readTimeout,
            @Value("${app.writing.sentence-lab-model:openai/gpt-5.6-luna}") String sentenceLabModel,
            @Value("${app.writing.sentence-lab-fallback-model:deepseek/deepseek-v3.2}") String sentenceLabFallbackModel
    ) {
        this.aiBaseUrl = aiBaseUrl.replaceAll("/+$", "");
        this.sentenceLabModel = sentenceLabModel;
        this.sentenceLabFallbackModel = sentenceLabFallbackModel;
        SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
        factory.setConnectTimeout(connectTimeout);
        factory.setReadTimeout(readTimeout);
        this.restTemplate = new RestTemplate(factory);
    }

    @Value("${app.writing.translation-paragraph-model:openai/gpt-5.6-luna}")
    private String translationParagraphModel = "openai/gpt-5.6-luna";

    @Value("${app.writing.translation-paragraph-fallback-model:deepseek/deepseek-v3.2}")
    private String translationParagraphFallbackModel = "deepseek/deepseek-v3.2";

    public String getSentenceLabModel() {
        return sentenceLabModel;
    }

    public String getSentenceLabFallbackModel() {
        return sentenceLabFallbackModel;
    }

    public String getTranslationParagraphModel() {
        return translationParagraphModel;
    }

    public String getTranslationParagraphFallbackModel() {
        return translationParagraphFallbackModel;
    }

    public SentenceAnalysisAiResponse analyzeSentence(String text, String targetRegister, String contextNote) {
        String endpoint = aiBaseUrl + "/api/v1/writing/sentence-check";

        Map<String, Object> requestBody = new HashMap<>();
        requestBody.put("text", text);
        requestBody.put("target_register", targetRegister != null ? targetRegister : "formal");
        if (contextNote != null && !contextNote.isBlank()) {
            requestBody.put("context_note", contextNote);
        }
        if (sentenceLabModel != null && !sentenceLabModel.isBlank()) {
            requestBody.put("model", sentenceLabModel);
        }
        if (sentenceLabFallbackModel != null && !sentenceLabFallbackModel.isBlank()) {
            requestBody.put("fallback_model", sentenceLabFallbackModel);
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, Object>> requestEntity = new HttpEntity<>(requestBody, headers);

        try {
            log.info("Calling AI Service Sentence Check at {}", endpoint);
            ResponseEntity<SentenceAnalysisAiResponse> response = restTemplate.postForEntity(
                    endpoint,
                    requestEntity,
                    SentenceAnalysisAiResponse.class
            );

            if (response.getStatusCode().is2xxSuccessful() && response.getBody() != null) {
                return response.getBody();
            }
            log.warn("AI Service returned unexpected status: {}", response.getStatusCode());
        } catch (Exception ex) {
            log.error("Failed to call AI Service at {}: {}", endpoint, ex.getMessage());
        }

        // Safe deterministic fallback when AI Service is unreachable
        return buildSafeFallback(text);
    }

    private SentenceAnalysisAiResponse buildSafeFallback(String text) {
        List<DimensionVerdictDto> verdicts = new ArrayList<>();
        verdicts.add(DimensionVerdictDto.builder()
                .dimension("Grammar")
                .status(DimensionStatus.UNAVAILABLE)
                .summary("Grammar analysis is temporarily unavailable. Detailed grammar verification could not be completed.")
                .score(null)
                .build());
        verdicts.add(DimensionVerdictDto.builder()
                .dimension("Naturalness")
                .status(DimensionStatus.UNCERTAIN)
                .summary("Naturalness analysis is currently inconclusive.")
                .score(null)
                .build());

        return SentenceAnalysisAiResponse.builder()
                .grammaticallyCorrect(null)
                .analysisStatus("ANALYSIS_UNAVAILABLE")
                .dimensionVerdicts(verdicts)
                .issues(Collections.emptyList())
                .explanation("AI analysis is temporarily unavailable or inconclusive. Your input text remains safely preserved.")
                .build();
    }

    public com.englishcoach.writing.dto.PlanOrganizationResultDto organizePlan(String taskPrompt, List<String> learnerIdeas) {
        String endpoint = aiBaseUrl + "/api/v1/writing/plan-organize";
        Map<String, Object> body = new HashMap<>();
        body.put("task_prompt", taskPrompt);
        body.put("learner_ideas", learnerIdeas != null ? learnerIdeas : Collections.emptyList());

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);

        try {
            log.info("Calling AI Service Plan Organize at {}", endpoint);
            ResponseEntity<com.englishcoach.writing.dto.PlanOrganizationResultDto> resp = restTemplate.postForEntity(
                    endpoint, entity, com.englishcoach.writing.dto.PlanOrganizationResultDto.class
            );
            if (resp.getStatusCode().is2xxSuccessful() && resp.getBody() != null) {
                return resp.getBody();
            }
            log.error("AI Service Plan Organize returned non-2xx status {} at {}", resp.getStatusCode(), endpoint);
        } catch (Exception ex) {
            log.error("Failed to call AI Service Plan Organize at {}: {}", endpoint, ex.getMessage());
            throw new com.englishcoach.writing.exception.WritingAiServiceException(
                    "AI Service Plan Organize failed: " + ex.getMessage(), ex
            );
        }

        throw new com.englishcoach.writing.exception.WritingAiServiceException(
                "AI Service Plan Organize failed: received empty or non-2xx response from " + endpoint
        );
    }

    public com.englishcoach.writing.dto.DocumentAnalysisAiResponse analyzeDocument(
            String taskPrompt,
            String taskCategory,
            String taskGuidance,
            String learnerPlan,
            String draftContent,
            int draftOrdinal
    ) {
        String endpoint = aiBaseUrl + "/api/v1/writing/document-assessment";
        Map<String, Object> body = new HashMap<>();
        body.put("task_prompt", taskPrompt);
        body.put("task_category", taskCategory != null ? taskCategory : "Everyday");
        body.put("task_guidance", taskGuidance);
        body.put("learner_plan", learnerPlan);
        body.put("draft_content", draftContent);
        body.put("draft_ordinal", draftOrdinal);
        body.put("model", "openai/gpt-5.6-luna");
        body.put("fallback_model", "deepseek/deepseek-v3.2");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);

        try {
            log.info("Calling AI Service Document Assessment at {}", endpoint);
            ResponseEntity<com.englishcoach.writing.dto.DocumentAnalysisAiResponse> resp = restTemplate.postForEntity(
                    endpoint, entity, com.englishcoach.writing.dto.DocumentAnalysisAiResponse.class
            );
            if (resp.getStatusCode().is2xxSuccessful() && resp.getBody() != null) {
                return resp.getBody();
            }
            log.error("AI Service Document Assessment returned non-2xx status {} at {}", resp.getStatusCode(), endpoint);
        } catch (Exception ex) {
            log.error("Failed to call AI Service Document Assessment at {}: {}", endpoint, ex.getMessage());
            throw new com.englishcoach.writing.exception.WritingAiServiceException(
                    "AI Service Document Assessment failed: " + ex.getMessage(), ex
            );
        }

        throw new com.englishcoach.writing.exception.WritingAiServiceException(
                "AI Service Document Assessment failed: received empty or non-2xx response from " + endpoint
        );
    }

    public com.englishcoach.writing.dto.AdaptiveTaskAiResponse generateAdaptiveTask(
            String cefrLevel,
            List<String> focusPatternCodes,
            String preferredCategory,
            String preferredRegister
    ) {
        String endpoint = aiBaseUrl + "/api/v1/writing/task-generate";
        Map<String, Object> body = new HashMap<>();
        body.put("learner_cefr_level", cefrLevel != null ? cefrLevel : "B1");
        body.put("focus_pattern_codes", focusPatternCodes != null ? focusPatternCodes : Collections.emptyList());
        body.put("preferred_category", preferredCategory != null ? preferredCategory : "Work");
        body.put("preferred_register", preferredRegister != null ? preferredRegister : "formal");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);

        try {
            log.info("Calling AI Service Adaptive Task Generation at {}", endpoint);
            ResponseEntity<com.englishcoach.writing.dto.AdaptiveTaskAiResponse> resp = restTemplate.postForEntity(
                    endpoint, entity, com.englishcoach.writing.dto.AdaptiveTaskAiResponse.class
            );
            if (resp.getStatusCode().is2xxSuccessful() && resp.getBody() != null) {
                return resp.getBody();
            }
        } catch (Exception ex) {
            log.error("Failed to call AI Service Adaptive Task Generation at {}: {}", endpoint, ex.getMessage());
        }

        return com.englishcoach.writing.dto.AdaptiveTaskAiResponse.builder()
                .title("Adaptive Writing Challenge: Workplace Communication")
                .prompt("Write a professional status update email to your project lead outlining key milestones achieved and planned next steps.")
                .guidance("Use clear paragraph structure, polite opening and closing greetings, and precise action points.")
                .audience("Project Lead / Supervisor")
                .targetRegister(preferredRegister != null ? preferredRegister : "formal")
                .targetWordCountMin(120)
                .targetWordCountMax(200)
                .requirements(List.of("Detail at least 2 completed milestones.", "Describe current priorities.", "Conclude with an offer for follow-up questions."))
                .elicitedPatterns(focusPatternCodes != null ? focusPatternCodes : List.of("TASK_RESPONSE", "COHESION"))
                .build();
    }

    public com.englishcoach.writing.dto.SocraticPlanAiResponse getSocraticGuidance(
            String taskPrompt,
            String currentPlan,
            String learnerQuestion
    ) {
        String endpoint = aiBaseUrl + "/api/v1/writing/socratic-plan";
        Map<String, Object> body = new HashMap<>();
        body.put("task_prompt", taskPrompt);
        body.put("current_plan", currentPlan);
        body.put("learner_question", learnerQuestion);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);

        try {
            log.info("Calling AI Service Socratic Guidance at {}", endpoint);
            ResponseEntity<com.englishcoach.writing.dto.SocraticPlanAiResponse> resp = restTemplate.postForEntity(
                    endpoint, entity, com.englishcoach.writing.dto.SocraticPlanAiResponse.class
            );
            if (resp.getStatusCode().is2xxSuccessful() && resp.getBody() != null) {
                return resp.getBody();
            }
            log.error("AI Service Socratic Guidance returned non-2xx status {} at {}", resp.getStatusCode(), endpoint);
        } catch (Exception ex) {
            log.error("Failed to call AI Service Socratic Guidance at {}: {}", endpoint, ex.getMessage());
            throw new com.englishcoach.writing.exception.WritingAiServiceException(
                    "AI Service Socratic Guidance failed: " + ex.getMessage(), ex
            );
        }

        throw new com.englishcoach.writing.exception.WritingAiServiceException(
                "AI Service Socratic Guidance failed: received empty or non-2xx response from " + endpoint
        );
    }


    public com.englishcoach.writing.dto.ModelAnswerComparisonAiResponse compareModelAnswer(
            String taskPrompt,
            String learnerDraft,
            String targetRegister
    ) {
        return compareModelAnswer(taskPrompt, learnerDraft, targetRegister, "B1");
    }

    public com.englishcoach.writing.dto.ModelAnswerComparisonAiResponse compareModelAnswer(
            String taskPrompt,
            String learnerDraft,
            String targetRegister,
            String learnerLevel
    ) {
        String endpoint = aiBaseUrl + "/api/v1/writing/compare-model";
        Map<String, Object> body = new HashMap<>();
        body.put("task_prompt", taskPrompt);
        body.put("learner_draft", learnerDraft);
        body.put("target_register", targetRegister != null ? targetRegister : "formal");
        body.put("learner_level", learnerLevel != null ? learnerLevel : "B1");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(body, headers);

        try {
            log.info("Calling AI Service Model Answer Comparison at {}", endpoint);
            ResponseEntity<com.englishcoach.writing.dto.ModelAnswerComparisonAiResponse> resp = restTemplate.postForEntity(
                    endpoint, entity, com.englishcoach.writing.dto.ModelAnswerComparisonAiResponse.class
            );
            if (resp.getStatusCode().is2xxSuccessful() && resp.getBody() != null) {
                return resp.getBody();
            }
        } catch (Exception ex) {
            log.error("Failed to call AI Service Model Answer Comparison at {}: {}", endpoint, ex.getMessage());
        }

        throw new com.englishcoach.writing.exception.WritingAiServiceException(
                "Không thể tạo bài viết mẫu lúc này. Vui lòng thử lại.");
    }

    public com.englishcoach.writing.translation.dto.TranslationGradeAiResponse gradeTranslation(
            com.englishcoach.writing.translation.dto.TranslationGradeAiRequest request
    ) {
        String endpoint = aiBaseUrl + "/api/v1/writing/translation-grade";
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<com.englishcoach.writing.translation.dto.TranslationGradeAiRequest> entity = new HttpEntity<>(request, headers);

        try {
            log.info("Calling AI Service Translation Grade at {}", endpoint);
            ResponseEntity<com.englishcoach.writing.translation.dto.TranslationGradeAiResponse> resp = restTemplate.postForEntity(
                    endpoint, entity, com.englishcoach.writing.translation.dto.TranslationGradeAiResponse.class
            );
            if (resp.getStatusCode().is2xxSuccessful() && resp.getBody() != null) {
                return resp.getBody();
            }
            log.warn("AI Service Translation Grade returned non-2xx status: {}", resp.getStatusCode());
        } catch (Exception ex) {
            log.error("Failed to call AI Service Translation Grade at {}: {}", endpoint, ex.getMessage());
        }

        return com.englishcoach.writing.translation.dto.TranslationGradeAiResponse.builder()
                .meaningVerdict("UNCERTAIN")
                .grammarVerdict("UNCERTAIN")
                .naturalnessVerdict("UNCERTAIN")
                .overallStatus("UNCERTAIN")
                .accepted(null)
                .headlineSummary("Hệ thống chấm AI tạm thời gián đoạn. Bài làm của bạn đã được ghi nhận an toàn.")
                .issues(Collections.emptyList())
                .build();
    }

    public com.englishcoach.writing.translation.paragraph.dto.ParagraphGradeAiResponse gradeParagraphTranslation(
            com.englishcoach.writing.translation.paragraph.dto.ParagraphGradeAiRequest request
    ) {
        String endpoint = aiBaseUrl + "/api/v1/writing/translation-paragraph-grade";
        if (request.getModel() == null || request.getModel().isBlank()) {
            request.setModel(translationParagraphModel);
        }
        if (request.getFallbackModel() == null || request.getFallbackModel().isBlank()) {
            request.setFallbackModel(translationParagraphFallbackModel);
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<com.englishcoach.writing.translation.paragraph.dto.ParagraphGradeAiRequest> entity = new HttpEntity<>(request, headers);

        try {
            log.info("Calling AI Service Translation Paragraph Grade at {}", endpoint);
            ResponseEntity<com.englishcoach.writing.translation.paragraph.dto.ParagraphGradeAiResponse> resp = restTemplate.postForEntity(
                    endpoint, entity, com.englishcoach.writing.translation.paragraph.dto.ParagraphGradeAiResponse.class
            );
            if (resp.getStatusCode().is2xxSuccessful() && resp.getBody() != null) {
                return resp.getBody();
            }
            log.warn("AI Service Translation Paragraph Grade returned non-2xx status: {}", resp.getStatusCode());
        } catch (Exception ex) {
            log.error("Failed to call AI Service Translation Paragraph Grade at {}: {}", endpoint, ex.getMessage());
        }

        return com.englishcoach.writing.translation.paragraph.dto.ParagraphGradeAiResponse.builder()
                .evaluationStatus("UNCERTAIN")
                .accepted(null)
                .overallSummary("Hệ thống chấm AI tạm thời gián đoạn. Bài làm của bạn đã được ghi nhận an toàn.")
                .meaningVerdict("UNCERTAIN")
                .grammarVerdict("UNCERTAIN")
                .naturalnessVerdict("UNCERTAIN")
                .vocabularyVerdict("UNCERTAIN")
                .cohesionVerdict("UNCERTAIN")
                .issues(Collections.emptyList())
                .generationCount(0)
                .build();
    }
}

