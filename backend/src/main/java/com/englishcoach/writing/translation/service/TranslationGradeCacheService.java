package com.englishcoach.writing.translation.service;

import com.englishcoach.writing.translation.dto.TranslationFeedbackDto;
import com.englishcoach.writing.translation.entity.TranslationGradeCacheEntity;
import com.englishcoach.writing.translation.repository.TranslationGradeCacheRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Service
@RequiredArgsConstructor
public class TranslationGradeCacheService {

    private final TranslationGradeCacheRepository gradeCacheRepository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    // L1 User-scoped cache: key -> (FeedbackDto, expiresAt)
    private final Map<String, CacheEntry> l1Cache = new ConcurrentHashMap<>();

    private static class CacheEntry {
        final TranslationFeedbackDto feedback;
        final Instant expiresAt;

        CacheEntry(TranslationFeedbackDto feedback, Instant expiresAt) {
            this.feedback = feedback;
            this.expiresAt = expiresAt;
        }

        boolean isExpired() {
            return Instant.now().isAfter(expiresAt);
        }
    }

    public String computeFingerprint(
            Long userId,
            UUID exerciseId,
            UUID unitId,
            String sourceVi,
            String referenceEn,
            String normalizedLearnerAnswer,
            String graderVersion
    ) {
        String raw = userId + ":" + exerciseId + ":" + unitId + ":"
                + sha256(sourceVi != null ? sourceVi : "") + ":"
                + sha256(referenceEn != null ? referenceEn : "") + ":"
                + sha256(normalizedLearnerAnswer != null ? normalizedLearnerAnswer : "") + ":"
                + graderVersion;
        return sha256(raw);
    }

    public String computeFingerprint(
            Long userId,
            UUID exerciseId,
            UUID unitId,
            int contentVersion,
            String exactAnswerHash,
            String graderVersion
    ) {
        String raw = userId + ":" + exerciseId + ":" + unitId + ":" + contentVersion + ":" + exactAnswerHash + ":" + graderVersion;
        return sha256(raw);
    }

    public Optional<TranslationFeedbackDto> getCachedResult(Long userId, String fingerprintHash) {
        String l1Key = userId + ":" + fingerprintHash;
        CacheEntry entry = l1Cache.get(l1Key);
        if (entry != null) {
            if (!entry.isExpired()) {
                log.info("Translation grade L1 cache HIT for fingerprint: {}", fingerprintHash);
                return Optional.of(entry.feedback);
            } else {
                l1Cache.remove(l1Key);
            }
        }

        // L2 DB Cache
        Optional<TranslationGradeCacheEntity> dbEntry = gradeCacheRepository.findByUserIdAndFingerprintHash(userId, fingerprintHash);
        if (dbEntry.isPresent()) {
            TranslationGradeCacheEntity e = dbEntry.get();
            if ("READY".equals(e.getResultStatus()) && e.getExpiresAt() != null && e.getExpiresAt().isAfter(Instant.now())) {
                try {
                    TranslationFeedbackDto feedback = objectMapper.readValue(e.getResultSnapshot(), TranslationFeedbackDto.class);
                    // Populate L1
                    l1Cache.put(l1Key, new CacheEntry(feedback, e.getExpiresAt()));
                    log.info("Translation grade L2 cache HIT for fingerprint: {}", fingerprintHash);
                    return Optional.of(feedback);
                } catch (Exception ex) {
                    log.warn("Failed to deserialize cached result snapshot: {}", ex.getMessage());
                }
            }
        }

        return Optional.empty();
    }

    @Transactional
    public void putResult(
            Long userId,
            String fingerprintHash,
            UUID exerciseId,
            UUID unitId,
            int contentVersion,
            String exactAnswerHash,
            String graderVersion,
            TranslationFeedbackDto feedback,
            UUID ownerAttemptId
    ) {
        try {
            Instant now = Instant.now();
            Instant expiresAt = now.plus(7, ChronoUnit.DAYS);
            String json = objectMapper.writeValueAsString(feedback);

            // Save to L1
            String l1Key = userId + ":" + fingerprintHash;
            l1Cache.put(l1Key, new CacheEntry(feedback, expiresAt));

            // Save or update L2
            Optional<TranslationGradeCacheEntity> existing = gradeCacheRepository.findByUserIdAndFingerprintHash(userId, fingerprintHash);
            TranslationGradeCacheEntity entity = existing.orElseGet(() -> TranslationGradeCacheEntity.builder()
                    .userId(userId)
                    .fingerprintHash(fingerprintHash)
                    .exerciseId(exerciseId)
                    .unitId(unitId)
                    .contentVersion(contentVersion)
                    .exactAnswerHash(exactAnswerHash)
                    .answerCacheHash(sha256(TranslationDeterministicGrader.normalizeMatching(exactAnswerHash)))
                    .graderVersion(graderVersion)
                    .createdAt(now)
                    .build());

            entity.setResultStatus("READY");
            entity.setResultSnapshot(json);
            entity.setExpiresAt(expiresAt);
            entity.setLeaseOwner(null);
            entity.setLeaseUntil(null);
            entity.setOwnerAttemptId(ownerAttemptId);

            gradeCacheRepository.save(entity);
            log.info("Stored translation grade cache entry for user {} fingerprint {}", userId, fingerprintHash);
        } catch (Exception ex) {
            log.warn("Failed to store grade cache entry: {}", ex.getMessage());
        }
    }

    public static String sha256(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] bytes = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : bytes) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 not available", e);
        }
    }
}
