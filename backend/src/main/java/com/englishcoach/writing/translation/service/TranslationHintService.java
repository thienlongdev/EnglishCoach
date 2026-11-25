package com.englishcoach.writing.translation.service;

import com.englishcoach.writing.translation.dto.TranslationHintRequest;
import com.englishcoach.writing.translation.dto.TranslationHintResponse;
import com.englishcoach.writing.translation.entity.TranslationExerciseUnitEntity;
import com.englishcoach.writing.translation.entity.TranslationMutationReceiptEntity;
import com.englishcoach.writing.translation.entity.TranslationSessionEntity;
import com.englishcoach.writing.translation.entity.TranslationSessionUnitEntity;
import com.englishcoach.writing.translation.repository.TranslationExerciseUnitRepository;
import com.englishcoach.writing.translation.repository.TranslationMutationReceiptRepository;
import com.englishcoach.writing.translation.repository.TranslationSessionRepository;
import com.englishcoach.writing.translation.repository.TranslationSessionUnitRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class TranslationHintService {

    private final TranslationSessionRepository sessionRepository;
    private final TranslationSessionUnitRepository sessionUnitRepository;
    private final TranslationExerciseUnitRepository exerciseUnitRepository;
    private final TranslationMutationReceiptRepository receiptRepository;
    private final TranslationSessionService sessionService;
    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();

    @Transactional
    public TranslationHintResponse processHint(Long userId, UUID sessionId, TranslationHintRequest request) {
        TranslationSessionEntity session = sessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new IllegalArgumentException("Session not found: " + sessionId));

        // Idempotency receipt check
        Optional<TranslationMutationReceiptEntity> existingReceipt = receiptRepository.findByUserIdAndClientMutationId(userId, request.getClientMutationId());
        if (existingReceipt.isPresent()) {
            try {
                return objectMapper.readValue(existingReceipt.get().getResponseSnapshot(), TranslationHintResponse.class);
            } catch (Exception ex) {
                log.warn("Failed to deserialize hint receipt: {}", ex.getMessage());
            }
        }

        short currentOrdinal = session.getCurrentOrdinal();
        TranslationSessionUnitEntity sessionUnit = sessionUnitRepository.findBySessionIdAndUnitOrdinal(sessionId, currentOrdinal)
                .orElseThrow(() -> new IllegalStateException("Unit not found for ordinal: " + currentOrdinal));

        TranslationExerciseUnitEntity exerciseUnit = exerciseUnitRepository.findById(sessionUnit.getUnitId())
                .orElseThrow(() -> new IllegalStateException("Exercise unit missing: " + sessionUnit.getUnitId()));

        String action = request.getAction().toUpperCase();
        Instant now = Instant.now();

        Set<Integer> revealedIndices = sessionService.parseRevealedTokens(sessionUnit.getRevealedTokensJson());
        List<com.englishcoach.writing.translation.dto.TranslationTokenDto> currentTokens = 
                TranslationSessionService.tokenizeReference(exerciseUnit.getReferenceEn(), revealedIndices, sessionUnit.isReferenceRevealed());
        int totalTokens = currentTokens.size();

        if ("REVEAL_REFERENCE".equals(action) || "REVEAL_ALL".equals(action)) {
            sessionUnit.setReferenceRevealed(true);
            sessionUnit.setHintLevel("REFERENCE");
            // Preserve user's individual revealedIndices so HIDE_ALL can restore them!
            if (!"ACCEPTED".equals(sessionUnit.getTerminalStatus())) {
                sessionUnit.setTerminalStatus("REVEALED");
            }
        } else if ("HIDE_REFERENCE".equals(action) || "HIDE_ALL".equals(action)) {
            sessionUnit.setReferenceRevealed(false);
            sessionUnit.setHintLevel(revealedIndices.isEmpty() ? "HIDDEN" : "CHUNK");
            if ("REVEALED".equals(sessionUnit.getTerminalStatus())) {
                sessionUnit.setTerminalStatus("DRAFTING");
            }
        } else if ("REVEAL_TOKEN".equals(action) && request.getTokenIndex() != null) {
            int tokenIdx = request.getTokenIndex();
            if (tokenIdx >= 0 && tokenIdx < totalTokens) {
                revealedIndices.add(tokenIdx);
            }
            if (totalTokens > 0 && revealedIndices.size() >= totalTokens) {
                sessionUnit.setReferenceRevealed(true);
                sessionUnit.setHintLevel("REFERENCE");
            } else {
                sessionUnit.setHintLevel("CHUNK");
            }
        } else {
            // NEXT_HINT: Find the next unrevealed token in sentence order
            int nextUnrevealed = -1;
            for (int i = 0; i < totalTokens; i++) {
                if (!revealedIndices.contains(i)) {
                    nextUnrevealed = i;
                    break;
                }
            }
            if (nextUnrevealed != -1) {
                revealedIndices.add(nextUnrevealed);
            }
            if (totalTokens > 0 && revealedIndices.size() >= totalTokens) {
                sessionUnit.setReferenceRevealed(true);
                sessionUnit.setHintLevel("REFERENCE");
            } else {
                sessionUnit.setHintLevel("CUE");
            }
        }

        try {
            sessionUnit.setRevealedTokensJson(objectMapper.writeValueAsString(revealedIndices));
        } catch (Exception ex) {
            log.warn("Failed to serialize revealedTokensJson: {}", ex.getMessage());
        }

        sessionUnit.setUpdatedAt(now);
        sessionUnitRepository.save(sessionUnit);

        session.setSessionRevision(session.getSessionRevision() + 1);
        session.setUpdatedAt(now);
        sessionRepository.save(session);

        List<Map<String, Object>> visibleHints = sessionService.extractVisibleHints(exerciseUnit, sessionUnit.getHintLevel());
        boolean canRevealReference = sessionUnit.isReferenceRevealed() || "ACCEPTED".equals(sessionUnit.getTerminalStatus());
        String safeReferenceEn = canRevealReference ? exerciseUnit.getReferenceEn() : null;
        List<com.englishcoach.writing.translation.dto.TranslationTokenDto> updatedMaskedTokens = 
                TranslationSessionService.tokenizeReference(exerciseUnit.getReferenceEn(), revealedIndices, canRevealReference);

        TranslationHintResponse response = TranslationHintResponse.builder()
                .sessionId(sessionId)
                .unitOrdinal(currentOrdinal)
                .hintLevel(sessionUnit.getHintLevel())
                .referenceRevealed(sessionUnit.isReferenceRevealed())
                .visibleHints(visibleHints)
                .maskedTokens(updatedMaskedTokens)
                .referenceEn(safeReferenceEn)
                .sessionRevision(session.getSessionRevision())
                .build();

        // Save receipt
        try {
            TranslationMutationReceiptEntity receipt = TranslationMutationReceiptEntity.builder()
                    .userId(userId)
                    .sessionId(sessionId)
                    .sessionUnitId(sessionUnit.getId())
                    .endpoint("HINT")
                    .clientMutationId(request.getClientMutationId())
                    .requestSha256(TranslationGradeCacheService.sha256(request.getClientMutationId()))
                    .responseSnapshot(objectMapper.writeValueAsString(response))
                    .createdAt(now)
                    .build();
            receiptRepository.save(receipt);
        } catch (Exception ex) {
            log.warn("Failed to persist hint receipt: {}", ex.getMessage());
        }

        return response;
    }
}
