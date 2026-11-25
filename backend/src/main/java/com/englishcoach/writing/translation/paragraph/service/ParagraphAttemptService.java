package com.englishcoach.writing.translation.paragraph.service;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.translation.paragraph.dto.*;
import com.englishcoach.writing.translation.paragraph.entity.*;
import com.englishcoach.writing.translation.paragraph.repository.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.EntityNotFoundException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class ParagraphAttemptService {

    private final TranslationParagraphSessionRepository sessionRepository;
    private final TranslationParagraphSessionItemRepository itemRepository;
    private final TranslationParagraphAttemptRepository attemptRepository;
    private final ParagraphDeterministicGrader deterministicGrader;
    private final ParagraphGradeCacheService cacheService;
    private final ParagraphSingleFlightCoordinator singleFlightCoordinator;
    private final WritingAiClient writingAiClient;
    private final ObjectMapper objectMapper;

    @Transactional
    public ParagraphAttemptResponse processAttempt(Long userId, UUID sessionId, ParagraphAttemptRequest request) {
        // 1. Ownership & session existence check
        TranslationParagraphSessionEntity session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new EntityNotFoundException("Session not found: " + sessionId));

        if (!Objects.equals(session.getUserId(), userId)) {
            throw new AccessDeniedException("Access denied: session does not belong to user");
        }

        // 2. Idempotency: return existing attempt if clientMutationId was already processed
        Optional<TranslationParagraphAttemptEntity> existingAttempt = attemptRepository
                .findByUserIdAndClientMutationId(userId, request.getClientMutationId());
        if (existingAttempt.isPresent()) {
            log.info("Idempotent hit for user {} clientMutationId {}", userId, request.getClientMutationId());
            return mapToResponse(session, existingAttempt.get());
        }

        // 3. Locate session item
        TranslationParagraphSessionItemEntity item = itemRepository
                .findBySessionIdAndOrdinal(sessionId, request.getOrdinal())
                .orElseThrow(() -> new EntityNotFoundException("Session item not found at ordinal: " + request.getOrdinal()));

        TranslationParagraphPassageEntity passage = item.getPassage();

        // 4. Passage eligibility check
        String pubState = passage.getPublicationState();
        boolean validState = "APPROVED".equalsIgnoreCase(pubState) ||
                "STAGED".equalsIgnoreCase(pubState) ||
                "PUBLISHED".equalsIgnoreCase(pubState) ||
                "ELIGIBLE".equalsIgnoreCase(pubState);
        if (!Boolean.TRUE.equals(passage.getRightsEligible()) || !validState) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "Passage is no longer eligible or active for grading: " + passage.getId()
            );
        }

        String action = request.getAction().toUpperCase();
        Integer maxOrdinal = attemptRepository.findMaxAttemptOrdinalBySessionItemId(item.getId());
        int attemptOrdinal = (maxOrdinal != null ? maxOrdinal : 0) + 1;

        if ("CONTINUE".equals(action)) {
            return handleContinue(userId, session, item, passage, request, attemptOrdinal);
        } else if ("SKIP".equals(action)) {
            return handleSkip(userId, session, item, passage, request, attemptOrdinal);
        } else if ("REVISE".equals(action)) {
            return handleRevise(userId, session, item, passage, request, attemptOrdinal);
        } else if ("SUBMIT".equals(action)) {
            return handleSubmit(userId, session, item, passage, request, attemptOrdinal);
        } else {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported attempt action: " + action);
        }
    }

    private ParagraphAttemptResponse handleSubmit(
            Long userId,
            TranslationParagraphSessionEntity session,
            TranslationParagraphSessionItemEntity item,
            TranslationParagraphPassageEntity passage,
            ParagraphAttemptRequest request,
            int attemptOrdinal
    ) {
        String submittedText = request.getSubmittedText() != null ? request.getSubmittedText().trim() : "";
        if (submittedText.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Submitted text cannot be empty");
        }

        // Keep item draft in sync
        item.setDraftText(submittedText);

        String normalizedAnswer = deterministicGrader.normalize(submittedText);
        String normalizedAnswerHash = deterministicGrader.sha256(normalizedAnswer);

        // --- Step A: Deterministic exact match (0 AI calls) ---
        if (deterministicGrader.isExactOrVariantMatch(submittedText, passage.getReferenceEn())) {
            log.info("Deterministic exact match for session {} item {}. 0 AI calls.", session.getId(), item.getOrdinal());
            ParagraphFeedbackDto feedback = deterministicGrader.buildExactMatchFeedback(passage.getReferenceEn());
            return persistAndComplete(userId, session, item, passage, request, attemptOrdinal,
                    normalizedAnswerHash, "ACCEPTED", true, feedback, null, 0, "deterministic/exact-match");
        }

        // --- Step B: User-scoped Grade Cache check (0 AI calls) ---
        String cacheFingerprint = cacheService.computeFingerprint(
                userId,
                passage.getId(),
                passage.getContentVersion(),
                passage.getSourceHash(),
                passage.getReferenceHash(),
                normalizedAnswerHash,
                ParagraphDeterministicGrader.GRADER_VERSION,
                ParagraphDeterministicGrader.PROMPT_VERSION,
                passage.getGenre()
        );

        Optional<ParagraphFeedbackDto> cachedOpt = cacheService.getCachedFeedback(userId, cacheFingerprint);
        if (cachedOpt.isPresent()) {
            log.info("Cache hit for user {} passage {} fingerprint {}. 0 AI calls.", userId, passage.getId(), cacheFingerprint);
            ParagraphFeedbackDto feedback = cachedOpt.get();
            feedback.setReferenceEn(passage.getReferenceEn());
            String evalStatus = Boolean.TRUE.equals(feedback.getAccepted()) ? "ACCEPTED" : "NEEDS_REVISION";
            return persistAndComplete(userId, session, item, passage, request, attemptOrdinal,
                    normalizedAnswerHash, evalStatus, feedback.getAccepted(), feedback, cacheFingerprint, 0, feedback.getModelId());
        }

        // --- Step C: Single-Flight Coordination (Duplicate Submit Protection) ---
        String flightKey = deterministicGrader.sha256(userId + ":" + passage.getId() + ":" + normalizedAnswerHash);
        boolean isLeader = singleFlightCoordinator.tryAcquire(flightKey, userId, session.getId());

        if (!isLeader) {
            log.info("Follower request detected for flightKey {}. Awaiting leader result...", flightKey);
            // Poll for leader result from cache (up to 6 seconds)
            for (int i = 0; i < 12; i++) {
                try {
                    Thread.sleep(500);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
                Optional<ParagraphFeedbackDto> leaderResult = cacheService.getCachedFeedback(userId, cacheFingerprint);
                if (leaderResult.isPresent()) {
                    log.info("Follower retrieved leader result from cache for flightKey {}. 0 AI calls.", flightKey);
                    ParagraphFeedbackDto feedback = leaderResult.get();
                    feedback.setReferenceEn(passage.getReferenceEn());
                    String evalStatus = Boolean.TRUE.equals(feedback.getAccepted()) ? "ACCEPTED" : "NEEDS_REVISION";
                    return persistAndComplete(userId, session, item, passage, request, attemptOrdinal,
                            normalizedAnswerHash, evalStatus, feedback.getAccepted(), feedback, cacheFingerprint, 0, feedback.getModelId());
                }
            }
        }

        // --- Step D: Primary AI Generation (Exactly 1 generation) ---
        ParagraphFeedbackDto feedback;
        int genCount = 0;
        String modelId = null;
        try {
            ParagraphGradeAiRequest aiReq = ParagraphGradeAiRequest.builder()
                    .sourceVi(passage.getSourceVi())
                    .referenceEn(passage.getReferenceEn())
                    .submittedEn(submittedText)
                    .genre(passage.getGenre())
                    .topic(passage.getTopic())
                    .build();

            log.info("Executing whole-paragraph grading AI generation for passage {}", passage.getId());
            ParagraphGradeAiResponse aiResp = writingAiClient.gradeParagraphTranslation(aiReq);
            genCount = aiResp.getGenerationCount() != null ? aiResp.getGenerationCount() : 1;
            modelId = aiResp.getModelId();

            feedback = mapAiResponseToFeedback(aiResp, submittedText, passage.getReferenceEn());

            // Save into cache if result is not uncertain
            if (!"UNCERTAIN".equalsIgnoreCase(feedback.getEvaluationStatus())) {
                cacheService.saveCache(
                        userId,
                        passage.getId(),
                        passage.getContentVersion(),
                        cacheFingerprint,
                        passage.getSourceHash(),
                        passage.getReferenceHash(),
                        normalizedAnswerHash,
                        ParagraphDeterministicGrader.GRADER_VERSION,
                        ParagraphDeterministicGrader.PROMPT_VERSION,
                        feedback
                );
            }
        } finally {
            if (isLeader) {
                singleFlightCoordinator.release(flightKey);
            }
        }

        String evalStatus = feedback.getEvaluationStatus();
        Boolean accepted = feedback.getAccepted();

        return persistAndComplete(userId, session, item, passage, request, attemptOrdinal,
                normalizedAnswerHash, evalStatus, accepted, feedback, cacheFingerprint, genCount, modelId);
    }

    private ParagraphAttemptResponse handleRevise(
            Long userId,
            TranslationParagraphSessionEntity session,
            TranslationParagraphSessionItemEntity item,
            TranslationParagraphPassageEntity passage,
            ParagraphAttemptRequest request,
            int attemptOrdinal
    ) {
        item.setProgressState("IN_PROGRESS");
        itemRepository.save(item);

        ParagraphFeedbackDto feedback = ParagraphFeedbackDto.builder()
                .overallSummary("Đang chỉnh sửa bản dịch.")
                .evaluationStatus("PENDING")
                .accepted(null)
                .build();

        return persistAndComplete(userId, session, item, passage, request, attemptOrdinal,
                deterministicGrader.sha256(deterministicGrader.normalize(request.getSubmittedText())),
                "PENDING", null, feedback, null, 0, null);
    }

    private ParagraphAttemptResponse handleContinue(
            Long userId,
            TranslationParagraphSessionEntity session,
            TranslationParagraphSessionItemEntity item,
            TranslationParagraphPassageEntity passage,
            ParagraphAttemptRequest request,
            int attemptOrdinal
    ) {
        if (session.getCurrentIndex() + 1 < session.getTotalItems()) {
            session.setCurrentIndex(session.getCurrentIndex() + 1);
            session.setSessionRevision(session.getSessionRevision() + 1);
            sessionRepository.save(session);
        }

        ParagraphFeedbackDto feedback = ParagraphFeedbackDto.builder()
                .overallSummary("Tiếp tục sang đoạn tiếp theo.")
                .evaluationStatus("CONTINUED")
                .accepted(null)
                .build();

        return persistAndComplete(userId, session, item, passage, request, attemptOrdinal,
                "", "CONTINUED", null, feedback, null, 0, null);
    }

    private ParagraphAttemptResponse handleSkip(
            Long userId,
            TranslationParagraphSessionEntity session,
            TranslationParagraphSessionItemEntity item,
            TranslationParagraphPassageEntity passage,
            ParagraphAttemptRequest request,
            int attemptOrdinal
    ) {
        item.setProgressState("SKIPPED");
        itemRepository.save(item);

        if (Objects.equals(session.getCurrentIndex(), item.getOrdinal()) && session.getCurrentIndex() + 1 < session.getTotalItems()) {
            session.setCurrentIndex(session.getCurrentIndex() + 1);
            session.setSessionRevision(session.getSessionRevision() + 1);
            sessionRepository.save(session);
        }

        ParagraphFeedbackDto feedback = ParagraphFeedbackDto.builder()
                .overallSummary("Đã bỏ qua đoạn văn này.")
                .evaluationStatus("SKIPPED")
                .accepted(false)
                .build();

        return persistAndComplete(userId, session, item, passage, request, attemptOrdinal,
                "", "SKIPPED", false, feedback, null, 0, null);
    }

    private ParagraphAttemptResponse persistAndComplete(
            Long userId,
            TranslationParagraphSessionEntity session,
            TranslationParagraphSessionItemEntity item,
            TranslationParagraphPassageEntity passage,
            ParagraphAttemptRequest request,
            int attemptOrdinal,
            String normalizedAnswerHash,
            String evalStatus,
            Boolean accepted,
            ParagraphFeedbackDto feedback,
            String cacheFingerprint,
            int genCount,
            String modelId
    ) {
        String feedbackJson = "{}";
        try {
            feedbackJson = objectMapper.writeValueAsString(feedback);
        } catch (Exception e) {
            log.warn("Failed to serialize feedback snapshot: {}", e.getMessage());
        }

        TranslationParagraphAttemptEntity attempt = TranslationParagraphAttemptEntity.builder()
                .userId(userId)
                .sessionId(session.getId())
                .sessionItemId(item.getId())
                .passageId(passage.getId())
                .contentVersion(passage.getContentVersion())
                .attemptOrdinal(attemptOrdinal)
                .action(request.getAction().toUpperCase())
                .clientMutationId(request.getClientMutationId())
                .submittedText(request.getSubmittedText() != null ? request.getSubmittedText() : "")
                .normalizedAnswerHash(normalizedAnswerHash != null ? normalizedAnswerHash : "")
                .evaluationStatus(evalStatus)
                .graderVersion(ParagraphDeterministicGrader.GRADER_VERSION)
                .promptVersion(ParagraphDeterministicGrader.PROMPT_VERSION)
                .modelId(modelId)
                .accepted(accepted)
                .feedbackSnapshot(feedbackJson)
                .cacheFingerprint(cacheFingerprint)
                .generationCount(genCount)
                .build();

        TranslationParagraphAttemptEntity savedAttempt = attemptRepository.save(attempt);

        // Update session item progress state
        if ("ACCEPTED".equalsIgnoreCase(evalStatus)) {
            item.setProgressState("ACCEPTED");
        } else if ("NEEDS_REVISION".equalsIgnoreCase(evalStatus)) {
            item.setProgressState("NEEDS_REVISION");
        } else if ("UNCERTAIN".equalsIgnoreCase(evalStatus)) {
            // Keep in progress / uncertain so learner can retry
            if (!"ACCEPTED".equalsIgnoreCase(item.getProgressState())) {
                item.setProgressState("IN_PROGRESS");
            }
        }
        itemRepository.save(item);

        // Update session completion status: only if all items are ACCEPTED
        List<TranslationParagraphSessionItemEntity> allItems = itemRepository.findBySessionIdOrderByOrdinalAsc(session.getId());
        boolean allAccepted = !allItems.isEmpty() && allItems.stream().allMatch(it -> "ACCEPTED".equalsIgnoreCase(it.getProgressState()));
        if (allAccepted) {
            session.setStatus("COMPLETED");
        }
        session.setSessionRevision(session.getSessionRevision() + 1);
        sessionRepository.save(session);

        return mapToResponse(session, savedAttempt, feedback, item.getProgressState());
    }

    private ParagraphFeedbackDto mapAiResponseToFeedback(
            ParagraphGradeAiResponse aiResp,
            String learnerText,
            String referenceEn
    ) {
        List<ParagraphIssueDto> issues = new ArrayList<>();
        if (aiResp.getIssues() != null) {
            for (ParagraphGradeAiResponse.ParagraphIssueItemAiDto itemAi : aiResp.getIssues()) {
                Integer start = itemAi.getSpanStart();
                Integer end = itemAi.getSpanEnd();

                // Validate span offsets against real learner text
                if (start != null && end != null) {
                    if (start < 0 || end > learnerText.length() || start >= end) {
                        // Unlocatable offset: unanchor
                        start = null;
                        end = null;
                    }
                }

                issues.add(ParagraphIssueDto.builder()
                        .dimension(itemAi.getDimension())
                        .issueType(itemAi.getIssueType())
                        .severity(itemAi.getSeverity())
                        .learnerSpan(itemAi.getLearnerSpan())
                        .spanStart(start)
                        .spanEnd(end)
                        .message(itemAi.getMessage())
                        .suggestion(itemAi.getSuggestion())
                        .build());
            }
        }

        return ParagraphFeedbackDto.builder()
                .accepted(aiResp.getAccepted())
                .evaluationStatus(aiResp.getEvaluationStatus())
                .overallSummary(aiResp.getOverallSummary())
                .meaningVerdict(aiResp.getMeaningVerdict())
                .meaningScore(aiResp.getMeaningScore())
                .grammarVerdict(aiResp.getGrammarVerdict())
                .grammarScore(aiResp.getGrammarScore())
                .naturalnessVerdict(aiResp.getNaturalnessVerdict())
                .naturalnessScore(aiResp.getNaturalnessScore())
                .vocabularyVerdict(aiResp.getVocabularyVerdict())
                .vocabularyScore(aiResp.getVocabularyScore())
                .cohesionVerdict(aiResp.getCohesionVerdict())
                .cohesionScore(aiResp.getCohesionScore())
                .issues(issues)
                .suggestedCorrection(aiResp.getSuggestedCorrection())
                .naturalAlternative(aiResp.getNaturalAlternative())
                .referenceEn(referenceEn)
                .modelId(aiResp.getModelId())
                .generationCount(aiResp.getGenerationCount() != null ? aiResp.getGenerationCount() : 1)
                .cached(false)
                .latencyMs(aiResp.getLatencyMs())
                .build();
    }

    private ParagraphAttemptResponse mapToResponse(
            TranslationParagraphSessionEntity session,
            TranslationParagraphAttemptEntity attempt
    ) {
        ParagraphFeedbackDto feedback = null;
        if (attempt.getFeedbackSnapshot() != null) {
            try {
                feedback = objectMapper.readValue(attempt.getFeedbackSnapshot(), ParagraphFeedbackDto.class);
            } catch (Exception ignored) {
            }
        }
        TranslationParagraphSessionItemEntity item = itemRepository.findById(attempt.getSessionItemId()).orElse(null);
        String itemProgress = item != null ? item.getProgressState() : "NOT_STARTED";
        return mapToResponse(session, attempt, feedback, itemProgress);
    }

    private ParagraphAttemptResponse mapToResponse(
            TranslationParagraphSessionEntity session,
            TranslationParagraphAttemptEntity attempt,
            ParagraphFeedbackDto feedback,
            String itemProgressState
    ) {
        return ParagraphAttemptResponse.builder()
                .attemptId(attempt.getId())
                .sessionId(session.getId())
                .sessionItemId(attempt.getSessionItemId())
                .passageId(attempt.getPassageId())
                .ordinal(attempt.getAttemptOrdinal())
                .attemptOrdinal(attempt.getAttemptOrdinal())
                .action(attempt.getAction())
                .clientMutationId(attempt.getClientMutationId())
                .submittedText(attempt.getSubmittedText())
                .evaluationStatus(attempt.getEvaluationStatus())
                .accepted(attempt.getAccepted())
                .feedback(feedback)
                .sessionProgressState(session.getStatus())
                .itemProgressState(itemProgressState)
                .createdAt(attempt.getCreatedAt())
                .build();
    }

    @Transactional(readOnly = true)
    public List<ParagraphAttemptResponse> getAttemptsForItem(Long userId, UUID sessionId, UUID sessionItemId) {
        TranslationParagraphSessionEntity session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new EntityNotFoundException("Session not found: " + sessionId));

        if (!Objects.equals(session.getUserId(), userId)) {
            throw new AccessDeniedException("Access denied: session does not belong to user");
        }

        // AUTHZ-04: Verify sessionItemId actually belongs to the owned sessionId before reading its attempts
        TranslationParagraphSessionItemEntity item = itemRepository.findById(sessionItemId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Session item not found: " + sessionItemId));
        if (item.getSession() == null || !Objects.equals(item.getSession().getId(), sessionId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Session item not found in session: " + sessionItemId);
        }

        List<TranslationParagraphAttemptEntity> attempts = attemptRepository
                .findBySessionItemIdOrderByAttemptOrdinalDesc(sessionItemId);

        List<ParagraphAttemptResponse> resps = new ArrayList<>();
        for (TranslationParagraphAttemptEntity att : attempts) {
            if ((att.getUserId() != null && !Objects.equals(att.getUserId(), userId))
                    || (att.getSessionId() != null && !Objects.equals(att.getSessionId(), sessionId))) {
                continue;
            }
            resps.add(mapToResponse(session, att));
        }
        return resps;
    }
}
