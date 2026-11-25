package com.englishcoach.content.service;

import com.englishcoach.content.dto.*;
import com.englishcoach.content.entity.*;
import com.englishcoach.content.repository.*;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.cache.Cache;
import org.springframework.cache.CacheManager;
import org.springframework.dao.DataIntegrityViolationException;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ContentIngestionServiceTest {

    @Mock
    private FeedArticleRepository feedArticleRepository;

    @Mock
    private ReadingContentRepository readingContentRepository;

    @Mock
    private YoutubeFeedRepository youtubeFeedRepository;

    @Mock
    private ListeningContentRepository listeningContentRepository;

    @Mock
    private ContentVocabularyRepository contentVocabularyRepository;

    @Mock
    private CacheManager cacheManager;

    @Mock
    private Cache cache;

    @Mock
    private com.englishcoach.content.config.RssProperties rssProperties;

    @InjectMocks
    private ContentIngestionServiceImpl contentIngestionService;

    @BeforeEach
    void setUp() {
        lenient().when(cacheManager.getCache(anyString())).thenReturn(cache);
        lenient().when(rssProperties.getMaxAgeDays()).thenReturn(30);
    }

    @Test
    @DisplayName("Ingestion: with an in-memory fake ContentProvider, duplicate url / video_id is not inserted twice")
    void testIngestFromProviderWithDeduplication() {
        ContentProvider fakeProvider = new ContentProvider() {
            @Override
            public String providerKey() {
                return "in_memory_fake";
            }

            @Override
            public List<NormalizedArticleItem> fetchArticles() {
                return List.of(
                        NormalizedArticleItem.builder()
                                .source("BBC")
                                .title("Article One")
                                .url("https://bbc.com/article-1")
                                .readingContent("Sample content for article one with vocabulary.")
                                .vocabulary(List.of(
                                        NormalizedVocabularyItem.builder().word("sample").meaning("mẫu").build()
                                ))
                                .build(),
                        NormalizedArticleItem.builder()
                                .source("BBC")
                                .title("Article Two")
                                .url("https://bbc.com/article-2")
                                .build()
                );
            }

            @Override
            public List<NormalizedVideoItem> fetchVideos() {
                return List.of(
                        NormalizedVideoItem.builder()
                                .videoId("vid123")
                                .title("Video 1")
                                .channel("Test Channel")
                                .build()
                );
            }

            @Override
            public List<NormalizedListeningItem> fetchListeningItems() {
                return List.of(
                        NormalizedListeningItem.builder()
                                .kind("LISTENING")
                                .title("Podcast Episode")
                                .featuredOn(LocalDate.now())
                                .build()
                );
            }
        };

        when(feedArticleRepository.existsByUrl("https://bbc.com/article-1")).thenReturn(false);
        when(feedArticleRepository.existsByUrl("https://bbc.com/article-2")).thenReturn(false);
        when(youtubeFeedRepository.existsByVideoId("vid123")).thenReturn(false);

        FeedArticle savedArticle1 = FeedArticle.builder().id(100L).title("Article One").url("https://bbc.com/article-1").build();
        FeedArticle savedArticle2 = FeedArticle.builder().id(101L).title("Article Two").url("https://bbc.com/article-2").build();
        when(feedArticleRepository.save(any(FeedArticle.class)))
                .thenReturn(savedArticle1)
                .thenReturn(savedArticle2);

        int countPass1 = contentIngestionService.ingestFromProvider(fakeProvider);

        assertThat(countPass1).isEqualTo(4);
        verify(feedArticleRepository, times(2)).save(any(FeedArticle.class));
        verify(youtubeFeedRepository, times(1)).save(any(YoutubeFeed.class));
        verify(listeningContentRepository, times(1)).save(any(ListeningContent.class));
        verify(readingContentRepository, times(1)).save(any(ReadingContent.class));
        verify(contentVocabularyRepository, times(1)).save(any(ContentVocabulary.class));

        // Second pass: simulated rerun where articles already exist
        reset(feedArticleRepository, youtubeFeedRepository, listeningContentRepository, readingContentRepository, contentVocabularyRepository);
        when(feedArticleRepository.existsByUrl("https://bbc.com/article-1")).thenReturn(true);
        when(feedArticleRepository.existsByUrl("https://bbc.com/article-2")).thenReturn(true);
        when(youtubeFeedRepository.existsByVideoId("vid123")).thenReturn(true);

        int countPass2 = contentIngestionService.ingestFromProvider(fakeProvider);

        assertThat(countPass2).isEqualTo(1);
        verify(feedArticleRepository, never()).save(any(FeedArticle.class));
    }

    @Test
    @DisplayName("RSS Ingestion: deduplicates normalized URLs and evicts cache on new insertion")
    void testIngestRssArticles() {
        NormalizedArticleItem item1 = NormalizedArticleItem.builder()
                .source("BBC")
                .providerKey("bbc-world")
                .title("Item 1")
                .url("https://bbc.co.uk/news/1")
                .summary("Summary 1")
                .publishedAt(Instant.now())
                .build();

        NormalizedArticleItem item2 = NormalizedArticleItem.builder()
                .source("BBC")
                .providerKey("bbc-world")
                .title("Item 2 (Duplicate)")
                .url("https://bbc.co.uk/news/1") // same url
                .summary("Summary 2")
                .publishedAt(Instant.now())
                .build();

        when(feedArticleRepository.existsByUrl("https://bbc.co.uk/news/1"))
                .thenReturn(false)
                .thenReturn(true);

        FeedArticle saved = FeedArticle.builder().id(1L).title("Item 1").url("https://bbc.co.uk/news/1").build();
        when(feedArticleRepository.save(any(FeedArticle.class))).thenReturn(saved);

        boolean ok1 = contentIngestionService.ingestArticle(item1);
        boolean ok2 = contentIngestionService.ingestArticle(item2);

        assertThat(ok1).isTrue();
        assertThat(ok2).isFalse();
        verify(feedArticleRepository, times(1)).save(any(FeedArticle.class));
        verify(cache, atLeastOnce()).clear();
    }

    @Test
    @DisplayName("RSS Ingestion: handles unique violation exception safely as a duplicate skip")
    void testIngestRssArticlesUniqueViolation() {
        NormalizedArticleItem item = NormalizedArticleItem.builder()
                .source("The Guardian")
                .providerKey("guardian-world")
                .title("Item Unique Race")
                .url("https://theguardian.com/world/race-test")
                .summary("Summary")
                .publishedAt(Instant.now())
                .build();

        when(feedArticleRepository.existsByUrl(anyString())).thenReturn(false);
        when(feedArticleRepository.save(any(FeedArticle.class)))
                .thenThrow(new DataIntegrityViolationException("Unique constraint violation"));

        boolean ok = contentIngestionService.ingestArticle(item);

        assertThat(ok).isFalse();
    }

    @Test
    @DisplayName("RSS Ingestion: FULL_TEXT creates reading_content row when content is provided")
    void testIngestRssArticlesFullText() {
        NormalizedArticleItem item = NormalizedArticleItem.builder()
                .source("The Guardian")
                .providerKey("guardian-world")
                .title("Transit Story")
                .url("https://theguardian.com/world/transit")
                .summary("Short summary")
                .readingContent("Paragraph one.\n\nParagraph two.")
                .publishedAt(Instant.now())
                .build();

        when(feedArticleRepository.existsByUrl(anyString())).thenReturn(false);
        FeedArticle savedArticle = FeedArticle.builder().id(10L).title("Transit Story").url("https://theguardian.com/world/transit").build();
        when(feedArticleRepository.save(any(FeedArticle.class))).thenReturn(savedArticle);

        boolean ok = contentIngestionService.ingestArticle(item);

        assertThat(ok).isTrue();
        verify(readingContentRepository, times(1)).save(any(ReadingContent.class));
    }

    @Test
    @DisplayName("Pruning: pruneOldFeedArticles invokes repository prune method")
    void testPruneOldFeedArticles() {
        when(feedArticleRepository.pruneOldArticles(any(Instant.class))).thenReturn(5);

        int pruned = contentIngestionService.pruneOldFeedArticles();

        assertThat(pruned).isEqualTo(5);
        verify(feedArticleRepository, times(1)).pruneOldArticles(any(Instant.class));
    }

    @Test
    @DisplayName("Ingestion: skips items whose published_at is older than max-age-days (30 days)")
    void testIngestSkipsItemsOlderThanMaxAge() {
        NormalizedArticleItem staleItem = NormalizedArticleItem.builder()
                .source("VOA")
                .providerKey("voa-learning-english")
                .title("Stale March 2025 Story")
                .url("https://voa.com/stale-story")
                .summary("Old news from long ago")
                .publishedAt(Instant.now().minus(35, java.time.temporal.ChronoUnit.DAYS))
                .build();

        boolean ingested = contentIngestionService.ingestArticle(staleItem);

        assertThat(ingested).isFalse();
        verify(feedArticleRepository, never()).save(any(FeedArticle.class));
    }

    @Test
    @DisplayName("No insert/prune churn: stale items skipped on consecutive ingestion runs")
    void testNoInsertPruneChurnAcrossConsecutiveRuns() {
        NormalizedArticleItem staleItem = NormalizedArticleItem.builder()
                .source("VOA")
                .providerKey("voa-learning-english")
                .title("Stale VOA Article")
                .url("https://voa.com/stale-article")
                .publishedAt(Instant.now().minus(40, java.time.temporal.ChronoUnit.DAYS))
                .build();

        // Run 1: skipped
        boolean firstRun = contentIngestionService.ingestArticle(staleItem);
        assertThat(firstRun).isFalse();

        // Run 2: skipped again, never saved
        boolean secondRun = contentIngestionService.ingestArticle(staleItem);
        assertThat(secondRun).isFalse();

        verify(feedArticleRepository, never()).save(any(FeedArticle.class));
    }
}
