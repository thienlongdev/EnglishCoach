package com.englishcoach.writing.translation.service;

import com.englishcoach.writing.translation.dto.TranslationDraftRequest;
import com.englishcoach.writing.translation.dto.TranslationDraftResponse;
import com.englishcoach.writing.translation.entity.TranslationMutationReceiptEntity;
import com.englishcoach.writing.translation.entity.TranslationSessionEntity;
import com.englishcoach.writing.translation.entity.TranslationSessionUnitEntity;
import com.englishcoach.writing.translation.repository.TranslationMutationReceiptRepository;
import com.englishcoach.writing.translation.repository.TranslationSessionRepository;
import com.englishcoach.writing.translation.repository.TranslationSessionUnitRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class TranslationDraftService {

    private final TranslationSessionRepository sessionRepository;
    private final TranslationSessionUnitRepository sessionUnitRepository;
    private final TranslationMutationReceiptRepository receiptRepository;
    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();

    @Transactional
    public TranslationDraftResponse saveDraft(Long userId, UUID sessionId, TranslationDraftRequest request) {
        TranslationSessionEntity session = sessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new IllegalArgumentException("Session not found: " + sessionId));

        // Idempotency receipt check
        Optional<TranslationMutationReceiptEntity> existingReceipt = receiptRepository.findByUserIdAndClientMutationId(userId, request.getClientMutationId());
        if (existingReceipt.isPresent()) {
            try {
                return objectMapper.readValue(existingReceipt.get().getResponseSnapshot(), TranslationDraftResponse.class);
            } catch (Exception ex) {
                log.warn("Failed to deserialize draft receipt: {}", ex.getMessage());
            }
        }

        short targetOrdinal = (request.getUnitOrdinal() != null && request.getUnitOrdinal() > 0)
                ? request.getUnitOrdinal()
                : session.getCurrentOrdinal();
        TranslationSessionUnitEntity sessionUnit = sessionUnitRepository.findBySessionIdAndUnitOrdinal(sessionId, targetOrdinal)
                .orElseThrow(() -> new IllegalStateException("Unit not found for ordinal: " + targetOrdinal));

        // Optimistic revision check
        if (request.getExpectedRevision() > 0 && request.getExpectedRevision() != session.getSessionRevision()) {
            log.warn("Draft revision mismatch. Expected: {}, Current: {}", request.getExpectedRevision(), session.getSessionRevision());
        }

        Instant now = Instant.now();
        sessionUnit.setDraftText(request.getDraftText() != null ? request.getDraftText() : "");
        sessionUnit.setDraftRevision(sessionUnit.getDraftRevision() + 1);
        sessionUnit.setUpdatedAt(now);
        sessionUnitRepository.save(sessionUnit);

        session.setSessionRevision(session.getSessionRevision() + 1);
        session.setUpdatedAt(now);
        sessionRepository.save(session);

        TranslationDraftResponse response = TranslationDraftResponse.builder()
                .sessionId(sessionId)
                .unitOrdinal(targetOrdinal)
                .draftText(sessionUnit.getDraftText())
                .sessionRevision(session.getSessionRevision())
                .savedAt(now)
                .build();

        // Save receipt
        try {
            TranslationMutationReceiptEntity receipt = TranslationMutationReceiptEntity.builder()
                    .userId(userId)
                    .sessionId(sessionId)
                    .sessionUnitId(sessionUnit.getId())
                    .endpoint("DRAFT")
                    .clientMutationId(request.getClientMutationId())
                    .requestSha256(TranslationGradeCacheService.sha256(request.getClientMutationId()))
                    .responseSnapshot(objectMapper.writeValueAsString(response))
                    .createdAt(now)
                    .build();
            receiptRepository.save(receipt);
        } catch (Exception ex) {
            log.warn("Failed to persist draft receipt: {}", ex.getMessage());
        }

        return response;
    }
}
