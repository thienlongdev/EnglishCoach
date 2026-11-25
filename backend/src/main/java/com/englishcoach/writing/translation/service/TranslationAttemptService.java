package com.englishcoach.writing.translation.service;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.translation.dto.*;
import com.englishcoach.writing.translation.entity.*;
import com.englishcoach.writing.translation.repository.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class TranslationAttemptService {

    private final TranslationSessionRepository sessionRepository;
    private final TranslationSessionUnitRepository sessionUnitRepository;
    private final TranslationExerciseRepository exerciseRepository;
    private final TranslationExerciseUnitRepository exerciseUnitRepository;
    private final TranslationAttemptRepository attemptRepository;
    private final TranslationDeterministicGrader deterministicGrader;
    private final TranslationGradeCacheService gradeCacheService;
    private final WritingAiClient writingAiClient;
    private final PlatformTransactionManager transactionManager;
    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();

    private static final String GRADER_VERSION = "v1.1";

    /** The inputs of an AI grade, captured in the first transaction; the provider is called with no transaction open. */
    private record PendingGrade(TranslationGradeAiRequest request, short ordinal, String cacheFingerprint) {}

    /** Either a finished answer or the AI grade it still needs. */
    private record Step(TranslationAttemptResponse response, PendingGrade pending) {}

    /** A grade: the status / acceptance / feedback written to the attempt. */
    private record Evaluation(String status, Boolean accepted, TranslationFeedbackDto feedback, String cacheFingerprint) {}

    /**
     * Submit / revise / continue / skip one unit of the owner's session.
     * <p>
     * Performance release 2026-11-16 (PERF-02): the AI grade used to be awaited inside the transaction, holding a pooled
     * database connection for the whole provider call. Now a short transaction decides everything that needs no AI
     * (idempotent replay, CONTINUE / SKIP, the exact-match fast path, the grade cache) and writes it at once; only a
     * cache miss leaves that transaction WITHOUT writing, calls the provider with no transaction and no connection held
     * (the request path is excluded from open-session-in-view, {@code WritingRequestScopeConfig}), and then a second short
     * transaction re-locks the session, replays a duplicate {@code clientMutationId} committed meanwhile, refuses a
     * session that moved to another unit (409, nothing written), and writes the attempt exactly as before.
     */
    public TranslationAttemptResponse submitAttempt(Long userId, UUID sessionId, TranslationAttemptRequest request) {
        TransactionTemplate tx = new TransactionTemplate(transactionManager);
        Step first = tx.execute(status -> attemptWithoutAi(userId, sessionId, request));
        if (first.response() != null) {
            return first.response();
        }
        PendingGrade pending = first.pending();
        log.info("Cache miss. Calling AI service for session {} unit {}", sessionId, pending.ordinal());
        TranslationGradeAiResponse aiResp = writingAiClient.gradeTranslation(pending.request());
        return tx.execute(status -> completeWithAiGrade(userId, sessionId, request, pending, aiResp));
    }

    private Step attemptWithoutAi(Long userId, UUID sessionId, TranslationAttemptRequest request) {
        TranslationSessionEntity session = sessionRepository.findOwnedForUpdate(sessionId, userId)
                .orElseThrow(() -> new IllegalArgumentException("Session not found: " + sessionId));

        // Idempotency check via clientMutationId
        Optional<TranslationAttemptEntity> existingAttempt = attemptRepository.findByUserIdAndClientMutationId(userId, request.getClientMutationId());
        if (existingAttempt.isPresent()) {
            return new Step(buildAttemptResponse(existingAttempt.get(), session), null);
        }

        short currentOrdinal = session.getCurrentOrdinal();
        TranslationSessionUnitEntity sessionUnit = sessionUnitRepository.findBySessionIdAndUnitOrdinal(sessionId, currentOrdinal)
                .orElseThrow(() -> new IllegalStateException("Unit not found for ordinal: " + currentOrdinal));

        TranslationExerciseUnitEntity exerciseUnit = exerciseUnitRepository.findById(sessionUnit.getUnitId())
                .orElseThrow(() -> new IllegalStateException("Exercise unit missing: " + sessionUnit.getUnitId()));

        TranslationExerciseEntity exercise = exerciseRepository.findById(session.getExerciseId())
                .orElseThrow(() -> new IllegalStateException("Exercise missing: " + session.getExerciseId()));

        String action = request.getAction().toUpperCase();
        String answerText = request.getAnswerText() != null ? request.getAnswerText().trim() : "";
        String canonicalTokens = TranslationDeterministicGrader.canonicalTokenString(answerText);

        if ("CONTINUE".equals(action) || "SKIP".equals(action)) {
            return new Step(persistAttempt(userId, sessionId, request, session, sessionUnit, exerciseUnit, exercise, null), null);
        }

        // SUBMIT or REVISE
        // 1. Deterministic Fast Path
        Optional<TranslationFeedbackDto> exactMatch = deterministicGrader.evaluateExact(
                answerText, exerciseUnit.getReferenceEn(), exerciseUnit.getAcceptedVariantsJson()
        );
        if (exactMatch.isPresent()) {
            log.info("Deterministic exact match for session {} unit {}", sessionId, currentOrdinal);
            Evaluation exact = new Evaluation("ACCEPTED", Boolean.TRUE, exactMatch.get(), null);
            return new Step(persistAttempt(userId, sessionId, request, session, sessionUnit, exerciseUnit, exercise, exact), null);
        }

        // 2. Cache Lookup
        String cacheFingerprint = gradeCacheService.computeFingerprint(
                userId, session.getExerciseId(), sessionUnit.getUnitId(),
                exerciseUnit.getSourceVi(), exerciseUnit.getReferenceEn(),
                canonicalTokens, GRADER_VERSION
        );
        Optional<TranslationFeedbackDto> cached = gradeCacheService.getCachedResult(userId, cacheFingerprint);
        if (cached.isPresent()) {
            log.info("Cache hit for session {} unit {}", sessionId, currentOrdinal);
            TranslationFeedbackDto feedback = cached.get();
            String evaluationStatus = feedback.getOverallStatus();
            Boolean accepted;
            if ("ACCEPTED".equals(evaluationStatus)) {
                accepted = Boolean.TRUE;
            } else if ("NEEDS_REVISION".equals(evaluationStatus) || "INCORRECT".equals(evaluationStatus)) {
                accepted = Boolean.FALSE;
            } else {
                accepted = null;
            }
            Evaluation fromCache = new Evaluation(evaluationStatus, accepted, feedback, cacheFingerprint);
            return new Step(persistAttempt(userId, sessionId, request, session, sessionUnit, exerciseUnit, exercise, fromCache), null);
        }

        // 3. AI Service Call (Single generation) — outside this transaction; nothing is written here.
        List<Map<String, Object>> targetChunks = parseChunks(exerciseUnit.getTargetChunksJson());
        TranslationGradeAiRequest aiReq = TranslationGradeAiRequest.builder()
                .sourceVi(exerciseUnit.getSourceVi())
                .referenceEn(exerciseUnit.getReferenceEn())
                .submittedEn(answerText)
                .topicCode(exercise.getTopicCode())
                .difficultyBucket(exercise.getDifficultyBucket())
                .targetChunks(targetChunks)
                .model(writingAiClient.getSentenceLabModel())
                .fallbackModel(writingAiClient.getSentenceLabFallbackModel())
                .build();
        return new Step(null, new PendingGrade(aiReq, currentOrdinal, cacheFingerprint));
    }

    private TranslationAttemptResponse completeWithAiGrade(Long userId, UUID sessionId, TranslationAttemptRequest request,
                                                           PendingGrade pending, TranslationGradeAiResponse aiResp) {
        TranslationSessionEntity session = sessionRepository.findOwnedForUpdate(sessionId, userId)
                .orElseThrow(() -> new IllegalArgumentException("Session not found: " + sessionId));
        // The same mutation committed while the provider answered: return it, write nothing.
        Optional<TranslationAttemptEntity> existingAttempt = attemptRepository.findByUserIdAndClientMutationId(userId, request.getClientMutationId());
        if (existingAttempt.isPresent()) {
            return buildAttemptResponse(existingAttempt.get(), session);
        }
        if (session.getCurrentOrdinal() != pending.ordinal()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "TRANSLATION_SESSION_MOVED");
        }
        short currentOrdinal = pending.ordinal();
        TranslationSessionUnitEntity sessionUnit = sessionUnitRepository.findBySessionIdAndUnitOrdinal(sessionId, currentOrdinal)
                .orElseThrow(() -> new IllegalStateException("Unit not found for ordinal: " + currentOrdinal));
        TranslationExerciseUnitEntity exerciseUnit = exerciseUnitRepository.findById(sessionUnit.getUnitId())
                .orElseThrow(() -> new IllegalStateException("Exercise unit missing: " + sessionUnit.getUnitId()));
        TranslationExerciseEntity exercise = exerciseRepository.findById(session.getExerciseId())
                .orElseThrow(() -> new IllegalStateException("Exercise missing: " + session.getExerciseId()));
        return persistAttempt(userId, sessionId, request, session, sessionUnit, exerciseUnit, exercise,
                evaluateAiGrade(aiResp, pending.cacheFingerprint()));
    }

    private Evaluation evaluateAiGrade(TranslationGradeAiResponse aiResp, String cacheFingerprint) {
        Boolean accepted;
        List<TranslationIssueDto> issues = new ArrayList<>();
        if (aiResp.getIssues() != null) {
            for (TranslationIssueAiDto iss : aiResp.getIssues()) {
                issues.add(TranslationIssueDto.builder()
                        .offsetStart(iss.getOffsetStart())
                        .offsetEnd(iss.getOffsetEnd())
                        .flaggedText(iss.getFlaggedText())
                        .category(iss.getCategory())
                        .message(iss.getMessage())
                        .suggestion(iss.getSuggestion())
                        .build());
            }
        }

        TranslationFeedbackDto feedback = TranslationFeedbackDto.builder()
                .meaningVerdict(aiResp.getMeaningVerdict())
                .grammarVerdict(aiResp.getGrammarVerdict())
                .naturalnessVerdict(aiResp.getNaturalnessVerdict())
                .overallStatus(aiResp.getOverallStatus())
                .headlineSummary(aiResp.getHeadlineSummary())
                .naturalSuggestion(aiResp.getNaturalSuggestion())
                .issues(issues)
                .build();

        String evaluationStatus = aiResp.getOverallStatus();
        if ("ACCEPTED".equals(evaluationStatus) || Boolean.TRUE.equals(aiResp.getAccepted())) {
            evaluationStatus = "ACCEPTED";
            accepted = Boolean.TRUE;
        } else if ("NEEDS_REVISION".equals(evaluationStatus) || "INCORRECT".equals(evaluationStatus)) {
            // Check if the only issues are harmless stylistic suggestions or punctuation (meaning is ACCURATE and no grammar errors)
            boolean hasSubstantiveError = false;
            for (TranslationIssueDto issue : issues) {
                String cat = issue.getCategory() != null ? issue.getCategory().toUpperCase() : "";
                if ("GRAMMAR".equals(cat) || "MEANING".equals(cat)) {
                    hasSubstantiveError = true;
                    break;
                }
            }
            if (!hasSubstantiveError && "ACCURATE".equalsIgnoreCase(aiResp.getMeaningVerdict()) && !"INCORRECT".equalsIgnoreCase(aiResp.getGrammarVerdict())) {
                evaluationStatus = "ACCEPTED";
                accepted = Boolean.TRUE;
                feedback.setOverallStatus("ACCEPTED");
            } else {
                accepted = Boolean.FALSE;
            }
        } else {
            accepted = null; // UNCERTAIN per ck_translation_attempts_eval_state
        }
        return new Evaluation(evaluationStatus, accepted, feedback, cacheFingerprint);
    }

    /**
     * Writes one attempt and its effects on the unit and the session (unchanged rules). {@code evaluation} is null for
     * CONTINUE / SKIP. Runs inside a transaction that holds the session's row lock.
     */
    private TranslationAttemptResponse persistAttempt(Long userId, UUID sessionId, TranslationAttemptRequest request,
                                                      TranslationSessionEntity session, TranslationSessionUnitEntity sessionUnit,
                                                      TranslationExerciseUnitEntity exerciseUnit, TranslationExerciseEntity exercise,
                                                      Evaluation evaluation) {
        short currentOrdinal = session.getCurrentOrdinal();
        String action = request.getAction().toUpperCase();
        String answerText = request.getAnswerText() != null ? request.getAnswerText().trim() : "";
        String exactAnswerHash = TranslationGradeCacheService.sha256(answerText);
        String canonicalTokens = TranslationDeterministicGrader.canonicalTokenString(answerText);
        String answerCacheHash = TranslationGradeCacheService.sha256(canonicalTokens);

        long attemptCount = attemptRepository.countBySessionIdAndUnitOrdinal(sessionId, currentOrdinal);
        int nextAttemptOrdinal = (int) attemptCount + 1;

        Instant now = Instant.now();
        String evaluationStatus;
        Boolean accepted = null;
        TranslationFeedbackDto feedback = null;
        String cacheFingerprint = null;
        List<TranslationSessionUnitEntity> allUnits = sessionUnitRepository.findBySessionIdOrderByUnitOrdinalAsc(sessionId);

        if ("CONTINUE".equals(action)) {
            evaluationStatus = "CONTINUED";
            accepted = null;
            short nextOrd = (short) (currentOrdinal + 1);
            if (nextOrd > allUnits.size()) {
                Optional<TranslationSessionUnitEntity> firstUncompleted = allUnits.stream()
                        .filter(u -> !"ACCEPTED".equals(u.getTerminalStatus()))
                        .findFirst();
                nextOrd = firstUncompleted.map(TranslationSessionUnitEntity::getUnitOrdinal).orElse(currentOrdinal);
            }
            session.setCurrentOrdinal(nextOrd);

            boolean allUnitsAccepted = allUnits.stream().allMatch(u -> "ACCEPTED".equals(u.getTerminalStatus()));
            if (allUnitsAccepted) {
                session.setStatus("COMPLETED");
                session.setCompletedAt(now);
            }
        } else if ("SKIP".equals(action)) {
            evaluationStatus = "SKIPPED";
            accepted = null;
            sessionUnit.setTerminalStatus("SKIPPED");
            sessionUnit.setUpdatedAt(now);
            sessionUnitRepository.save(sessionUnit);
        } else {
            // SUBMIT or REVISE: graded by the caller (exact match, grade cache or AI)
            feedback = evaluation.feedback();
            evaluationStatus = evaluation.status();
            accepted = evaluation.accepted();
            cacheFingerprint = evaluation.cacheFingerprint();

            // Update session unit terminal status and advance/complete session appropriately
            if (Boolean.TRUE.equals(accepted)) {
                sessionUnit.setTerminalStatus("ACCEPTED");
                boolean allUnitsAccepted = allUnits.stream().allMatch(u -> 
                    u.getUnitOrdinal() == currentOrdinal || "ACCEPTED".equals(u.getTerminalStatus())
                );
                if (allUnitsAccepted) {
                    session.setStatus("COMPLETED");
                    session.setCompletedAt(now);
                }
            } else if (Boolean.FALSE.equals(accepted)) {
                sessionUnit.setTerminalStatus("NEEDS_REVISION");
            } else {
                sessionUnit.setTerminalStatus("UNCERTAIN");
            }
            sessionUnit.setDraftText(answerText);
            sessionUnit.setUpdatedAt(now);
            sessionUnitRepository.save(sessionUnit);
        }

        // Save Attempt Entity
        String resultSnapshotJson = null;
        if (feedback != null) {
            try {
                resultSnapshotJson = objectMapper.writeValueAsString(feedback);
            } catch (Exception ex) {
                log.warn("Failed to serialize feedback: {}", ex.getMessage());
            }
        }

        TranslationAttemptEntity attempt = TranslationAttemptEntity.builder()
                .userId(userId)
                .sessionId(sessionId)
                .exerciseId(exercise.getId())
                .unitId(sessionUnit.getUnitId())
                .unitOrdinal(currentOrdinal)
                .attemptOrdinal(nextAttemptOrdinal)
                .action(action)
                .clientMutationId(request.getClientMutationId())
                .requestSha256(TranslationGradeCacheService.sha256(request.getClientMutationId()))
                .answerText(answerText)
                .exactAnswerHash(exactAnswerHash)
                .answerCacheHash(answerCacheHash)
                .hintLevel(sessionUnit.getHintLevel())
                .referenceRevealed(sessionUnit.isReferenceRevealed())
                .evaluationStatus(evaluationStatus)
                .graderVersion(GRADER_VERSION)
                .resultSnapshot(resultSnapshotJson)
                .accepted(accepted)
                .cacheFingerprint(cacheFingerprint)
                .createdAt(now)
                .build();

        attempt = attemptRepository.save(attempt);

        // Put result in cache if newly computed
        if (cacheFingerprint != null && feedback != null) {
            gradeCacheService.putResult(
                    userId, cacheFingerprint, exercise.getId(), sessionUnit.getUnitId(),
                    session.getContentVersion(), exactAnswerHash, GRADER_VERSION, feedback, attempt.getId()
            );
        }

        session.setLastAttemptId(attempt.getId());
        session.setSessionRevision(session.getSessionRevision() + 1);
        session.setUpdatedAt(now);
        sessionRepository.save(session);

        sessionUnit.setLastAttemptId(attempt.getId());
        sessionUnitRepository.save(sessionUnit);

        boolean sessionCompleted = "COMPLETED".equals(session.getStatus());
        Short nextOrdinal = null;
        if (!sessionCompleted) {
            if (currentOrdinal < allUnits.size()) {
                nextOrdinal = (short) (currentOrdinal + 1);
            } else {
                Optional<TranslationSessionUnitEntity> uncompleted = allUnits.stream()
                        .filter(u -> !"ACCEPTED".equals(u.getTerminalStatus()) && u.getUnitOrdinal() != currentOrdinal)
                        .findFirst();
                nextOrdinal = uncompleted.map(TranslationSessionUnitEntity::getUnitOrdinal).orElse(currentOrdinal);
            }
        }

        // REFERENCE REVEAL GUARD: referenceEn is ONLY returned if accepted=true or referenceRevealed=true!
        boolean canRevealReference = Boolean.TRUE.equals(accepted) || sessionUnit.isReferenceRevealed();
        String safeReferenceEn = canRevealReference ? exerciseUnit.getReferenceEn() : null;

        return TranslationAttemptResponse.builder()
                .attemptId(attempt.getId())
                .sessionId(sessionId)
                .unitOrdinal(currentOrdinal)
                .attemptOrdinal(nextAttemptOrdinal)
                .action(action)
                .evaluationStatus(evaluationStatus)
                .accepted(accepted)
                .sessionRevision(session.getSessionRevision())
                .feedback(feedback)
                .referenceEn(safeReferenceEn)
                .nextOrdinal(nextOrdinal)
                .sessionCompleted(sessionCompleted)
                .build();
    }

    private TranslationAttemptResponse buildAttemptResponse(TranslationAttemptEntity attempt, TranslationSessionEntity session) {
        TranslationExerciseUnitEntity eu = exerciseUnitRepository.findById(attempt.getUnitId()).orElse(null);
        TranslationSessionUnitEntity su = sessionUnitRepository.findBySessionIdAndUnitOrdinal(session.getId(), attempt.getUnitOrdinal()).orElse(null);

        TranslationFeedbackDto feedback = null;
        if (attempt.getResultSnapshot() != null) {
            try {
                feedback = objectMapper.readValue(attempt.getResultSnapshot(), TranslationFeedbackDto.class);
            } catch (Exception ex) {
                log.warn("Failed to parse attempt feedback snapshot: {}", ex.getMessage());
            }
        }

        boolean canReveal = Boolean.TRUE.equals(attempt.getAccepted()) || (su != null && su.isReferenceRevealed());
        String safeReferenceEn = canReveal ? (eu != null ? eu.getReferenceEn() : null) : null;

        return TranslationAttemptResponse.builder()
                .attemptId(attempt.getId())
                .sessionId(session.getId())
                .unitOrdinal(attempt.getUnitOrdinal())
                .attemptOrdinal(attempt.getAttemptOrdinal())
                .action(attempt.getAction())
                .evaluationStatus(attempt.getEvaluationStatus())
                .accepted(attempt.getAccepted())
                .sessionRevision(session.getSessionRevision())
                .feedback(feedback)
                .referenceEn(safeReferenceEn)
                .sessionCompleted("COMPLETED".equals(session.getStatus()))
                .build();
    }

    private List<Map<String, Object>> parseChunks(String json) {
        if (json == null || json.isBlank() || json.equals("[]")) {
            return Collections.emptyList();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<List<Map<String, Object>>>() {});
        } catch (Exception ex) {
            return Collections.emptyList();
        }
    }
}
