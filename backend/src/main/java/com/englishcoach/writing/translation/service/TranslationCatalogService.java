package com.englishcoach.writing.translation.service;

import com.englishcoach.writing.translation.dto.*;
import com.englishcoach.writing.translation.entity.TranslationExerciseEntity;
import com.englishcoach.writing.translation.entity.TranslationSessionEntity;
import com.englishcoach.writing.translation.repository.TranslationExerciseRepository;
import com.englishcoach.writing.translation.repository.TranslationExerciseUnitRepository;
import com.englishcoach.writing.translation.repository.TranslationSessionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class TranslationCatalogService {

    private final TranslationExerciseRepository exerciseRepository;
    private final TranslationSessionRepository sessionRepository;
    private final TranslationExerciseUnitRepository unitRepository;

    private static final Map<String, String> TOPIC_DISPLAY_NAMES = Map.ofEntries(
            Map.entry("GENERAL", "Chung"),
            Map.entry("EDUCATION", "Giáo dục"),
            Map.entry("TECHNOLOGY", "Công nghệ"),
            Map.entry("ENVIRONMENT", "Môi trường"),
            Map.entry("HEALTH", "Sức khỏe"),
            Map.entry("WORK", "Công việc"),
            Map.entry("SOCIETY", "Xã hội"),
            Map.entry("TRAVEL", "Du lịch"),
            Map.entry("CULTURE", "Văn hóa"),
            Map.entry("FAMILY", "Gia đình"),
            Map.entry("URBAN_LIFE", "Đô thị")
    );

    private static final Map<String, String> DIFFICULTY_DISPLAY_NAMES = Map.of(
            "FOUNDATION", "Cơ bản",
            "CORE", "Nâng cao",
            "CHALLENGE", "Thử thách"
    );

    @org.springframework.beans.factory.annotation.Value("${app.writing.translation.paragraph.enabled:${writing.translation.paragraph.enabled:false}}")
    private boolean paragraphModeEnabled;

    private record CachedSentenceCatalog(
            List<String> availableModes,
            List<TranslationTopicDto> topics,
            List<TranslationDifficultyDto> difficulties,
            List<TranslationCollectionDto> collections,
            long cachedAtEpochMs
    ) {}

    private static final long CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000L; // 24-hour TTL
    private final java.util.concurrent.atomic.AtomicReference<CachedSentenceCatalog> catalogCache = new java.util.concurrent.atomic.AtomicReference<>();
    private final Object cacheLock = new Object();

    public void invalidateCatalogCache() {
        catalogCache.set(null);
    }

    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
    public void warmCatalogCache() {
        try {
            getOrComputeGlobalCatalog();
        } catch (Exception e) {
            log.warn("Warm-up sentence catalog cache deferred: {}", e.getMessage());
        }
    }

    private CachedSentenceCatalog getOrComputeGlobalCatalog() {
        CachedSentenceCatalog cached = catalogCache.get();
        long now = System.currentTimeMillis();
        if (cached != null && (now - cached.cachedAtEpochMs()) < CATALOG_CACHE_TTL_MS) {
            return cached;
        }

        synchronized (cacheLock) {
            cached = catalogCache.get();
            if (cached != null && (now - cached.cachedAtEpochMs()) < CATALOG_CACHE_TTL_MS) {
                return cached;
            }

            List<String> availableModes = paragraphModeEnabled
                    ? List.of("SENTENCE", "PARAGRAPH")
                    : List.of("SENTENCE");

            // Eligible topic pools passing content gate (COUNT(u.id) >= 3)
            List<Object[]> eligibleRows = exerciseRepository.findEligibleTopicPools();
            List<TranslationCollectionDto> collections = new ArrayList<>();
            Map<String, Long> topicSentenceCounts = new LinkedHashMap<>();
            Map<String, Long> diffSentenceCounts = new LinkedHashMap<>();

            for (Object[] row : eligibleRows) {
                UUID exerciseId = (UUID) row[0];
                String topicCode = (String) row[1];
                String diffBucket = (String) row[2];
                long exerciseCount = (Long) row[3];
                long sentenceCount = (Long) row[4];

                topicSentenceCounts.put(topicCode, topicSentenceCounts.getOrDefault(topicCode, 0L) + sentenceCount);
                diffSentenceCounts.put(diffBucket, diffSentenceCounts.getOrDefault(diffBucket, 0L) + sentenceCount);

                collections.add(TranslationCollectionDto.builder()
                        .exerciseId(exerciseId)
                        .mode("SENTENCE")
                        .topicCode(topicCode)
                        .topicDisplayName(TOPIC_DISPLAY_NAMES.getOrDefault(topicCode, topicCode))
                        .difficultyBucket(diffBucket)
                        .difficultyDisplayName(DIFFICULTY_DISPLAY_NAMES.getOrDefault(diffBucket, diffBucket))
                        .exerciseCount(exerciseCount)
                        .sentenceCount(sentenceCount)
                        .build());
            }

            List<TranslationTopicDto> topics = new ArrayList<>();
            for (Map.Entry<String, Long> entry : topicSentenceCounts.entrySet()) {
                topics.add(TranslationTopicDto.builder()
                        .code(entry.getKey())
                        .displayName(TOPIC_DISPLAY_NAMES.getOrDefault(entry.getKey(), entry.getKey()))
                        .count(entry.getValue())
                        .build());
            }

            List<TranslationDifficultyDto> difficulties = new ArrayList<>();
            for (Map.Entry<String, Long> entry : diffSentenceCounts.entrySet()) {
                difficulties.add(TranslationDifficultyDto.builder()
                        .code(entry.getKey())
                        .displayName(DIFFICULTY_DISPLAY_NAMES.getOrDefault(entry.getKey(), entry.getKey()))
                        .count(entry.getValue())
                        .build());
            }

            CachedSentenceCatalog fresh = new CachedSentenceCatalog(availableModes, topics, difficulties, collections, now);
            catalogCache.set(fresh);
            log.info("Computed and cached sentence translation catalog: {} collections, {} topics, {} difficulties (TTL: 24h)",
                    collections.size(), topics.size(), difficulties.size());
            return fresh;
        }
    }

    @Transactional(readOnly = true)
    public TranslationCatalogResponse getCatalog(Long userId) {
        CachedSentenceCatalog meta = getOrComputeGlobalCatalog();

        // Active session check strictly by user and status with LIMIT 1
        TranslationSessionSummaryDto activeSessionDto = null;
        if (userId != null) {
            Optional<TranslationSessionEntity> activeSession = sessionRepository
                    .findFirstByUserIdAndStatusOrderByUpdatedAtDesc(userId, "ACTIVE");
            if (activeSession.isEmpty()) {
                activeSession = sessionRepository
                        .findFirstByUserIdAndStatusOrderByUpdatedAtDesc(userId, "IN_PROGRESS");
            }
            if (activeSession.isPresent()) {
                TranslationSessionEntity s = activeSession.get();
                Optional<TranslationExerciseEntity> ex = exerciseRepository.findById(s.getExerciseId());
                if (ex.isPresent()) {
                    TranslationExerciseEntity exercise = ex.get();
                    int totalUnits = unitRepository.findByExerciseIdOrderByOrdinalAsc(exercise.getId()).size();
                    activeSessionDto = TranslationSessionSummaryDto.builder()
                            .sessionId(s.getId())
                            .exerciseId(exercise.getId())
                            .mode(exercise.getMode())
                            .topicCode(exercise.getTopicCode())
                            .difficultyBucket(exercise.getDifficultyBucket())
                            .currentOrdinal(s.getCurrentOrdinal())
                            .totalUnits(Math.max(1, totalUnits))
                            .sessionRevision(s.getSessionRevision())
                            .updatedAt(s.getUpdatedAt())
                            .build();
                }
            }
        }

        return TranslationCatalogResponse.builder()
                .availableModes(meta.availableModes())
                .topics(meta.topics())
                .difficulties(meta.difficulties())
                .collections(meta.collections())
                .activeSession(activeSessionDto)
                .paragraphModeEnabled(paragraphModeEnabled)
                .build();
    }
}
