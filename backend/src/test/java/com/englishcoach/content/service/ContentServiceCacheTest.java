package com.englishcoach.content.service;

import com.englishcoach.content.config.ContentCacheConfig;
import com.englishcoach.content.dto.DictationTodayDto;
import com.englishcoach.content.dto.ListeningTodayDto;
import com.englishcoach.content.dto.TrendingVocabularyDto;
import com.englishcoach.content.entity.ContentVocabulary;
import com.englishcoach.content.entity.ListeningContent;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.content.repository.*;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.repository.TranscriptSegmentRepository;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.cache.CacheManager;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.cache.concurrent.ConcurrentMapCacheManager;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.junit.jupiter.SpringExtension;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(SpringExtension.class)
@ContextConfiguration(classes = {ContentServiceCacheTest.TestCacheConfig.class})
class ContentServiceCacheTest {

    @Configuration
    @EnableCaching
    @Import(ContentServiceImpl.class)
    static class TestCacheConfig {
        @Bean
        public CacheManager cacheManager() {
            return new ConcurrentMapCacheManager(
                    ContentCacheConfig.CACHE_LISTENING_TODAY,
                    ContentCacheConfig.CACHE_DICTATION_TODAY,
                    ContentCacheConfig.CACHE_TRENDING_VOCAB
            );
        }

        @Bean
        public Clock clock() {
            return Clock.fixed(Instant.parse("2026-09-30T10:00:00Z"), ZoneId.of("Asia/Ho_Chi_Minh"));
        }

        @Bean
        public com.englishcoach.content.config.RssProperties rssProperties() {
            return new com.englishcoach.content.config.RssProperties();
        }
    }

    @MockBean
    private FeedArticleRepository feedArticleRepository;

    @MockBean
    private ReadingContentRepository readingContentRepository;

    @MockBean
    private ListeningContentRepository listeningContentRepository;

    @MockBean
    private ContentVocabularyRepository contentVocabularyRepository;

    @MockBean
    private ReadingMaterialRepository readingMaterialRepository;

    @MockBean
    private ListeningMaterialRepository listeningMaterialRepository;

    @MockBean
    private TranscriptSegmentRepository transcriptSegmentRepository;

    @Autowired
    private ContentService contentService;

    @Autowired
    private CacheManager cacheManager;

    @Test
    @DisplayName("Cache rule: LIBRARY results are cached per date; subsequent call with same date hits cache")
    void testLibraryResultsAreCached() {
        ListeningMaterial lesson = ListeningMaterial.builder()
                .id(1L)
                .title("Cached Library Lesson")
                .audioUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                .durationSeconds(120)
                .cefrLevel("B1")
                .isSystem(true)
                .build();

        when(listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc()).thenReturn(List.of(lesson));

        LocalDate date = LocalDate.of(2026, 9, 30);
        Optional<ListeningTodayDto> first = contentService.getListeningToday(date);
        Optional<ListeningTodayDto> second = contentService.getListeningToday(date);

        assertThat(first).isPresent();
        assertThat(first.get().getSource()).isEqualTo("LIBRARY");
        assertThat(second).isPresent();

        // Repository should only be queried once because second call is served from cache
        verify(listeningMaterialRepository, times(1)).findByIsSystemTrueOrderByIdAsc();
    }

    @Test
    @DisplayName("Cache rule: SEED results are NOT cached; subsequent call queries repository again")
    void testSeedResultsAreNotCached() {
        cacheManager.getCache(ContentCacheConfig.CACHE_LISTENING_TODAY).clear();

        contentService.setShowSeedListening(true);
        when(listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc()).thenReturn(List.of());

        ListeningContent seed = ListeningContent.builder()
                .id(100L)
                .kind("LISTENING")
                .title("Uncached Seed")
                .audioUrl("seed.mp3")
                .featuredOn(LocalDate.of(2026, 10, 1))
                .build();
        when(listeningContentRepository.findFirstByKindAndFeaturedOnLessThanEqualOrderByFeaturedOnDescIdDesc(any(), any()))
                .thenReturn(Optional.of(seed));

        LocalDate date = LocalDate.of(2026, 10, 1);
        Optional<ListeningTodayDto> first = contentService.getListeningToday(date);
        Optional<ListeningTodayDto> second = contentService.getListeningToday(date);

        assertThat(first).isPresent();
        assertThat(first.get().getSource()).isEqualTo("SEED");
        assertThat(second).isPresent();

        // Because SEED results are excluded via 'unless' clause, repository is invoked on both calls
        verify(listeningContentRepository, times(2))
                .findFirstByKindAndFeaturedOnLessThanEqualOrderByFeaturedOnDescIdDesc(any(), any());
    }

    @Test
    @DisplayName("Cache rule: 204 (empty) results are NOT cached")
    void testEmptyResultsAreNotCached() {
        cacheManager.getCache(ContentCacheConfig.CACHE_LISTENING_TODAY).clear();

        contentService.setShowSeedListening(false);
        when(listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc()).thenReturn(List.of());

        LocalDate date = LocalDate.of(2026, 10, 2);
        Optional<ListeningTodayDto> first = contentService.getListeningToday(date);
        Optional<ListeningTodayDto> second = contentService.getListeningToday(date);

        assertThat(first).isEmpty();
        assertThat(second).isEmpty();

        // Repository is invoked twice because empty (204) result is not cached
        verify(listeningMaterialRepository, times(2)).findByIsSystemTrueOrderByIdAsc();
    }

    @Test
    @DisplayName("Cache rule: Daily vocabulary is cached per date; subsequent call with same date hits cache")
    void testDailyVocabularyIsCachedPerDate() {
        ContentVocabulary v1 = ContentVocabulary.builder().id(1L).word("productivity").meaning("Năng suất").build();
        ContentVocabulary v2 = ContentVocabulary.builder().id(2L).word("burnout").meaning("Kiệt sức").build();

        when(contentVocabularyRepository.findAllEligibleDailyVocabulary()).thenReturn(List.of(v1, v2));

        LocalDate date = LocalDate.of(2026, 10, 1);
        List<TrendingVocabularyDto> first = contentService.getDailyVocabulary(date);
        List<TrendingVocabularyDto> second = contentService.getDailyVocabulary(date);

        assertThat(first).hasSize(2);
        assertThat(second).hasSize(2);

        // Repository should only be queried once because second call is served from Spring Cache
        verify(contentVocabularyRepository, times(1)).findAllEligibleDailyVocabulary();
    }
}
