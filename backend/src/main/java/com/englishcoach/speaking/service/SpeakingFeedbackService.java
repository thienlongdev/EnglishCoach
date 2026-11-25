package com.englishcoach.speaking.service;

import com.englishcoach.speaking.dto.SpeakingContextDto;
import com.englishcoach.speaking.dto.SpeakingTurnFeedbackDto;
import com.englishcoach.speaking.dto.TurnCorrectionDto;
import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.entity.SpeakingTurnFeedback;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.util.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingFeedbackService {

    private final SpeakingSessionRepository speakingSessionRepository;
    private final SpeakingTurnRepository speakingTurnRepository;
    private final SpeakingTurnFeedbackRepository speakingTurnFeedbackRepository;
    private final SpeakingContextService speakingContextService;

    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private <T> T inTx(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get();
        return new TransactionTemplate(transactionManager).execute(s -> work.get());
    }

    private <T> T inReadTx(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get();
        TransactionTemplate tpl = new TransactionTemplate(transactionManager);
        tpl.setReadOnly(true);
        return tpl.execute(s -> work.get());
    }

    private record FeedbackContext(
            String learnerTranscript,
            boolean turnMocked,
            String scenarioTitle,
            String cefrLevel,
            String aiRole,
            String learnerRole,
            String learnerGoal,
            List<String> targetVocabulary
    ) {}

    private record FeedbackPhase1(
            SpeakingTurnFeedbackDto cached,
            FeedbackContext context
    ) {}

    @Value("${ai.base-url:http://localhost:8000}")
    private String aiBaseUrl;

    @Value("${ai.timeout.connect:10000}")
    private int connectTimeoutMs;

    @Value("${ai.timeout.read:45000}")
    private int readTimeoutMs;

    private RestTemplate createRestTemplateWithTimeout() {
        SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
        factory.setConnectTimeout(connectTimeoutMs);
        factory.setReadTimeout(readTimeoutMs);
        return new RestTemplate(factory);
    }

    public SpeakingTurnFeedbackDto getOrGenerateFeedback(Long userId, Long sessionId, Long turnId) {
        // Phase 1 (short read TX): verify session/turn ownership, check cache, and materialize context
        FeedbackPhase1 phase1 = inReadTx(() -> {
            SpeakingSession session = speakingSessionRepository.findById(sessionId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

            if (!session.getUser().getId().equals(userId)) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Unauthorized access to speaking session");
            }

            SpeakingTurn turn = speakingTurnRepository.findById(turnId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking turn not found: " + turnId));

            if (!turn.getSession().getId().equals(sessionId)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Turn does not belong to session: " + sessionId);
            }

            if (!"LEARNER".equalsIgnoreCase(turn.getSpeaker())) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Feedback can only be generated for LEARNER turns");
            }

            // Idempotency check: return cached feedback if already evaluated
            Optional<SpeakingTurnFeedback> existingOpt = speakingTurnFeedbackRepository.findByTurnId(turnId);
            if (existingOpt.isPresent()) {
                log.info("Idempotent feedback lookup for turnId={}", turnId);
                return new FeedbackPhase1(SpeakingTurnFeedbackDto.fromEntity(existingOpt.get()), null);
            }

            SpeakingScenario scenario = session.getScenario();
            String scenarioTitle = (scenario != null) ? scenario.getTitle() : "Conversation Practice";
            String cefrLevel = (scenario != null && scenario.getCefrLevel() != null) ? scenario.getCefrLevel().name() : "B1";
            String aiRole = (scenario != null && scenario.getAiRole() != null) ? scenario.getAiRole() : "Partner";
            String learnerRole = (scenario != null && scenario.getLearnerRole() != null) ? scenario.getLearnerRole() : "Learner";
            String learnerGoal = (scenario != null && scenario.getLearnerGoal() != null) ? scenario.getLearnerGoal() : "Communication";

            Set<String> targetVocabSet = new LinkedHashSet<>();
            if (scenario != null && scenario.getTargetVocabulary() != null) {
                scenario.getTargetVocabulary().stream().filter(Objects::nonNull).forEach(targetVocabSet::add);
            }

            if (session.getSourceType() != null && session.getSourceId() != null) {
                try {
                    SpeakingContextDto inheritedContext = speakingContextService.resolveContext(
                            session.getSourceType(),
                            session.getSourceId(),
                            userId
                    );
                    if (inheritedContext.targetVocabulary() != null) {
                        inheritedContext.targetVocabulary().stream().filter(Objects::nonNull).forEach(targetVocabSet::add);
                    }
                } catch (Exception e) {
                    log.warn("Failed to resolve inherited context for feedback generation: {}", e.getMessage());
                }
            }

            FeedbackContext ctx = new FeedbackContext(
                    turn.getText(),
                    Boolean.TRUE.equals(turn.getIsMocked()),
                    scenarioTitle,
                    cefrLevel,
                    aiRole,
                    learnerRole,
                    learnerGoal,
                    List.copyOf(targetVocabSet)
            );
            return new FeedbackPhase1(null, ctx);
        });

        if (phase1.cached() != null) {
            return phase1.cached();
        }
        FeedbackContext ctx = phase1.context();

        // HTTP Phase (OUTSIDE any DB transaction — zero Hikari connection held during AI wait)
        String targetUrl = aiBaseUrl + "/api/v1/speaking/roleplay/feedback";
        Map<String, Object> requestPayload = Map.of(
                "learner_transcript", ctx.learnerTranscript(),
                "scenario_title", ctx.scenarioTitle(),
                "cefr_level", ctx.cefrLevel(),
                "ai_role", ctx.aiRole(),
                "learner_role", ctx.learnerRole(),
                "learner_goal", ctx.learnerGoal(),
                "target_vocabulary", ctx.targetVocabulary()
        );

        String summary = "Giao tiếp trôi chảy và đúng ngữ cảnh.";
        String positiveFeedback = "Phát huy tốt sự tự tin khi nói.";
        String correctionsJson = "[]";
        boolean isMocked = ctx.turnMocked();

        try {
            RestTemplate restTemplate = createRestTemplateWithTimeout();
            ResponseEntity<Map> aiResponse = restTemplate.postForEntity(targetUrl, requestPayload, Map.class);
            Map responseBody = aiResponse.getBody();
            if (responseBody != null) {
                if (responseBody.get("summary") != null) {
                    summary = String.valueOf(responseBody.get("summary"));
                }
                if (responseBody.get("positive_feedback") != null) {
                    positiveFeedback = String.valueOf(responseBody.get("positive_feedback"));
                }
                if (responseBody.get("corrections") instanceof List correctionsList) {
                    correctionsJson = MAPPER.writeValueAsString(correctionsList);
                }
                if (Boolean.TRUE.equals(responseBody.get("is_mocked"))) {
                    isMocked = true;
                }
            }
        } catch (Exception e) {
            log.error("Feedback generation failed at {}: {}. Falling back to default note.", targetUrl, e.getMessage());
            summary = "Giao tiếp rõ ràng, tiếp tục duy trì phản xạ.";
            positiveFeedback = "Bạn đã hoàn thành lượt nói thành công.";
            isMocked = true;
        }

        final String finalSummary = summary;
        final String finalPositive = positiveFeedback;
        final String finalCorrectionsJson = correctionsJson;
        final boolean finalIsMocked = isMocked;

        // Phase 2 (short write TX): persist feedback atomically with concurrent replay handling
        try {
            return inTx(() -> {
                Optional<SpeakingTurnFeedback> concurrent = speakingTurnFeedbackRepository.findByTurnId(turnId);
                if (concurrent.isPresent()) {
                    return SpeakingTurnFeedbackDto.fromEntity(concurrent.get());
                }
                SpeakingTurn turn = speakingTurnRepository.findById(turnId)
                        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking turn not found: " + turnId));
                SpeakingTurnFeedback feedback = SpeakingTurnFeedback.builder()
                        .turn(turn)
                        .summary(finalSummary)
                        .positiveFeedback(finalPositive)
                        .correctionsJson(finalCorrectionsJson)
                        .isMocked(finalIsMocked)
                        .build();
                SpeakingTurnFeedback saved = speakingTurnFeedbackRepository.save(feedback);
                return SpeakingTurnFeedbackDto.fromEntity(saved);
            });
        } catch (DataIntegrityViolationException dive) {
            log.warn("Concurrent feedback insert detected for turnId={}: {}", turnId, dive.getMessage());
            return inReadTx(() -> speakingTurnFeedbackRepository.findByTurnId(turnId)
                    .map(SpeakingTurnFeedbackDto::fromEntity)
                    .orElseThrow(() -> dive));
        }
    }
}
