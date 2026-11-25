package com.englishcoach.writing.translation.paragraph.service;

import com.englishcoach.writing.translation.paragraph.dto.*;
import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphPassageEntity;
import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphSessionEntity;
import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphSessionItemEntity;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphPassageRepository;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphSessionItemRepository;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphSessionRepository;
import jakarta.persistence.EntityNotFoundException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class ParagraphSessionService {

    private final TranslationParagraphSessionRepository sessionRepository;
    private final TranslationParagraphSessionItemRepository itemRepository;
    private final TranslationParagraphPassageRepository passageRepository;

    private String normalizeTopic(String topic) {
        if (topic == null || topic.isBlank() || "ALL".equalsIgnoreCase(topic.trim())) {
            return null;
        }
        return topic.trim().toUpperCase();
    }

    private String normalizeGenre(String genre) {
        if (genre == null || genre.isBlank() || "ALL".equalsIgnoreCase(genre.trim())) {
            return null;
        }
        return genre.trim().toUpperCase();
    }

    @Transactional
    public ParagraphSessionResponse startSession(Long userId, ParagraphStartRequest request) {
        // 1. Idempotency: check if session with identical clientMutationId exists for this user
        Optional<TranslationParagraphSessionEntity> existingByMutation = sessionRepository
                .findByUserIdAndClientMutationId(userId, request.getClientMutationId());
        if (existingByMutation.isPresent()) {
            log.info("Returning existing session for user {} and clientMutationId {}", userId, request.getClientMutationId());
            return mapToResponse(existingByMutation.get());
        }

        String reqTopic = normalizeTopic(request.getTopic());
        String reqGenre = normalizeGenre(request.getGenre());

        // 2. Authoritative total pool count from central eligibility predicate
        long totalCount = passageRepository.countEligiblePassagesByFilter(reqGenre, reqTopic);
        if (totalCount == 0) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND,
                    "No eligible paragraph passages found for the requested genre/topic"
            );
        }

        // 3. Active session: only resume if active session matches the requested filter context
        Optional<TranslationParagraphSessionEntity> activeSession = sessionRepository
                .findFirstByUserIdAndStatusOrderByUpdatedAtDesc(userId, "ACTIVE");
        if (activeSession.isEmpty()) {
            activeSession = sessionRepository
                    .findFirstByUserIdAndStatusOrderByUpdatedAtDesc(userId, "IN_PROGRESS");
        }
        if (activeSession.isPresent()) {
            TranslationParagraphSessionEntity current = activeSession.get();
            String curTopic = normalizeTopic(current.getFilterTopic());
            String curGenre = normalizeGenre(current.getFilterGenre());

            if (Objects.equals(curTopic, reqTopic) && Objects.equals(curGenre, reqGenre)) {
                log.info("User {} already has active paragraph session {} matching filter context [topic={}, genre={}]. Resuming.",
                        userId, current.getId(), reqTopic, reqGenre);
                // Transparently upgrade old 5-item session to full pool count if needed
                if (current.getTotalItems() == null || current.getTotalItems() < (int) totalCount) {
                    log.info("Upgrading active session {} totalItems from {} to full pool count {}",
                            current.getId(), current.getTotalItems(), totalCount);
                    current.setTotalItems((int) totalCount);
                    sessionRepository.saveAndFlush(current);
                }
                return mapToResponse(current);
            } else {
                log.info("User {} has active session {} with filter [topic={}, genre={}], but requested [topic={}, genre={}]. Marking previous session as ABANDONED and starting new session.",
                        userId, current.getId(), curTopic, curGenre, reqTopic, reqGenre);
                current.setStatus("ABANDONED");
                current.setUpdatedAt(Instant.now());
                sessionRepository.saveAndFlush(current);
            }
        }

        // 4. Create new user-owned session representing the full eligible pool
        TranslationParagraphSessionEntity session = TranslationParagraphSessionEntity.builder()
                .userId(userId)
                .status("ACTIVE")
                .clientMutationId(request.getClientMutationId())
                .contentVersion(1)
                .currentIndex(0)
                .sessionRevision(1L)
                .totalItems((int) totalCount)
                .filterGenre(reqGenre)
                .filterTopic(reqTopic)
                .items(new ArrayList<>())
                .build();

        TranslationParagraphSessionEntity savedSession = sessionRepository.save(session);

        // 5. Lazy materialization: materialize ONLY ordinal 0 upfront (1 row in session_items)
        TranslationParagraphSessionItemEntity item0 = getOrCreateItemAtOrdinalInternal(savedSession, 0);
        savedSession.getItems().add(item0);

        log.info("Started lazy paragraph session {} with {} total passages for user {} (materialized ordinal 0)",
                savedSession.getId(), savedSession.getTotalItems(), userId);
        return mapToResponse(savedSession);
    }

    @Transactional
    public TranslationParagraphSessionItemEntity getOrCreateItemAtOrdinal(TranslationParagraphSessionEntity session, int ordinal) {
        return getOrCreateItemAtOrdinalInternal(session, ordinal);
    }

    private TranslationParagraphSessionItemEntity getOrCreateItemAtOrdinalInternal(TranslationParagraphSessionEntity session, int ordinal) {
        Optional<TranslationParagraphSessionItemEntity> existing = itemRepository
                .findBySessionIdAndOrdinal(session.getId(), ordinal);
        if (existing.isPresent()) {
            return existing.get();
        }

        if (session.getTotalItems() != null && (ordinal < 0 || ordinal >= session.getTotalItems())) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    String.format("Invalid ordinal %d (session total: %d)", ordinal, session.getTotalItems())
            );
        }

        String reqTopic = normalizeTopic(session.getFilterTopic());
        String reqGenre = normalizeGenre(session.getFilterGenre());

        List<TranslationParagraphPassageEntity> passages = passageRepository.findEligiblePassages(
                reqGenre,
                reqTopic,
                PageRequest.of(ordinal, 1)
        );

        if (passages.isEmpty()) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND,
                    String.format("No eligible paragraph passage found at ordinal %d for genre=%s, topic=%s",
                            ordinal, reqGenre, reqTopic)
            );
        }

        TranslationParagraphPassageEntity passage = passages.get(0);
        TranslationParagraphSessionItemEntity item = TranslationParagraphSessionItemEntity.builder()
                .session(session)
                .passage(passage)
                .contentVersion(passage.getContentVersion())
                .ordinal(ordinal)
                .draftText("")
                .draftRevision(0L)
                .progressState("NOT_STARTED")
                .build();

        return itemRepository.save(item);
    }

    @Transactional
    public ParagraphSessionResponse getActiveSession(Long userId) {
        Optional<TranslationParagraphSessionEntity> session = sessionRepository
                .findFirstByUserIdAndStatusOrderByUpdatedAtDesc(userId, "ACTIVE");
        if (session.isEmpty()) {
            session = sessionRepository.findFirstByUserIdAndStatusOrderByUpdatedAtDesc(userId, "IN_PROGRESS");
        }
        return session.map(this::mapToResponse).orElse(null);
    }

    @Transactional
    public ParagraphSessionResponse getSession(Long userId, UUID sessionId) {
        TranslationParagraphSessionEntity session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new EntityNotFoundException("Paragraph session not found: " + sessionId));

        assertOwnership(userId, session);
        return mapToResponse(session);
    }

    @Transactional
    public ParagraphDraftResponse saveDraft(Long userId, UUID sessionId, ParagraphDraftRequest request) {
        TranslationParagraphSessionEntity session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new EntityNotFoundException("Paragraph session not found: " + sessionId));

        assertOwnership(userId, session);

        TranslationParagraphSessionItemEntity item = getOrCreateItemAtOrdinalInternal(session, request.getOrdinal());

        // STRICT CAS: Revision mismatch must NOT silently overwrite newer draft
        if (!Objects.equals(item.getDraftRevision(), request.getExpectedRevision())) {
            log.warn("CAS Conflict on session {} item {}: expected {} but was {}",
                    sessionId, request.getOrdinal(), request.getExpectedRevision(), item.getDraftRevision());
            throw new ResponseStatusException(
                    HttpStatus.CONFLICT,
                    String.format("Draft revision conflict: expected %d, but current revision is %d",
                            request.getExpectedRevision(), item.getDraftRevision())
            );
        }

        item.setDraftText(request.getDraftText());
        item.setDraftRevision(item.getDraftRevision() + 1);
        if ("NOT_STARTED".equals(item.getProgressState()) && !request.getDraftText().isBlank()) {
            item.setProgressState("IN_PROGRESS");
        }
        itemRepository.save(item);

        session.setSessionRevision(session.getSessionRevision() + 1);
        sessionRepository.save(session);

        return ParagraphDraftResponse.builder()
                .sessionId(sessionId)
                .ordinal(item.getOrdinal())
                .draftRevision(item.getDraftRevision())
                .progressState(item.getProgressState())
                .updatedAt(item.getUpdatedAt())
                .build();
    }

    @Transactional
    public ParagraphSessionResponse navigateSession(Long userId, UUID sessionId, Integer targetOrdinal) {
        TranslationParagraphSessionEntity session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new EntityNotFoundException("Paragraph session not found: " + sessionId));

        assertOwnership(userId, session);

        if (targetOrdinal == null || targetOrdinal < 0 || targetOrdinal >= session.getTotalItems()) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    String.format("Invalid target ordinal %s (total items: %d)", targetOrdinal, session.getTotalItems())
            );
        }

        // Lazy materialization: ensure target ordinal is materialized in DB
        getOrCreateItemAtOrdinalInternal(session, targetOrdinal);

        // Navigation does NOT grade, does NOT call AI, does NOT mutate corpus
        session.setCurrentIndex(targetOrdinal);
        session.setSessionRevision(session.getSessionRevision() + 1);
        TranslationParagraphSessionEntity updated = sessionRepository.save(session);

        return mapToResponse(updated);
    }

    @Transactional
    public ParagraphSessionResponse skipItem(Long userId, UUID sessionId, Integer ordinal) {
        TranslationParagraphSessionEntity session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new EntityNotFoundException("Paragraph session not found: " + sessionId));

        assertOwnership(userId, session);

        TranslationParagraphSessionItemEntity item = getOrCreateItemAtOrdinalInternal(session, ordinal);

        item.setProgressState("SKIPPED");
        itemRepository.save(item);

        // Advance to next ordinal if current
        if (Objects.equals(session.getCurrentIndex(), ordinal) && ordinal + 1 < session.getTotalItems()) {
            session.setCurrentIndex(ordinal + 1);
            // Pre-materialize next ordinal
            getOrCreateItemAtOrdinalInternal(session, ordinal + 1);
        }
        session.setSessionRevision(session.getSessionRevision() + 1);
        TranslationParagraphSessionEntity updated = sessionRepository.save(session);

        return mapToResponse(updated);
    }

    private void assertOwnership(Long userId, TranslationParagraphSessionEntity session) {
        if (!Objects.equals(session.getUserId(), userId)) {
            log.warn("Unauthorized access attempt: user {} tried to access session {} belonging to user {}",
                    userId, session.getId(), session.getUserId());
            throw new AccessDeniedException("Access denied: session does not belong to user");
        }
    }

    private ParagraphSessionResponse mapToResponse(TranslationParagraphSessionEntity session) {
        List<TranslationParagraphSessionItemEntity> items = itemRepository.findBySessionIdOrderByOrdinalAsc(session.getId());

        int currentIdx = session.getCurrentIndex() != null ? session.getCurrentIndex() : 0;
        boolean hasCurrent = items.stream().anyMatch(it -> Objects.equals(it.getOrdinal(), currentIdx));
        if (!hasCurrent && session.getTotalItems() != null && session.getTotalItems() > 0 && currentIdx >= 0 && currentIdx < session.getTotalItems()) {
            try {
                TranslationParagraphSessionItemEntity curItem = getOrCreateItemAtOrdinalInternal(session, currentIdx);
                items = new ArrayList<>(items);
                items.add(curItem);
                items.sort(Comparator.comparing(TranslationParagraphSessionItemEntity::getOrdinal));
            } catch (Exception ex) {
                log.warn("Could not lazily materialize item at ordinal {} for session {}: {}", currentIdx, session.getId(), ex.getMessage());
            }
        }

        List<ParagraphSessionItemResponse> itemDtos = new ArrayList<>();
        for (TranslationParagraphSessionItemEntity it : items) {
            TranslationParagraphPassageEntity p = it.getPassage();
            itemDtos.add(ParagraphSessionItemResponse.builder()
                    .itemId(it.getId())
                    .passageId(p.getId())
                    .ordinal(it.getOrdinal())
                    .contentVersion(it.getContentVersion())
                    .sourceVi(p.getSourceVi())
                    .referenceEn(null) // EC-SEC-2026-038: never expose reference answer key before submission
                    .sourceTitle(p.getDocument() != null ? p.getDocument().getSourceTitle() : "")
                    .targetTitle(p.getDocument() != null ? p.getDocument().getTargetTitle() : "")
                    .genre(p.getGenre())
                    .topic(p.getTopic())
                    .difficultyStatus(p.getDifficultyStatus())
                    .attributionText(p.getAttributionText())
                    .licenseCode(p.getLicenseCode())
                    .sourceUrl(p.getSourceUrl())
                    .targetUrl(p.getTargetUrl())
                    .draftText(it.getDraftText())
                    .draftRevision(it.getDraftRevision())
                    .progressState(it.getProgressState())
                    .build());
        }

        return ParagraphSessionResponse.builder()
                .sessionId(session.getId())
                .status(session.getStatus())
                .currentIndex(session.getCurrentIndex())
                .sessionRevision(session.getSessionRevision())
                .totalItems(session.getTotalItems())
                .clientMutationId(session.getClientMutationId())
                .filterGenre(session.getFilterGenre())
                .filterTopic(session.getFilterTopic())
                .items(itemDtos)
                .createdAt(session.getStartedAt())
                .updatedAt(session.getUpdatedAt())
                .build();
    }
}
