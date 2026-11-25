package com.englishcoach.writing.translation.paragraph.service;

import com.englishcoach.writing.translation.paragraph.dto.ParagraphAssistanceRequest;
import com.englishcoach.writing.translation.paragraph.dto.ParagraphAssistanceResponse;
import com.englishcoach.writing.translation.paragraph.dto.ParagraphAssistanceSegmentDto;
import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphPassageEntity;
import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphSessionEntity;
import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphSessionItemEntity;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphSessionItemRepository;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphSessionRepository;
import jakarta.persistence.EntityNotFoundException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;
import java.util.regex.Pattern;

@Slf4j
@Service
@RequiredArgsConstructor
public class ParagraphAssistanceService {

    private final TranslationParagraphSessionRepository sessionRepository;
    private final TranslationParagraphSessionItemRepository itemRepository;

    private static final Pattern SENTENCE_SPLIT_REGEX = Pattern.compile("(?<=[.!?])\\s+");

    @Transactional(readOnly = true)
    public ParagraphAssistanceResponse getAssistance(Long userId, UUID sessionId, ParagraphAssistanceRequest request) {
        TranslationParagraphSessionEntity session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new EntityNotFoundException("Session not found: " + sessionId));

        if (!Objects.equals(session.getUserId(), userId)) {
            throw new AccessDeniedException("Access denied: session does not belong to user");
        }

        TranslationParagraphSessionItemEntity item = itemRepository
                .findBySessionIdAndOrdinal(sessionId, request.getOrdinal())
                .orElseThrow(() -> new EntityNotFoundException("Session item not found at ordinal: " + request.getOrdinal()));

        TranslationParagraphPassageEntity passage = item.getPassage();
        String refEn = passage.getReferenceEn() != null ? passage.getReferenceEn().trim() : "";
        String srcVi = passage.getSourceVi() != null ? passage.getSourceVi().trim() : "";

        String[] viSentences = SENTENCE_SPLIT_REGEX.split(srcVi);
        String[] enSentences = SENTENCE_SPLIT_REGEX.split(refEn);

        int segmentCount = Math.max(viSentences.length, enSentences.length);
        List<ParagraphAssistanceSegmentDto> segments = new ArrayList<>();

        boolean isFullReveal = "REVEAL_ALL".equalsIgnoreCase(request.getAction());

        for (int i = 0; i < segmentCount; i++) {
            String segVi = i < viSentences.length ? viSentences[i] : "";
            String segEn = i < enSentences.length ? enSentences[i] : "";
            String[] tokens = segEn.isBlank() ? new String[0] : segEn.split("\\s+");

            boolean revealThisSegment = isFullReveal ||
                    ("REVEAL_SEGMENT".equalsIgnoreCase(request.getAction()) && Objects.equals(request.getSegmentIndex(), i));

            segments.add(ParagraphAssistanceSegmentDto.builder()
                    .segmentIndex(i)
                    .sourceVi(segVi)
                    .tokenCount(tokens.length)
                    .revealed(revealThisSegment)
                    .text(segEn)
                    .tokens(Arrays.asList(tokens))
                    .build());
        }

        return ParagraphAssistanceResponse.builder()
                .sessionId(sessionId)
                .ordinal(item.getOrdinal())
                .passageId(passage.getId())
                .fullReferenceRevealed(isFullReveal)
                .fullReferenceEn(refEn)
                .segments(segments)
                .build();
    }
}
