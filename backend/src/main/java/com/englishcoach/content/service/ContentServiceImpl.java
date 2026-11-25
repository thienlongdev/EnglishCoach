package com.englishcoach.content.service;

import com.englishcoach.content.config.ContentCacheConfig;
import com.englishcoach.content.dto.*;
import com.englishcoach.content.entity.*;
import com.englishcoach.content.repository.*;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.repository.TranscriptSegmentRepository;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Slf4j
@Service
@RequiredArgsConstructor
public class ContentServiceImpl implements ContentService {

    private static final Pattern YOUTUBE_URL_PATTERN =
            Pattern.compile("(?:youtu\\.be/|youtube\\.com/(?:embed/|v/|watch\\?v=|watch\\?.+&v=))([A-Za-z0-9_-]{11})");

    private final FeedArticleRepository feedArticleRepository;
    private final ReadingContentRepository readingContentRepository;
    private final ListeningContentRepository listeningContentRepository;
    private final ContentVocabularyRepository contentVocabularyRepository;
    private final ListeningMaterialRepository listeningMaterialRepository;
    private final TranscriptSegmentRepository transcriptSegmentRepository;
    private final ReadingMaterialRepository readingMaterialRepository;
    private final Clock clock;
    private final com.englishcoach.content.config.RssProperties rssProperties;
    private final Set<String> warnedFallbacks = java.util.concurrent.ConcurrentHashMap.newKeySet();

    @org.springframework.beans.factory.annotation.Value("${content.hub.show-seed-listening:false}")
    private boolean showSeedListening = false;

    public void setShowSeedListening(boolean showSeedListening) {
        this.showSeedListening = showSeedListening;
    }

    private void logFallbackWarn(String kind, LocalDate date, String reason, Throwable cause) {
        String key = kind + ":" + (date != null ? date.toString() : "today");
        if (warnedFallbacks.add(key)) {
            if (cause != null) {
                log.warn("Falling back to SEED for kind='{}' date={}: {} - {}", kind, date, cause.getClass().getName(), cause.getMessage());
                log.debug("Stack trace for library {} resolution failure:", kind, cause);
            } else {
                log.warn("Falling back to SEED for kind='{}' date={}: {}", kind, date, reason);
            }
        }
    }

    @Override
    @Transactional(readOnly = true)
    @Cacheable(value = ContentCacheConfig.CACHE_FEED)
    public List<FeedArticleDto> getFeed() {
        List<FeedArticle> window = feedArticleRepository.findTop40ByOrderByPublishedAtDesc();
        if (window == null || window.isEmpty()) {
            return new ArrayList<>();
        }

        int freshnessDays = (rssProperties != null && rssProperties.getFreshnessDays() > 0) ? rssProperties.getFreshnessDays() : 14;
        int maxAgeDays = (rssProperties != null && rssProperties.getMaxAgeDays() > 0) ? rssProperties.getMaxAgeDays() : 30;

        java.time.Instant now = java.time.Instant.now(clock);
        java.time.Instant freshCutoff = now.minus(freshnessDays, java.time.temporal.ChronoUnit.DAYS);
        java.time.Instant maxAgeCutoff = now.minus(maxAgeDays, java.time.temporal.ChronoUnit.DAYS);

        List<FeedArticle> freshLiveRows = new ArrayList<>();
        List<FeedArticle> olderLiveRows = new ArrayList<>();
        List<FeedArticle> seedRows = new ArrayList<>();

        for (FeedArticle a : window) {
            boolean isSeed = a.getProviderKey() == null || "seed".equalsIgnoreCase(a.getProviderKey());
            if (isSeed) {
                seedRows.add(a);
            } else {
                java.time.Instant pub = a.getPublishedAt();
                if (pub != null) {
                    if (!pub.isBefore(freshCutoff)) {
                        freshLiveRows.add(a);
                    } else if (!pub.isBefore(maxAgeCutoff)) {
                        olderLiveRows.add(a);
                    }
                }
            }
        }

        Set<Long> pickedIds = new LinkedHashSet<>();
        List<FeedArticle> picked = new ArrayList<>();

        // 1. Fresh live rows: newest per source first
        Set<String> seenSources = new HashSet<>();
        for (FeedArticle a : freshLiveRows) {
            String src = a.getSource() != null ? a.getSource().trim().toLowerCase() : "";
            if (seenSources.add(src)) {
                if (pickedIds.add(a.getId())) {
                    picked.add(a);
                    if (picked.size() == 4) break;
                }
            }
        }

        // 2. Fresh live rows: fill remaining slots by date
        if (picked.size() < 4) {
            for (FeedArticle a : freshLiveRows) {
                if (pickedIds.add(a.getId())) {
                    picked.add(a);
                    if (picked.size() == 4) break;
                }
            }
        }

        // 3. Older live rows within max-age-days: fill remaining slots by date
        if (picked.size() < 4) {
            for (FeedArticle a : olderLiveRows) {
                if (pickedIds.add(a.getId())) {
                    picked.add(a);
                    if (picked.size() == 4) break;
                }
            }
        }

        // 4. Seed rows: fill remaining slots up to 4
        if (picked.size() < 4) {
            for (FeedArticle a : seedRows) {
                if (pickedIds.add(a.getId())) {
                    picked.add(a);
                    if (picked.size() == 4) break;
                }
            }
        }

        picked.sort(Comparator.comparing(FeedArticle::getPublishedAt, Comparator.nullsLast(Comparator.reverseOrder())));
        return picked.stream().map(this::mapToFeedArticleDto).toList();
    }

    @Override
    @Transactional(readOnly = true)
    @Cacheable(
            value = ContentCacheConfig.CACHE_LISTENING_TODAY,
            key = "#date != null ? #date.toString() : 'today'",
            unless = "#result == null || !'LIBRARY'.equalsIgnoreCase(#result.source)"
    )
    public Optional<ListeningTodayDto> getListeningToday(LocalDate date) {
        LocalDate effectiveDate = (date != null) ? date : LocalDate.now(clock);
        String fallbackReason = null;
        Throwable caughtEx = null;

        try {
            List<ListeningMaterial> systemMaterials = listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc();
            List<ListeningMaterial> eligible = systemMaterials.stream()
                    .filter(this::isEligibleListeningMaterial)
                    .toList();

            if (!eligible.isEmpty()) {
                long epochDay = effectiveDate.toEpochDay();
                int index = (int) Math.floorMod(epochDay, eligible.size());
                ListeningMaterial chosen = eligible.get(index);
                String videoId = extractYouTubeVideoId(chosen.getAudioUrl());
                if (videoId == null && chosen.getYoutubeVideoId() != null) {
                    videoId = chosen.getYoutubeVideoId();
                }
                String thumbnail = chosen.getThumbnail();
                if ((thumbnail == null || thumbnail.isBlank()) && videoId != null) {
                    thumbnail = "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg";
                }
                String channel = (chosen.getChannel() != null && !chosen.getChannel().isBlank())
                        ? chosen.getChannel()
                        : "English Coach Studio";

                boolean hasTranscript = false;
                if (transcriptSegmentRepository != null) {
                    hasTranscript = transcriptSegmentRepository.existsByListeningMaterialId(chosen.getId());
                }

                return Optional.of(ListeningTodayDto.builder()
                        .id(chosen.getId())
                        .source("LIBRARY")
                        .kind("LISTENING")
                        .title(chosen.getTitle())
                        .channel(channel)
                        .topic(chosen.getTopic() != null ? chosen.getTopic() : "General")
                        .level(chosen.getCefrLevel() != null ? chosen.getCefrLevel() : "B1")
                        .accent(chosen.getAccent() != null ? chosen.getAccent() : "American")
                        .durationSeconds(chosen.getDurationSeconds() != null ? chosen.getDurationSeconds() : 0)
                        .audioUrl(chosen.getAudioUrl())
                        .thumbnail(thumbnail)
                        .youtubeVideoId(videoId)
                        .hasTranscript(hasTranscript)
                        .deepLink("/listening/" + chosen.getId())
                        .build());
            } else {
                fallbackReason = "No eligible system listening materials found (system count=" + systemMaterials.size() + ")";
            }
        } catch (Exception e) {
            caughtEx = e;
            fallbackReason = e.getClass().getName() + ": " + e.getMessage();
        }

        if (!showSeedListening) {
            log.info("No eligible library listening material found and showSeedListening=false; returning empty (204)");
            return Optional.empty();
        }

        logFallbackWarn("LISTENING", effectiveDate, fallbackReason, caughtEx);

        // Fallback to Phase 1 seed row (not cached due to 'unless' condition)
        Optional<ListeningContent> fallback = listeningContentRepository
                .findFirstByKindAndFeaturedOnLessThanEqualOrderByFeaturedOnDescIdDesc("LISTENING", effectiveDate);
        if (fallback.isEmpty()) {
            fallback = listeningContentRepository.findFirstByKindOrderByCreatedAtDescIdDesc("LISTENING");
        }
        return fallback.map(l -> mapToListeningTodayDto(l, "/listening"));
    }

    @Override
    @Transactional(readOnly = true)
    @Cacheable(
            value = ContentCacheConfig.CACHE_DICTATION_TODAY,
            key = "#date != null ? #date.toString() : 'today'",
            unless = "#result == null || !'LIBRARY'.equalsIgnoreCase(#result.source)"
    )
    public Optional<DictationTodayDto> getDictationToday(LocalDate date) {
        LocalDate effectiveDate = (date != null) ? date : LocalDate.now(clock);
        String fallbackReason = null;
        Throwable caughtEx = null;

        try {
            List<ListeningMaterial> systemMaterials = listeningMaterialRepository.findSystemMaterialsWithSegmentsAndExercises();
            List<ListeningMaterial> eligible = systemMaterials.stream()
                    .filter(this::isEligibleListeningMaterial)
                    .toList();

            if (!eligible.isEmpty()) {
                long epochDay = effectiveDate.toEpochDay();
                int listeningIdx = (int) Math.floorMod(epochDay, eligible.size());
                int baseDictationIdx = listeningIdx;
                if (eligible.size() > 1) {
                    baseDictationIdx = (listeningIdx + 1) % eligible.size();
                }

                // Try candidate materials starting from baseDictationIdx
                for (int offset = 0; offset < eligible.size(); offset++) {
                    int curIdx = (baseDictationIdx + offset) % eligible.size();
                    ListeningMaterial candidate = eligible.get(curIdx);
                    String videoId = extractYouTubeVideoId(candidate.getAudioUrl());
                    if (videoId == null && candidate.getYoutubeVideoId() != null) {
                        videoId = candidate.getYoutubeVideoId();
                    }
                    if (videoId == null) continue;

                    List<TranscriptSegment> segments = null;
                    if (transcriptSegmentRepository != null) {
                        segments = transcriptSegmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(candidate.getId());
                    }
                    if (segments == null || segments.isEmpty()) continue;

                    List<DictationSegmentSelector.Cue> cues = segments.stream()
                            .map(s -> new DictationSegmentSelector.Cue(
                                    s.getId(),
                                    (s.getStartTimeMs() != null ? s.getStartTimeMs() : 0) / 1000.0,
                                    (s.getEndTimeMs() != null ? s.getEndTimeMs() : 0) / 1000.0,
                                    s.getText() != null ? s.getText() : ""
                            ))
                            .toList();

                    long seed = epochDay + (long) videoId.hashCode();
                    Optional<DictationSegmentSelector.DictationSegment> segOpt = DictationSegmentSelector.selectSegment(cues, seed);

                    if (segOpt.isPresent()) {
                        DictationSegmentSelector.DictationSegment seg = segOpt.get();
                        String deepLink = "/listening/" + candidate.getId() + "/practice?segment=" + seg.segmentId();
                        return Optional.of(DictationTodayDto.builder()
                                .id(candidate.getId())
                                .segmentId(seg.segmentId())
                                .source("LIBRARY")
                                .title(candidate.getTitle())
                                .level(candidate.getCefrLevel() != null ? candidate.getCefrLevel() : "B1")
                                .accent(candidate.getAccent() != null ? candidate.getAccent() : "American")
                                .topic(candidate.getTopic() != null ? candidate.getTopic() : "General")
                                .youtubeVideoId(videoId)
                                .startSeconds(seg.startSeconds())
                                .endSeconds(seg.endSeconds())
                                .durationSeconds(seg.durationSeconds())
                                .transcriptHidden(true)
                                .transcript(null) // Never leak transcript text!
                                .deepLink(deepLink)
                                .build());
                    }
                }
                fallbackReason = "No segment in eligible library materials qualified for dictation";
            } else {
                fallbackReason = "No eligible system listening materials found (system count=" + systemMaterials.size() + ")";
            }
        } catch (Exception e) {
            caughtEx = e;
            fallbackReason = e.getClass().getName() + ": " + e.getMessage();
        }

        if (!showSeedListening) {
            log.info("No eligible library dictation material found and showSeedListening=false; returning empty (204)");
            return Optional.empty();
        }

        logFallbackWarn("DICTATION", effectiveDate, fallbackReason, caughtEx);

        // Fallback to Phase 1 seed row (not cached due to 'unless' condition)
        Optional<ListeningContent> fallback = listeningContentRepository
                .findFirstByKindAndFeaturedOnLessThanEqualOrderByFeaturedOnDescIdDesc("DICTATION", effectiveDate);
        if (fallback.isEmpty()) {
            fallback = listeningContentRepository.findFirstByKindOrderByCreatedAtDescIdDesc("DICTATION");
        }
        return fallback.map(d -> mapToDictationTodayDto(d, "/listening"));
    }

    /**
     * This bean through its proxy: a call from inside the class to {@link #getDailyVocabulary} would not reach the cache
     * (performance release 2026-11-16, PERF-20: the dateless request recomputed the whole selection every time).
     */
    @org.springframework.beans.factory.annotation.Autowired
    @org.springframework.context.annotation.Lazy
    private ContentService self;

    /**
     * Only the days a learner can be on right now are cached (the date is a public request parameter: caching every date
     * asked for would let the map grow without bound). Other dates are computed, not stored.
     */
    public boolean cacheableDay(LocalDate date) {
        if (date == null) return true;
        long today = LocalDate.now(clock).toEpochDay();
        return Math.abs(date.toEpochDay() - today) <= 2;
    }

    @Override
    public List<TrendingVocabularyDto> getTrendingVocabulary() {
        LocalDate today = LocalDate.now(clock);
        return self != null ? self.getDailyVocabulary(today) : getDailyVocabulary(today);
    }

    @Override
    @Transactional(readOnly = true)
    @Cacheable(
            value = ContentCacheConfig.CACHE_TRENDING_VOCAB,
            key = "#date != null ? #date.toString() : 'today'",
            condition = "#root.target.cacheableDay(#date)",
            unless = "#result == null || #result.isEmpty()"
    )
    public List<TrendingVocabularyDto> getDailyVocabulary(LocalDate date) {
        LocalDate effectiveDate = (date != null) ? date : LocalDate.now(clock);
        long epochDay = effectiveDate.toEpochDay();

        List<ContentVocabulary> candidates = contentVocabularyRepository.findAllEligibleDailyVocabulary();
        if (candidates == null || candidates.isEmpty()) {
            return new ArrayList<>();
        }

        // Deterministic date-seeded scoring using stable IDs (64-bit SplitMix-style hash mixer).
        // No expensive ORDER BY random() over large tables.
        List<ContentVocabulary> sorted = new ArrayList<>(candidates);
        sorted.sort(Comparator.comparingLong((ContentVocabulary cv) -> hash64(cv.getId() != null ? cv.getId() : 0L, epochDay))
                .thenComparing(cv -> cv.getId() != null ? cv.getId() : 0L));

        Set<String> seenWords = new HashSet<>();
        List<TrendingVocabularyDto> result = new ArrayList<>(5);
        for (ContentVocabulary cv : sorted) {
            if (cv.getWord() == null || cv.getWord().isBlank() || cv.getMeaning() == null || cv.getMeaning().isBlank()) {
                continue;
            }
            String normalized = cv.getWord().trim().toLowerCase();
            if (seenWords.add(normalized)) {
                result.add(mapToTrendingVocabularyDto(cv));
                if (result.size() >= 5) {
                    break;
                }
            }
        }

        return result;
    }

    /**
     * Deterministic 64-bit SplitMix-style hash mixer for date-seeded stable ordering.
     */
    public static long hash64(long id, long epochDay) {
        long z = (id ^ (epochDay * 0x9E3779B97F4A7C15L));
        z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
        z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
        return z ^ (z >>> 31);
    }

    @Override
    @Transactional(readOnly = true)
    public ReadingArticleDto getReadingContent(Long articleId) {
        return getReadingContent(articleId, null);
    }

    @Override
    @Transactional(readOnly = true)
    public ReadingArticleDto getReadingContent(Long articleId, Long userId) {
        if (articleId == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Article ID must not be null");
        }

        FeedArticle article = feedArticleRepository.findById(articleId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Article not found with id: " + articleId));

        Optional<ReadingContent> rcOpt = readingContentRepository.findBySourceArticleId(articleId);

        String contentMode;
        String content;
        String level;
        int wordCount;

        if (rcOpt.isPresent()) {
            ReadingContent rc = rcOpt.get();
            contentMode = "FULL_TEXT";
            content = rc.getContent();
            level = rc.getLevel() != null ? rc.getLevel() : article.getLevel();
            wordCount = rc.getWordCount() > 0 ? rc.getWordCount() : countWords(content);
        } else {
            contentMode = "SUMMARY_LINK";
            content = article.getSummary() != null ? article.getSummary() : "";
            level = article.getLevel();
            wordCount = countWords(content);
        }

        boolean isSaved = false;
        if (userId != null) {
            isSaved = readingMaterialRepository.findByOwnerUserIdAndOriginFeedArticleId(userId, articleId).isPresent();
        }

        List<ContentVocabulary> vocabulary = contentVocabularyRepository.findByContentTypeAndContentId("ARTICLE", articleId);
        List<ContentVocabularyDto> vocabDtos = (vocabulary != null)
                ? vocabulary.stream().map(this::mapToContentVocabularyDto).toList()
                : new ArrayList<>();

        return ReadingArticleDto.builder()
                .articleId(article.getId())
                .title(article.getTitle())
                .source(article.getSource())
                .url(article.getUrl())
                .sourceUrl(article.getUrl())
                .level(level)
                .wordCount(wordCount)
                .readMinutes(article.getReadMinutes())
                .content(content)
                .contentMode(contentMode)
                .saved(isSaved)
                .vocabulary(vocabDtos)
                .build();
    }

    @Override
    @Transactional
    public SaveReadingResponseDto saveReadingArticle(Long articleId, Long userId) {
        if (articleId == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Article ID must not be null");
        }
        if (userId == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to save reading material");
        }

        FeedArticle article = feedArticleRepository.findById(articleId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Article not found with id: " + articleId));

        // Check if already saved by user
        Optional<ReadingMaterial> existing = readingMaterialRepository.findByOwnerUserIdAndOriginFeedArticleId(userId, articleId);
        if (existing.isPresent()) {
            return SaveReadingResponseDto.builder()
                    .saved(true)
                    .alreadySaved(true)
                    .libraryArticleId(existing.get().getId())
                    .build();
        }

        Optional<ReadingContent> rcOpt = readingContentRepository.findBySourceArticleId(articleId);
        String contentMode = rcOpt.isPresent() ? "FULL_TEXT" : "SUMMARY_LINK";
        String content = rcOpt.isPresent() ? rcOpt.get().getContent() : article.getSummary();
        int wordCount = rcOpt.isPresent() ? rcOpt.get().getWordCount() : countWords(content);
        String level = rcOpt.map(ReadingContent::getLevel).orElse(article.getLevel());

        ReadingMaterial newMaterial = ReadingMaterial.builder()
                .title(article.getTitle())
                .sourceName(article.getSource())
                .sourceUrl(article.getUrl())
                .materialType(ReadingMaterial.MaterialType.ARTICLE)
                .contentText(content)
                .wordCount(wordCount)
                .difficultyLevel(level)
                .contentMode(contentMode)
                .originFeedArticleId(articleId)
                .ownerUserId(userId)
                .isSystem(false)
                .createdAt(LocalDateTime.now())
                .build();

        try {
            ReadingMaterial savedMat = readingMaterialRepository.save(newMaterial);
            return SaveReadingResponseDto.builder()
                    .saved(true)
                    .alreadySaved(false)
                    .libraryArticleId(savedMat.getId())
                    .build();
        } catch (DataIntegrityViolationException dive) {
            // Race condition: re-select and return 200 alreadySaved
            ReadingMaterial found = readingMaterialRepository.findByOwnerUserIdAndOriginFeedArticleId(userId, articleId)
                    .orElseThrow(() -> dive);
            return SaveReadingResponseDto.builder()
                    .saved(true)
                    .alreadySaved(true)
                    .libraryArticleId(found.getId())
                    .build();
        }
    }

    private boolean isEligibleListeningMaterial(ListeningMaterial m) {
        if (m == null || !m.isSystem() || m.getOwnerUserId() != null) return false;
        if (m.getTitle() == null || m.getTitle().isBlank()) return false;
        String videoId = extractYouTubeVideoId(m.getAudioUrl());
        return videoId != null && videoId.matches("^[A-Za-z0-9_-]{11}$");
    }

    public static String extractYouTubeVideoId(String url) {
        if (url == null || url.isBlank()) return null;
        String clean = url.trim();
        if (clean.matches("^[A-Za-z0-9_-]{11}$")) {
            return clean;
        }
        Matcher matcher = YOUTUBE_URL_PATTERN.matcher(clean);
        if (matcher.find()) {
            return matcher.group(1);
        }
        return null;
    }

    private static int countWords(String text) {
        if (text == null || text.isBlank()) return 0;
        return text.trim().split("\\s+").length;
    }

    private FeedArticleDto mapToFeedArticleDto(FeedArticle a) {
        return FeedArticleDto.builder()
                .id(a.getId())
                .source(a.getSource())
                .title(a.getTitle())
                .url(a.getUrl())
                .thumbnail(a.getThumbnail())
                .summary(a.getSummary())
                .category(a.getCategory())
                .level(a.getLevel())
                .readMinutes(a.getReadMinutes())
                .publishedAt(a.getPublishedAt())
                .build();
    }

    private ListeningTodayDto mapToListeningTodayDto(ListeningContent l, String deepLink) {
        boolean hasTranscript = l.getTranscript() != null && !l.getTranscript().isBlank();
        return ListeningTodayDto.builder()
                .id(l.getId())
                .source("SEED")
                .kind(l.getKind())
                .title(l.getTitle())
                .channel(l.getChannel())
                .topic(l.getTopic())
                .level(l.getLevel())
                .accent(l.getAccent())
                .durationSeconds(l.getDuration())
                .audioUrl(l.getAudioUrl())
                .thumbnail(l.getThumbnail())
                .youtubeVideoId(l.getYoutubeVideoId())
                .hasTranscript(hasTranscript)
                .deepLink(deepLink != null ? deepLink : "/listening")
                .build();
    }

    private DictationTodayDto mapToDictationTodayDto(ListeningContent d, String deepLink) {
        return DictationTodayDto.builder()
                .id(d.getId())
                .source("SEED")
                .title(d.getTitle())
                .level(d.getLevel())
                .accent(d.getAccent())
                .topic(d.getTopic())
                .durationSeconds(d.getDuration())
                .audioUrl(d.getAudioUrl())
                .youtubeVideoId(d.getYoutubeVideoId())
                .startSeconds(0)
                .endSeconds(d.getDuration() != null ? d.getDuration() : 20)
                .transcriptHidden(true)
                .transcript(null) // Never leak transcript text!
                .deepLink(deepLink != null ? deepLink : "/listening")
                .build();
    }

    private TrendingVocabularyDto mapToTrendingVocabularyDto(ContentVocabulary v) {
        return TrendingVocabularyDto.builder()
                .id(v.getId())
                .word(v.getWord())
                .lemma(v.getLemma())
                .phonetic(v.getPhonetic())
                .meaning(v.getMeaning())
                .exampleSentence(v.getExampleSentence())
                .frequency(v.getFrequency())
                .build();
    }

    private ContentVocabularyDto mapToContentVocabularyDto(ContentVocabulary v) {
        return ContentVocabularyDto.builder()
                .id(v.getId())
                .word(v.getWord())
                .lemma(v.getLemma())
                .phonetic(v.getPhonetic())
                .meaning(v.getMeaning())
                .exampleSentence(v.getExampleSentence())
                .frequency(v.getFrequency())
                .build();
    }
}
