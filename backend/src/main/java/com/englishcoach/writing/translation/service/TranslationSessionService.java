package com.englishcoach.writing.translation.service;

import com.englishcoach.writing.translation.dto.*;
import com.englishcoach.writing.translation.entity.*;
import com.englishcoach.writing.translation.repository.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ThreadLocalRandom;

@Slf4j
@Service
@RequiredArgsConstructor
public class TranslationSessionService {

    private final TranslationExerciseRepository exerciseRepository;
    private final TranslationExerciseUnitRepository exerciseUnitRepository;
    private final TranslationSessionRepository sessionRepository;
    private final TranslationSessionUnitRepository sessionUnitRepository;
    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();

    @Transactional
    public TranslationSessionResponse startSession(Long userId, TranslationStartRequest request) {
        String mode = (request.getMode() != null && !request.getMode().isBlank()) ? request.getMode().toUpperCase() : "SENTENCE";
        String topic = (request.getTopicCode() != null && !request.getTopicCode().isBlank() && !"ALL".equalsIgnoreCase(request.getTopicCode()))
                ? request.getTopicCode().toUpperCase() : null;
        String difficulty = (request.getDifficultyBucket() != null && !request.getDifficultyBucket().isBlank() && !"ALL".equalsIgnoreCase(request.getDifficultyBucket()))
                ? request.getDifficultyBucket().toUpperCase() : null;

        TranslationExerciseEntity exercise;

        if (request.getExerciseId() != null) {
            exercise = exerciseRepository.findByIdAndActiveTrue(request.getExerciseId())
                    .orElseThrow(() -> new IllegalArgumentException("Exercise not found: " + request.getExerciseId()));
        } else {
            // Find active candidate exercises for this topic / difficulty
            List<TranslationExerciseEntity> candidates = exerciseRepository.findAllActiveCandidates(mode, topic, difficulty);
            if (candidates.isEmpty() && difficulty != null) {
                // Fallback to any difficulty in topic
                candidates = exerciseRepository.findAllActiveCandidates(mode, topic, null);
            }
            if (candidates.isEmpty()) {
                // Fallback to any active exercise in mode
                candidates = exerciseRepository.findAllActiveCandidates(mode, null, null);
            }
            if (candidates.isEmpty()) {
                throw new IllegalStateException("No active translation exercises found for mode: " + mode);
            }

            // Avoid immediate repeats by excluding exercises the user has already completed
            List<UUID> completedIds = (userId != null) ? sessionRepository.findCompletedExerciseIdsByUserId(userId) : Collections.emptyList();
            Set<UUID> completedSet = new HashSet<>(completedIds);

            List<TranslationExerciseEntity> uncompleted = new ArrayList<>();
            for (TranslationExerciseEntity c : candidates) {
                if (!completedSet.contains(c.getId())) {
                    uncompleted.add(c);
                }
            }

            List<TranslationExerciseEntity> pool = !uncompleted.isEmpty() ? uncompleted : candidates;
            exercise = pool.get(ThreadLocalRandom.current().nextInt(pool.size()));
        }

        // Check if an ACTIVE session already exists for this user and exercise
        Optional<TranslationSessionEntity> existingSession = sessionRepository.findByUserIdAndExerciseIdAndStatus(userId, exercise.getId(), "ACTIVE");
        if (existingSession.isPresent()) {
            return buildSessionResponse(existingSession.get(), exercise);
        }

        // Check mutation receipt / idempotency for start
        Optional<TranslationSessionEntity> mutationMatch = sessionRepository.findByUserIdAndClientMutationId(userId, request.getClientMutationId());
        if (mutationMatch.isPresent()) {
            return buildSessionResponse(mutationMatch.get(), exercise);
        }

        // Create new session
        Instant now = Instant.now();
        TranslationSessionEntity session = TranslationSessionEntity.builder()
                .userId(userId)
                .exerciseId(exercise.getId())
                .contentVersion(exercise.getContentVersion())
                .status("ACTIVE")
                .currentOrdinal((short) 1)
                .sessionRevision(0L)
                .clientMutationId(request.getClientMutationId())
                .requestSha256(TranslationGradeCacheService.sha256(request.getClientMutationId()))
                .contextHash(exercise.getSourceMatchingHash())
                .startedAt(now)
                .updatedAt(now)
                .build();

        session = sessionRepository.save(session);

        // Populate session units
        List<TranslationExerciseUnitEntity> exerciseUnits = exerciseUnitRepository.findByExerciseIdAndActiveTrueOrderByOrdinalAsc(exercise.getId());
        List<TranslationSessionUnitEntity> sessionUnitsToSave = new ArrayList<>(exerciseUnits.size());
        for (TranslationExerciseUnitEntity eu : exerciseUnits) {
            TranslationSessionUnitEntity su = TranslationSessionUnitEntity.builder()
                    .sessionId(session.getId())
                    .exerciseId(exercise.getId())
                    .unitId(eu.getId())
                    .unitOrdinal(eu.getOrdinal())
                    .draftText("")
                    .draftRevision(0L)
                    .hintLevel("HIDDEN")
                    .revealedTokensJson("[]")
                    .referenceRevealed(false)
                    .terminalStatus("UNSEEN")
                    .createdAt(now)
                    .updatedAt(now)
                    .build();
            sessionUnitsToSave.add(su);
        }
        sessionUnitRepository.saveAll(sessionUnitsToSave);

        return buildSessionResponse(session, exercise);
    }

    @Transactional(readOnly = true)
    public TranslationSessionResponse getSession(Long userId, UUID sessionId) {
        TranslationSessionEntity session = sessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new IllegalArgumentException("Session not found: " + sessionId));
        TranslationExerciseEntity exercise = exerciseRepository.findById(session.getExerciseId())
                .orElseThrow(() -> new IllegalStateException("Exercise missing for session: " + session.getExerciseId()));
        return buildSessionResponse(session, exercise);
    }

    public TranslationSessionResponse buildSessionResponse(TranslationSessionEntity session, TranslationExerciseEntity exercise) {
        List<TranslationSessionUnitEntity> sessionUnits = sessionUnitRepository.findBySessionIdOrderByUnitOrdinalAsc(session.getId());
        List<TranslationExerciseUnitEntity> exerciseUnits = exerciseUnitRepository.findByExerciseIdOrderByOrdinalAsc(exercise.getId());

        Map<Short, TranslationExerciseUnitEntity> euMap = new HashMap<>();
        for (TranslationExerciseUnitEntity eu : exerciseUnits) {
            euMap.put(eu.getOrdinal(), eu);
        }

        List<TranslationUnitResponse> unitResponses = new ArrayList<>();
        TranslationUnitResponse currentUnitResponse = null;

        for (TranslationSessionUnitEntity su : sessionUnits) {
            TranslationExerciseUnitEntity eu = euMap.get(su.getUnitOrdinal());
            String sourceVi = eu != null ? eu.getSourceVi() : "";
            boolean isCurrent = (su.getUnitOrdinal() == session.getCurrentOrdinal());

            if (isCurrent) {
                String referenceEn = eu != null ? eu.getReferenceEn() : "";
                // Helper collocations and vocabulary are fully visible in full phrase
                List<Map<String, Object>> visibleHints = extractVisibleHints(eu, su.getHintLevel());

                // REFERENCE LEAK SECURITY: referenceEn is ONLY returned if revealed or accepted!
                boolean canRevealReference = su.isReferenceRevealed() || "ACCEPTED".equals(su.getTerminalStatus());
                String safeReferenceEn = canRevealReference ? (eu != null ? eu.getReferenceEn() : null) : null;

                // Progressive Reference Sentence Tokens
                Set<Integer> revealedIndices = parseRevealedTokens(su.getRevealedTokensJson());
                List<TranslationTokenDto> maskedTokens = tokenizeReference(referenceEn, revealedIndices, canRevealReference);

                currentUnitResponse = TranslationUnitResponse.builder()
                        .unitId(su.getUnitId())
                        .ordinal(su.getUnitOrdinal())
                        .sourceVi(sourceVi)
                        .hintLevel(su.getHintLevel())
                        .referenceRevealed(su.isReferenceRevealed())
                        .draftText(su.getDraftText())
                        .terminalStatus(su.getTerminalStatus())
                        .visibleHints(visibleHints)
                        .maskedTokens(maskedTokens)
                        .referenceEn(safeReferenceEn)
                        .build();

                unitResponses.add(currentUnitResponse);
            } else {
                // Lightweight transport for navigation list: avoids loading hundreds of heavy payloads into browser
                TranslationUnitResponse lightweightUr = TranslationUnitResponse.builder()
                        .unitId(su.getUnitId())
                        .ordinal(su.getUnitOrdinal())
                        .sourceVi(sourceVi)
                        .hintLevel(su.getHintLevel())
                        .referenceRevealed(su.isReferenceRevealed())
                        .draftText(su.getDraftText())
                        .terminalStatus(su.getTerminalStatus())
                        .visibleHints(Collections.emptyList())
                        .maskedTokens(null)
                        .referenceEn(null)
                        .build();

                unitResponses.add(lightweightUr);
            }
        }

        if (currentUnitResponse == null && !unitResponses.isEmpty()) {
            currentUnitResponse = unitResponses.get(0);
        }

        return TranslationSessionResponse.builder()
                .sessionId(session.getId())
                .exerciseId(exercise.getId())
                .mode(exercise.getMode())
                .topicCode(exercise.getTopicCode())
                .difficultyBucket(exercise.getDifficultyBucket())
                .cefrBand(exercise.getCefrBand())
                .contentVersion(session.getContentVersion())
                .currentOrdinal(session.getCurrentOrdinal())
                .totalUnits(unitResponses.size())
                .sessionRevision(session.getSessionRevision())
                .status(session.getStatus())
                .currentUnit(currentUnitResponse)
                .units(unitResponses)
                .build();
    }

    public List<Map<String, Object>> extractVisibleHints(TranslationExerciseUnitEntity eu, String hintLevel) {
        if (eu == null || eu.getTargetChunksJson() == null || eu.getTargetChunksJson().isBlank() || "[]".equals(eu.getTargetChunksJson())) {
            return Collections.emptyList();
        }

        try {
            List<Map<String, Object>> allChunks = objectMapper.readValue(
                    eu.getTargetChunksJson(), new TypeReference<List<Map<String, Object>>>() {}
            );

            List<Map<String, Object>> result = new ArrayList<>();
            for (Map<String, Object> chunk : allChunks) {
                // Ensure text is NEVER stripped - real phrases displayed in full
                result.add(new HashMap<>(chunk));
            }
            return result;
        } catch (Exception ex) {
            log.warn("Failed to parse chunks for unit: {}", ex.getMessage());
            return Collections.emptyList();
        }
    }

    public Set<Integer> parseRevealedTokens(String json) {
        if (json == null || json.isBlank() || "[]".equals(json.trim())) {
            return new HashSet<>();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<Set<Integer>>() {});
        } catch (Exception ex) {
            log.warn("Failed to parse revealed tokens json: {}", ex.getMessage());
            return new HashSet<>();
        }
    }

    public static List<TranslationTokenDto> tokenizeReference(String referenceEn, Set<Integer> revealedIndices, boolean allRevealed) {
        if (referenceEn == null || referenceEn.isBlank()) {
            return Collections.emptyList();
        }

        String[] parts = referenceEn.trim().split("\\s+");
        List<TranslationTokenDto> tokens = new ArrayList<>();

        for (int i = 0; i < parts.length; i++) {
            String raw = parts[i];
            if (raw.isEmpty()) continue;

            int start = 0;
            while (start < raw.length() && !Character.isLetterOrDigit(raw.charAt(start))) {
                start++;
            }

            int end = raw.length();
            while (end > start && !Character.isLetterOrDigit(raw.charAt(end - 1))) {
                end--;
            }

            String leadingPunct = raw.substring(0, start);
            String core = raw.substring(start, end);
            String trailingPunct = raw.substring(end);

            if (core.isEmpty()) {
                // Pure punctuation token like "-" or "—"
                tokens.add(TranslationTokenDto.builder()
                        .index(i)
                        .firstChar("")
                        .length(0)
                        .leadingPunct("")
                        .trailingPunct("")
                        .revealed(true)
                        .word(raw)
                        .punctuationOnly(true)
                        .build());
                continue;
            }

            boolean isRevealed = allRevealed || (revealedIndices != null && revealedIndices.contains(i));
            tokens.add(TranslationTokenDto.builder()
                    .index(i)
                    .firstChar(core.substring(0, 1))
                    .length(core.length())
                    .leadingPunct(leadingPunct)
                    .trailingPunct(trailingPunct)
                    .revealed(isRevealed)
                    .word(core)
                    .punctuationOnly(false)
                    .build());
        }

        return tokens;
    }

    @Transactional
    public TranslationSessionResponse navigateSession(Long userId, UUID sessionId, short targetOrdinal) {
        TranslationSessionEntity session = sessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new IllegalArgumentException("Session not found: " + sessionId));
        List<TranslationSessionUnitEntity> sessionUnits = sessionUnitRepository.findBySessionIdOrderByUnitOrdinalAsc(sessionId);
        if (targetOrdinal < 1 || targetOrdinal > sessionUnits.size()) {
            throw new IllegalArgumentException("Invalid ordinal: " + targetOrdinal);
        }
        session.setCurrentOrdinal(targetOrdinal);
        session.setUpdatedAt(Instant.now());
        TranslationSessionEntity savedSession = sessionRepository.save(session);

        TranslationExerciseEntity exercise = exerciseRepository.findById(savedSession.getExerciseId())
                .orElseThrow(() -> new IllegalStateException("Exercise missing: " + savedSession.getExerciseId()));
        return buildSessionResponse(savedSession, exercise);
    }
}
