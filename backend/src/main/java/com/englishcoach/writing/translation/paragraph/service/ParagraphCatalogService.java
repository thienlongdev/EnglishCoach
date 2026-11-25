package com.englishcoach.writing.translation.paragraph.service;

import com.englishcoach.writing.translation.paragraph.dto.*;
import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphPassageEntity;
import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphSessionEntity;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphPassageRepository;
import com.englishcoach.writing.translation.paragraph.repository.TranslationParagraphSessionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class ParagraphCatalogService {

    private final TranslationParagraphPassageRepository passageRepository;
    private final TranslationParagraphSessionRepository sessionRepository;

    @Value("${app.writing.translation.paragraph.enabled:${writing.translation.paragraph.enabled:false}}")
    private boolean paragraphModeEnabled;

    private static final Map<String, String> GENRE_DISPLAY_NAMES = Map.ofEntries(
            Map.entry("GENERAL", "Tổng quát"),
            Map.entry("ACADEMIC", "Học thuật"),
            Map.entry("NEWS", "Tin tức"),
            Map.entry("TALK", "Diễn thuyết"),
            Map.entry("LITERATURE", "Văn học"),
            Map.entry("DIALOGUE", "Hội thoại"),
            Map.entry("COMEDY", "Hài hước"),
            Map.entry("POETRY", "Thơ ca")
    );

    private static final Set<String> CHALLENGE_GENRES = Set.of(
            "LITERATURE", "DIALOGUE", "COMEDY", "POETRY"
    );

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

    public boolean isParagraphModeEnabled() {
        return paragraphModeEnabled;
    }

    public void setParagraphModeEnabled(boolean enabled) {
        this.paragraphModeEnabled = enabled;
    }

    private record CachedCatalogMetadata(
            long totalEligible,
            List<ParagraphGenreCountDto> availableGenres,
            List<ParagraphTopicCountDto> topics,
            ParagraphDifficultyDto difficulty,
            long cachedAtEpochMs
    ) {}

    private static final long CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000L; // 24-hour TTL for static corpus catalog
    private final java.util.concurrent.atomic.AtomicReference<CachedCatalogMetadata> catalogCache = new java.util.concurrent.atomic.AtomicReference<>();
    private final Object cacheLock = new Object();

    public void invalidateCatalogCache() {
        catalogCache.set(null);
    }

    @org.springframework.context.event.EventListener(org.springframework.boot.context.event.ApplicationReadyEvent.class)
    public void warmCatalogCache() {
        try {
            getOrComputeGlobalMetadata();
        } catch (Exception e) {
            log.warn("Warm-up paragraph catalog cache deferred: {}", e.getMessage());
        }
    }

    private CachedCatalogMetadata getOrComputeGlobalMetadata() {
        CachedCatalogMetadata cached = catalogCache.get();
        long now = System.currentTimeMillis();
        if (cached != null && (now - cached.cachedAtEpochMs()) < CATALOG_CACHE_TTL_MS) {
            return cached;
        }

        synchronized (cacheLock) {
            cached = catalogCache.get();
            if (cached != null && (now - cached.cachedAtEpochMs()) < CATALOG_CACHE_TTL_MS) {
                return cached;
            }

            long totalEligible = 0;
            try {
                totalEligible = passageRepository.countEligiblePassages();
            } catch (Exception e) {
                log.warn("countEligiblePassages query error: {}", e.getMessage());
            }

            // 1. Available Genres from REAL eligible rows only
            List<Object[]> genreRows = passageRepository.findEligibleGenreCounts();
            List<ParagraphGenreCountDto> availableGenres = new ArrayList<>();
            long genreSum = 0;
            if (genreRows != null) {
                for (Object[] row : genreRows) {
                    String genre = (String) row[0];
                    Long count = ((Number) row[1]).longValue();
                    if (count > 0) {
                        genreSum += count;
                        availableGenres.add(ParagraphGenreCountDto.builder()
                                .genre(genre)
                                .displayName(GENRE_DISPLAY_NAMES.getOrDefault(genre, genre))
                                .count(count)
                                .challenge(CHALLENGE_GENRES.contains(genre))
                                .build());
                    }
                }
            }

            // 2. Topics from REAL eligible rows only
            List<Object[]> topicRows = passageRepository.findEligibleTopicCounts();
            List<ParagraphTopicCountDto> topics = new ArrayList<>();
            long topicSum = 0;
            if (topicRows != null) {
                for (Object[] row : topicRows) {
                    String topic = (String) row[0];
                    Long count = ((Number) row[1]).longValue();
                    if (count > 0) {
                        topicSum += count;
                        topics.add(ParagraphTopicCountDto.builder()
                                .topic(topic)
                                .displayName(TOPIC_DISPLAY_NAMES.getOrDefault(topic, topic))
                                .count(count)
                                .build());
                    }
                }
            }

            // Fallback to topicSum or genreSum if countEligiblePassages was 0
            if (totalEligible == 0) {
                totalEligible = topicSum > 0 ? topicSum : genreSum;
            }

            // 3. Difficulty state: strictly UNCALIBRATED, no fake IELTS bands
            ParagraphDifficultyDto difficulty = ParagraphDifficultyDto.builder()
                    .status("UNCALIBRATED")
                    .label("Chưa hiệu chuẩn")
                    .count(totalEligible)
                    .calibrated(false)
                    .build();

            CachedCatalogMetadata fresh = new CachedCatalogMetadata(totalEligible, availableGenres, topics, difficulty, now);
            catalogCache.set(fresh);
            log.info("Computed and cached paragraph corpus catalog: {} total eligible, {} genres, {} topics (TTL: 24h)",
                    totalEligible, availableGenres.size(), topics.size());
            return fresh;
        }
    }

    @Transactional(readOnly = true)
    public ParagraphCatalogResponse getCatalog(Long userId) {
        CachedCatalogMetadata meta = getOrComputeGlobalMetadata();

        // 4. Active user session summary if authenticated (single indexed lookup covering ACTIVE & IN_PROGRESS)
        ParagraphSessionSummaryDto activeSessionDto = null;
        if (userId != null) {
            Optional<TranslationParagraphSessionEntity> activeSession = sessionRepository
                    .findFirstByUserIdAndStatusInOrderByUpdatedAtDesc(userId, List.of("ACTIVE", "IN_PROGRESS"));
            if (activeSession.isPresent()) {
                TranslationParagraphSessionEntity s = activeSession.get();
                activeSessionDto = ParagraphSessionSummaryDto.builder()
                        .sessionId(s.getId())
                        .currentIndex(s.getCurrentIndex())
                        .totalItems(s.getTotalItems())
                        .filterGenre(s.getFilterGenre())
                        .filterTopic(s.getFilterTopic())
                        .updatedAt(s.getUpdatedAt())
                        .build();
            }
        }

        return ParagraphCatalogResponse.builder()
                .enabled(paragraphModeEnabled)
                .totalEligiblePassages(meta.totalEligible())
                .availableGenres(meta.availableGenres())
                .topics(meta.topics())
                .difficulty(meta.difficulty())
                .activeSession(activeSessionDto)
                .build();
    }

    @Transactional(readOnly = true)
    public Page<ParagraphPassageSummaryDto> getPassagesPaged(String genre, String topic, Pageable pageable) {
        Page<TranslationParagraphPassageRepository.PassageSummaryProjection> page =
                passageRepository.findEligibleSummaryPaged(genre, topic, pageable);
        return page.map(p -> ParagraphPassageSummaryDto.builder()
                .id(p.getId())
                .genre(p.getGenre())
                .topic(p.getTopic())
                .difficultyStatus(p.getDifficultyStatus())
                .sourceViExcerpt(truncateExcerpt(p.getSourceVi(), 120))
                .referenceEnExcerpt(truncateExcerpt(p.getReferenceEn(), 120))
                .sourceTitle(p.getSourceTitle() != null ? p.getSourceTitle() : "")
                .attributionText(p.getAttributionText())
                .licenseCode(p.getLicenseCode())
                .build());
    }

    private String truncateExcerpt(String text, int maxLen) {
        if (text == null) return "";
        if (text.length() <= maxLen) return text;
        return text.substring(0, maxLen) + "...";
    }
}
