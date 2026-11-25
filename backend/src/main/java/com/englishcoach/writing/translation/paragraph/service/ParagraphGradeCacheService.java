package com.englishcoach.writing.translation.paragraph.service;

import com.englishcoach.writing.translation.paragraph.dto.ParagraphFeedbackDto;
import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphGradeCacheEntity;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphGradeCacheRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Optional;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class ParagraphGradeCacheService {

    private final TranslationParagraphGradeCacheRepository cacheRepository;
    private final ParagraphDeterministicGrader deterministicGrader;
    private final ObjectMapper objectMapper;

    public String computeFingerprint(
            Long userId,
            UUID passageId,
            Integer contentVersion,
            String sourceHash,
            String referenceHash,
            String normalizedAnswerHash,
            String graderVersion,
            String promptVersion,
            String genre
    ) {
        String raw = String.format("%d:%s:%d:%s:%s:%s:%s:%s:%s",
                userId,
                passageId.toString(),
                contentVersion,
                sourceHash,
                referenceHash,
                normalizedAnswerHash,
                graderVersion,
                promptVersion,
                genre != null ? genre : "GENERAL"
        );
        return deterministicGrader.sha256(raw);
    }

    @Transactional(readOnly = true)
    public Optional<ParagraphFeedbackDto> getCachedFeedback(Long userId, String fingerprint) {
        return cacheRepository.findByUserIdAndCacheFingerprint(userId, fingerprint)
                .map(entity -> {
                    try {
                        ParagraphFeedbackDto dto = objectMapper.readValue(entity.getFeedbackJson(), ParagraphFeedbackDto.class);
                        dto.setCached(true);
                        dto.setGenerationCount(0);
                        return dto;
                    } catch (JsonProcessingException e) {
                        log.error("Failed to deserialize cached feedback for fingerprint {}", fingerprint, e);
                        return null;
                    }
                });
    }

    @Transactional
    public void saveCache(
            Long userId,
            UUID passageId,
            Integer contentVersion,
            String fingerprint,
            String sourceHash,
            String referenceHash,
            String normalizedAnswerHash,
            String graderVersion,
            String promptVersion,
            ParagraphFeedbackDto feedback
    ) {
        try {
            // Do not cache UNCERTAIN or technical failures
            if ("UNCERTAIN".equalsIgnoreCase(feedback.getEvaluationStatus())) {
                return;
            }

            String json = objectMapper.writeValueAsString(feedback);

            TranslationParagraphGradeCacheEntity entity = TranslationParagraphGradeCacheEntity.builder()
                    .userId(userId)
                    .passageId(passageId)
                    .contentVersion(contentVersion)
                    .cacheFingerprint(fingerprint)
                    .sourceHash(sourceHash)
                    .referenceHash(referenceHash)
                    .normalizedAnswerHash(normalizedAnswerHash)
                    .graderVersion(graderVersion)
                    .promptVersion(promptVersion)
                    .feedbackJson(json)
                    .accepted(Boolean.TRUE.equals(feedback.getAccepted()))
                    .evaluationStatus(feedback.getEvaluationStatus())
                    .build();

            cacheRepository.save(entity);
            log.info("Saved paragraph grade cache for user {} fingerprint {}", userId, fingerprint);
        } catch (Exception e) {
            log.warn("Failed to save paragraph grade cache (ignoring cache write failure): {}", e.getMessage());
        }
    }
}
