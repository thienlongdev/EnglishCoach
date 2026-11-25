package com.englishcoach.content.service;

import com.englishcoach.content.config.ContentCacheConfig;
import com.englishcoach.content.dto.NormalizedArticleItem;
import com.englishcoach.content.dto.NormalizedListeningItem;
import com.englishcoach.content.dto.NormalizedVideoItem;
import com.englishcoach.content.dto.NormalizedVocabularyItem;
import com.englishcoach.content.entity.*;
import com.englishcoach.content.repository.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class ContentIngestionServiceImpl implements ContentIngestionService {

    private final FeedArticleRepository feedArticleRepository;
    private final ReadingContentRepository readingContentRepository;
    private final YoutubeFeedRepository youtubeFeedRepository;
    private final ListeningContentRepository listeningContentRepository;
    private final ContentVocabularyRepository contentVocabularyRepository;
    private final CacheManager cacheManager;
    private final com.englishcoach.content.config.RssProperties rssProperties;

    @Override
    @Transactional
    public int ingestFromProvider(ContentProvider provider) {
        if (provider == null) {
            return 0;
        }
        int count = 0;

        List<NormalizedArticleItem> articles = provider.fetchArticles();
        if (articles != null) {
            for (NormalizedArticleItem a : articles) {
                if (ingestArticle(a)) {
                    count++;
                }
            }
        }

        List<NormalizedVideoItem> videos = provider.fetchVideos();
        if (videos != null) {
            for (NormalizedVideoItem v : videos) {
                if (ingestVideo(v)) {
                    count++;
                }
            }
        }

        List<NormalizedListeningItem> listeningItems = provider.fetchListeningItems();
        if (listeningItems != null) {
            for (NormalizedListeningItem l : listeningItems) {
                if (ingestListening(l)) {
                    count++;
                }
            }
        }

        evictCaches();
        return count;
    }

    @Override
    @Transactional
    public boolean ingestArticle(NormalizedArticleItem item) {
        if (item == null || item.getUrl() == null || item.getTitle() == null) {
            return false;
        }

        int maxAge = (rssProperties != null && rssProperties.getMaxAgeDays() > 0) ? rssProperties.getMaxAgeDays() : 30;
        java.time.Instant maxAgeCutoff = java.time.Instant.now().minus(maxAge, java.time.temporal.ChronoUnit.DAYS);
        if (item.getPublishedAt() != null && item.getPublishedAt().isBefore(maxAgeCutoff)) {
            log.info("Skipping article older than max-age-days ({}): {} ({})", maxAge, item.getTitle(), item.getPublishedAt());
            return false;
        }

        if (feedArticleRepository.existsByUrl(item.getUrl())) {
            log.info("Skipping duplicate feed article URL: {}", item.getUrl());
            return false;
        }

        FeedArticle article = FeedArticle.builder()
                .providerKey(item.getProviderKey())
                .source(item.getSource() != null ? item.getSource() : "Unknown")
                .title(item.getTitle())
                .url(item.getUrl())
                .thumbnail(item.getThumbnail())
                .summary(item.getSummary())
                .category(item.getCategory())
                .level(item.getLevel() != null ? item.getLevel() : "B1")
                .readMinutes(item.getReadMinutes() != null ? item.getReadMinutes() : 3)
                .publishedAt(item.getPublishedAt() != null ? item.getPublishedAt() : java.time.Instant.now())
                .build();

        FeedArticle saved;
        try {
            saved = feedArticleRepository.save(article);
        } catch (org.springframework.dao.DataIntegrityViolationException dive) {
            log.info("Duplicate URL caught during insert race: {}", item.getUrl());
            return false;
        }

        if (item.getReadingContent() != null && !item.getReadingContent().isBlank()) {
            int wordCount = item.getReadingContent().trim().split("\\s+").length;
            ReadingContent rc = ReadingContent.builder()
                    .sourceArticleId(saved.getId())
                    .title(saved.getTitle())
                    .content(item.getReadingContent())
                    .wordCount(wordCount)
                    .level(saved.getLevel())
                    .build();
            readingContentRepository.save(rc);
        }

        if (item.getVocabulary() != null && !item.getVocabulary().isEmpty()) {
            for (NormalizedVocabularyItem v : item.getVocabulary()) {
                ContentVocabulary cv = ContentVocabulary.builder()
                        .contentType("ARTICLE")
                        .contentId(saved.getId())
                        .word(v.getWord())
                        .lemma(v.getLemma())
                        .phonetic(v.getPhonetic())
                        .meaning(v.getMeaning())
                        .exampleSentence(v.getExampleSentence())
                        .frequency(v.getFrequency() != null ? v.getFrequency() : 1)
                        .build();
                contentVocabularyRepository.save(cv);
            }
        }

        evictCaches();
        return true;
    }

    @Override
    @Transactional
    public boolean ingestVideo(NormalizedVideoItem item) {
        if (item == null || item.getVideoId() == null) {
            return false;
        }

        if (youtubeFeedRepository.existsByVideoId(item.getVideoId())) {
            log.info("Skipping duplicate YouTube video ID: {}", item.getVideoId());
            return false;
        }

        YoutubeFeed feed = YoutubeFeed.builder()
                .videoId(item.getVideoId())
                .title(item.getTitle() != null ? item.getTitle() : "Untitled")
                .channel(item.getChannel() != null ? item.getChannel() : "Unknown")
                .thumbnail(item.getThumbnail())
                .duration(item.getDuration())
                .publishedAt(item.getPublishedAt() != null ? item.getPublishedAt() : java.time.Instant.now())
                .build();

        youtubeFeedRepository.save(feed);
        evictCaches();
        return true;
    }

    @Override
    @Transactional
    public boolean ingestListening(NormalizedListeningItem item) {
        if (item == null || item.getTitle() == null) {
            return false;
        }

        ListeningContent content = ListeningContent.builder()
                .kind(item.getKind() != null ? item.getKind() : "LISTENING")
                .youtubeVideoId(item.getYoutubeVideoId())
                .title(item.getTitle())
                .channel(item.getChannel())
                .level(item.getLevel() != null ? item.getLevel() : "B1")
                .duration(item.getDuration() != null ? item.getDuration() : 0)
                .audioUrl(item.getAudioUrl())
                .thumbnail(item.getThumbnail())
                .transcript(item.getTranscript())
                .transcriptHidden(item.getTranscriptHidden() != null ? item.getTranscriptHidden() : false)
                .accent(item.getAccent())
                .topic(item.getTopic())
                .featuredOn(item.getFeaturedOn())
                .build();

        listeningContentRepository.save(content);
        evictCaches();
        return true;
    }

    @Override
    @Transactional
    public int pruneOldFeedArticles() {
        try {
            int maxAge = (rssProperties != null && rssProperties.getMaxAgeDays() > 0) ? rssProperties.getMaxAgeDays() : 30;
            java.time.Instant cutoff = java.time.Instant.now().minus(maxAge, java.time.temporal.ChronoUnit.DAYS);
            int pruned = feedArticleRepository.pruneOldArticles(cutoff);
            if (pruned > 0) {
                log.info("Pruned {} feed articles older than {} days", pruned, maxAge);
            }
            return pruned;
        } catch (Exception e) {
            log.warn("Failed to prune old feed articles: {}", e.getMessage());
            return 0;
        }
    }

    @Override
    public void evictCaches() {
        if (cacheManager == null) return;
        String[] caches = {
                ContentCacheConfig.CACHE_FEED,
                ContentCacheConfig.CACHE_LISTENING_TODAY,
                ContentCacheConfig.CACHE_DICTATION_TODAY,
                ContentCacheConfig.CACHE_TRENDING_VOCAB,
                ContentCacheConfig.CACHE_READING
        };
        for (String cName : caches) {
            Cache c = cacheManager.getCache(cName);
            if (c != null) {
                c.clear();
            }
        }
    }
}
