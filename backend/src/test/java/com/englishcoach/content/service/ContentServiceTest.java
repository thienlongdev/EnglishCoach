package com.englishcoach.content.service;

import com.englishcoach.content.dto.*;
import com.englishcoach.content.entity.*;
import com.englishcoach.content.repository.*;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.web.server.ResponseStatusException;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ContentServiceTest {

    @Mock
    private FeedArticleRepository feedArticleRepository;

    @Mock
    private ReadingContentRepository readingContentRepository;

    @Mock
    private ListeningContentRepository listeningContentRepository;

    @Mock
    private ContentVocabularyRepository contentVocabularyRepository;

    @Mock
    private ReadingMaterialRepository readingMaterialRepository;

    @Mock
    private ListeningMaterialRepository listeningMaterialRepository;

    @Mock
    private com.englishcoach.listening.repository.TranscriptSegmentRepository transcriptSegmentRepository;

    @Mock
    private Clock clock;

    @Mock
    private com.englishcoach.content.config.RssProperties rssProperties;

    @InjectMocks
    private ContentServiceImpl contentService;

    private final Instant testInstant = Instant.parse("2026-09-30T10:00:00Z");

    @BeforeEach
    void setUp() {
        lenient().when(clock.instant()).thenReturn(testInstant);
        lenient().when(clock.getZone()).thenReturn(ZoneId.of("Asia/Ho_Chi_Minh"));
        lenient().when(rssProperties.getFreshnessDays()).thenReturn(14);
        lenient().when(rssProperties.getMaxAgeDays()).thenReturn(30);
    }

    @Test
    @DisplayName("Feed: diversity selection picks distinct live sources first, then fills, ordered published_at DESC")
    void testFeedDiversitySelection() {
        Instant now = Instant.now();
        List<FeedArticle> candidates = List.of(
                FeedArticle.builder().id(1L).providerKey("bbc-world").source("BBC").title("BBC 1").url("https://bbc.com/1").publishedAt(now.minusSeconds(10)).readMinutes(4).level("B2").build(),
                FeedArticle.builder().id(2L).providerKey("bbc-world").source("BBC").title("BBC 2").url("https://bbc.com/2").publishedAt(now.minusSeconds(20)).readMinutes(4).level("B2").build(),
                FeedArticle.builder().id(3L).providerKey("guardian-world").source("The Guardian").title("Guardian 1").url("https://tg.com/1").publishedAt(now.minusSeconds(30)).readMinutes(5).level("C1").build(),
                FeedArticle.builder().id(4L).providerKey("voa-learning-english").source("VOA").title("VOA 1").url("https://voa.com/1").publishedAt(now.minusSeconds(40)).readMinutes(3).level("B1").build(),
                FeedArticle.builder().id(5L).providerKey("seed").source("The Economist").title("Seed Eco").url("https://ec.com/seed").publishedAt(now.minusSeconds(100)).readMinutes(4).level("B2").build()
        );

        when(feedArticleRepository.findTop40ByOrderByPublishedAtDesc()).thenReturn(candidates);

        List<FeedArticleDto> feed = contentService.getFeed();

        assertThat(feed).hasSize(4);
        List<String> sources = feed.stream().map(FeedArticleDto::getSource).toList();
        assertThat(sources).contains("BBC", "The Guardian", "VOA");
        assertThat(feed.stream().anyMatch(a -> a.getUrl().contains("seed"))).isFalse();
        for (int i = 0; i < feed.size() - 1; i++) {
            assertThat(feed.get(i).getPublishedAt()).isAfterOrEqualTo(feed.get(i + 1).getPublishedAt());
        }
    }

    @Test
    @DisplayName("Feed: seed rows are used only when fewer than 4 live articles exist")
    void testFeedSeedFallback() {
        Instant now = Instant.now();
        List<FeedArticle> candidates = List.of(
                FeedArticle.builder().id(1L).providerKey("bbc-world").source("BBC").title("Live BBC").url("https://bbc.com/1").publishedAt(now.minusSeconds(10)).build(),
                FeedArticle.builder().id(2L).providerKey("seed").source("Seed 1").title("Seed 1").url("https://seed.com/1").publishedAt(now.minusSeconds(100)).build(),
                FeedArticle.builder().id(3L).providerKey("seed").source("Seed 2").title("Seed 2").url("https://seed.com/2").publishedAt(now.minusSeconds(200)).build(),
                FeedArticle.builder().id(4L).providerKey("seed").source("Seed 3").title("Seed 3").url("https://seed.com/3").publishedAt(now.minusSeconds(300)).build()
        );

        when(feedArticleRepository.findTop40ByOrderByPublishedAtDesc()).thenReturn(candidates);

        List<FeedArticleDto> feed = contentService.getFeed();

        assertThat(feed).hasSize(4);
        assertThat(feed.get(0).getTitle()).isEqualTo("Live BBC");
    }

    @Test
    @DisplayName("Reading: FULL_TEXT when reading_content exists")
    void testGetReadingContentFullText() {
        FeedArticle article = FeedArticle.builder()
                .id(1L)
                .title("Four-day work week")
                .source("BBC")
                .url("https://bbc.com/work")
                .level("B2")
                .readMinutes(4)
                .build();
        ReadingContent rc = ReadingContent.builder()
                .id(10L)
                .sourceArticleId(1L)
                .content("Full text of the four-day work week.")
                .wordCount(150)
                .build();

        when(feedArticleRepository.findById(1L)).thenReturn(Optional.of(article));
        when(readingContentRepository.findBySourceArticleId(1L)).thenReturn(Optional.of(rc));
        when(contentVocabularyRepository.findByContentTypeAndContentId("ARTICLE", 1L)).thenReturn(List.of());
        when(readingMaterialRepository.findByOwnerUserIdAndOriginFeedArticleId(42L, 1L)).thenReturn(Optional.empty());

        ReadingArticleDto dto = contentService.getReadingContent(1L, 42L);

        assertThat(dto.getContentMode()).isEqualTo("FULL_TEXT");
        assertThat(dto.getContent()).isEqualTo("Full text of the four-day work week.");
        assertThat(dto.getSaved()).isFalse();
    }

    @Test
    @DisplayName("Reading: SUMMARY_LINK when reading_content is missing")
    void testGetReadingContentSummaryLink() {
        FeedArticle article = FeedArticle.builder()
                .id(2L)
                .title("Brief Headline")
                .source("The Guardian")
                .url("https://guardian.com/brief")
                .summary("This is the feed summary.")
                .level("C1")
                .readMinutes(3)
                .build();

        when(feedArticleRepository.findById(2L)).thenReturn(Optional.of(article));
        when(readingContentRepository.findBySourceArticleId(2L)).thenReturn(Optional.empty());
        when(contentVocabularyRepository.findByContentTypeAndContentId("ARTICLE", 2L)).thenReturn(List.of());
        when(readingMaterialRepository.findByOwnerUserIdAndOriginFeedArticleId(42L, 2L)).thenReturn(Optional.of(ReadingMaterial.builder().id(99L).build()));

        ReadingArticleDto dto = contentService.getReadingContent(2L, 42L);

        assertThat(dto.getContentMode()).isEqualTo("SUMMARY_LINK");
        assertThat(dto.getContent()).isEqualTo("This is the feed summary.");
        assertThat(dto.getSourceUrl()).isEqualTo("https://guardian.com/brief");
        assertThat(dto.getSaved()).isTrue();
    }

    @Test
    @DisplayName("Reading: 404 when article does not exist")
    void testGetReadingContentNotFound() {
        when(feedArticleRepository.findById(999L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> contentService.getReadingContent(999L, null))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    @DisplayName("Save to Reading library: first save returns 201 (alreadySaved=false), repeat returns 200 (alreadySaved=true)")
    void testSaveReadingArticle() {
        FeedArticle article = FeedArticle.builder()
                .id(5L)
                .title("Saved Story")
                .source("BBC")
                .url("https://bbc.com/saved")
                .level("B2")
                .summary("Summary text")
                .build();

        when(feedArticleRepository.findById(5L)).thenReturn(Optional.of(article));
        when(readingMaterialRepository.findByOwnerUserIdAndOriginFeedArticleId(10L, 5L))
                .thenReturn(Optional.empty())
                .thenReturn(Optional.of(ReadingMaterial.builder().id(88L).build()));

        ReadingMaterial saved = ReadingMaterial.builder().id(88L).ownerUserId(10L).title("Saved Story").build();
        when(readingMaterialRepository.save(any(ReadingMaterial.class))).thenReturn(saved);

        SaveReadingResponseDto res1 = contentService.saveReadingArticle(5L, 10L);
        assertThat(res1.isSaved()).isTrue();
        assertThat(res1.isAlreadySaved()).isFalse();
        assertThat(res1.getLibraryArticleId()).isEqualTo(88L);

        SaveReadingResponseDto res2 = contentService.saveReadingArticle(5L, 10L);
        assertThat(res2.isSaved()).isTrue();
        assertThat(res2.isAlreadySaved()).isTrue();
        assertThat(res2.getLibraryArticleId()).isEqualTo(88L);
    }

    @Test
    @DisplayName("Save to Reading library: unique constraint race condition returns alreadySaved=true")
    void testSaveReadingArticleRaceCondition() {
        FeedArticle article = FeedArticle.builder().id(7L).title("Race Story").source("BBC").url("https://bbc.com/race").build();
        when(feedArticleRepository.findById(7L)).thenReturn(Optional.of(article));
        when(readingMaterialRepository.findByOwnerUserIdAndOriginFeedArticleId(10L, 7L))
                .thenReturn(Optional.empty())
                .thenReturn(Optional.of(ReadingMaterial.builder().id(99L).build()));
        when(readingMaterialRepository.save(any(ReadingMaterial.class)))
                .thenThrow(new DataIntegrityViolationException("Duplicate key error"));

        SaveReadingResponseDto res = contentService.saveReadingArticle(7L, 10L);
        assertThat(res.isSaved()).isTrue();
        assertThat(res.isAlreadySaved()).isTrue();
        assertThat(res.getLibraryArticleId()).isEqualTo(99L);
    }

    @Test
    @DisplayName("Listening Today: picks deterministically from real library lessons")
    void testListeningTodayFromLibrary() {
        ListeningMaterial lesson1 = ListeningMaterial.builder()
                .id(1L)
                .title("Lesson One")
                .audioUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ") // 11-char ID
                .durationSeconds(120)
                .cefrLevel("B1")
                .isSystem(true)
                .build();
        ListeningMaterial lesson2 = ListeningMaterial.builder()
                .id(2L)
                .title("Lesson Two")
                .audioUrl("https://www.youtube.com/watch?v=abc12345678") // 11-char ID
                .durationSeconds(180)
                .cefrLevel("B2")
                .isSystem(true)
                .build();

        when(listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc()).thenReturn(List.of(lesson1, lesson2));

        Optional<ListeningTodayDto> opt = contentService.getListeningToday(LocalDate.of(2026, 9, 30));

        assertThat(opt).isPresent();
        ListeningTodayDto dto = opt.get();
        assertThat(dto.getSource()).isEqualTo("LIBRARY");
        assertThat(dto.getDeepLink()).startsWith("/listening/");
        assertThat(dto.getYoutubeVideoId()).isNotNull();
    }

    @Test
    @DisplayName("Listening Today: fallback to seed when library has no valid YouTube videos and showSeedListening=true")
    void testListeningTodayFallbackToSeed() {
        contentService.setShowSeedListening(true);
        when(listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc()).thenReturn(List.of());

        ListeningContent seed = ListeningContent.builder()
                .id(10L)
                .kind("LISTENING")
                .title("Seed Podcast")
                .audioUrl("seed_audio.mp3")
                .featuredOn(LocalDate.of(2026, 9, 30))
                .build();
        when(listeningContentRepository.findFirstByKindAndFeaturedOnLessThanEqualOrderByFeaturedOnDescIdDesc("LISTENING", LocalDate.of(2026, 9, 30)))
                .thenReturn(Optional.of(seed));

        Optional<ListeningTodayDto> opt = contentService.getListeningToday(LocalDate.of(2026, 9, 30));

        assertThat(opt).isPresent();
        assertThat(opt.get().getSource()).isEqualTo("SEED");
        assertThat(opt.get().getTitle()).isEqualTo("Seed Podcast");
    }

    @Test
    @DisplayName("Task C: Listening Today returns empty (204) when showSeedListening=false and library is empty")
    void testListeningTodayEmptyWhenShowSeedListeningFalse() {
        contentService.setShowSeedListening(false);
        when(listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc()).thenReturn(List.of());

        Optional<ListeningTodayDto> opt = contentService.getListeningToday(LocalDate.of(2026, 9, 30));

        assertThat(opt).isEmpty();
        verifyNoInteractions(listeningContentRepository);
    }

    @Test
    @DisplayName("Task C: Dictation Today returns empty (204) when showSeedListening=false and library is empty")
    void testDictationTodayEmptyWhenShowSeedListeningFalse() {
        contentService.setShowSeedListening(false);
        when(listeningMaterialRepository.findSystemMaterialsWithSegmentsAndExercises()).thenReturn(List.of());

        Optional<DictationTodayDto> opt = contentService.getDictationToday(LocalDate.of(2026, 9, 30));

        assertThat(opt).isEmpty();
        verifyNoInteractions(listeningContentRepository);
    }

    @Test
    @DisplayName("Task C: Dictation Today fallback to seed when showSeedListening=true and library is empty")
    void testDictationTodayFallbackToSeedWhenFlagTrue() {
        contentService.setShowSeedListening(true);
        when(listeningMaterialRepository.findSystemMaterialsWithSegmentsAndExercises()).thenReturn(List.of());

        ListeningContent seed = ListeningContent.builder()
                .id(20L)
                .kind("DICTATION")
                .title("Seed Dictation")
                .audioUrl("seed_dictation.mp3")
                .featuredOn(LocalDate.of(2026, 9, 30))
                .build();
        when(listeningContentRepository.findFirstByKindAndFeaturedOnLessThanEqualOrderByFeaturedOnDescIdDesc("DICTATION", LocalDate.of(2026, 9, 30)))
                .thenReturn(Optional.of(seed));

        Optional<DictationTodayDto> opt = contentService.getDictationToday(LocalDate.of(2026, 9, 30));

        assertThat(opt).isPresent();
        assertThat(opt.get().getSource()).isEqualTo("SEED");
        assertThat(opt.get().getTitle()).isEqualTo("Seed Dictation");
    }

    @Test
    @DisplayName("Task C: Library materials are returned regardless of showSeedListening flag")
    void testListeningAndDictationReturnLibraryRegardlessOfFlag() {
        contentService.setShowSeedListening(false); // flag is false, but library present!

        TranscriptSegment seg = TranscriptSegment.builder().id(201L).startTimeMs(1000).endTimeMs(20000).text("This is an adequate segment for dictation practice with enough words.").build();
        ListeningMaterial lesson = ListeningMaterial.builder()
                .id(1L)
                .title("Library Lesson")
                .audioUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                .durationSeconds(120)
                .cefrLevel("B1")
                .isSystem(true)
                .segments(List.of(seg))
                .build();

        when(listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc()).thenReturn(List.of(lesson));
        when(listeningMaterialRepository.findSystemMaterialsWithSegmentsAndExercises()).thenReturn(List.of(lesson));
        when(transcriptSegmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(1L)).thenReturn(List.of(seg));

        Optional<ListeningTodayDto> listeningOpt = contentService.getListeningToday(LocalDate.of(2026, 9, 30));
        Optional<DictationTodayDto> dictationOpt = contentService.getDictationToday(LocalDate.of(2026, 9, 30));

        assertThat(listeningOpt).isPresent();
        assertThat(listeningOpt.get().getSource()).isEqualTo("LIBRARY");
        assertThat(dictationOpt).isPresent();
        assertThat(dictationOpt.get().getSource()).isEqualTo("LIBRARY");
    }

    @Test
    @DisplayName("Requirement: is_system=false material is never selected by getListeningToday or getDictationToday")
    void testNonSystemMaterialNeverSelected() {
        contentService.setShowSeedListening(false);
        // Repository queries never return is_system=false materials
        when(listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc()).thenReturn(List.of());
        when(listeningMaterialRepository.findSystemMaterialsWithSegmentsAndExercises()).thenReturn(List.of());

        Optional<ListeningTodayDto> listeningOpt = contentService.getListeningToday(LocalDate.of(2026, 9, 30));
        Optional<DictationTodayDto> dictationOpt = contentService.getDictationToday(LocalDate.of(2026, 9, 30));

        assertThat(listeningOpt).isEmpty();
        assertThat(dictationOpt).isEmpty();
    }

    @Test
    @DisplayName("Dictation Next-Lesson Path: when first candidate has no valid segments, selector falls back to next lesson")
    void testDictationNextLessonPathWhenFirstMaterialHasNoSegments() {
        TranscriptSegment validSeg = TranscriptSegment.builder().id(999L).startTimeMs(0).endTimeMs(18000).text("Valid candidate with plenty of spoken words for dictation exercise.").build();

        ListeningMaterial lessonNoSegs = ListeningMaterial.builder()
                .id(10L)
                .title("No Segments Lesson")
                .audioUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                .durationSeconds(60)
                .cefrLevel("B1")
                .isSystem(true)
                .build();

        ListeningMaterial lessonWithSegs = ListeningMaterial.builder()
                .id(20L)
                .title("With Segments Lesson")
                .audioUrl("https://www.youtube.com/watch?v=abcdefghijk")
                .durationSeconds(120)
                .cefrLevel("B2")
                .isSystem(true)
                .build();

        when(listeningMaterialRepository.findSystemMaterialsWithSegmentsAndExercises()).thenReturn(List.of(lessonNoSegs, lessonWithSegs));
        when(transcriptSegmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(any())).thenAnswer(inv -> {
            Long matId = inv.getArgument(0);
            if (matId.equals(10L)) return List.of();
            if (matId.equals(20L)) return List.of(validSeg);
            return List.of();
        });

        Optional<DictationTodayDto> opt = contentService.getDictationToday(LocalDate.of(2026, 9, 30));

        assertThat(opt).isPresent();
        assertThat(opt.get().getId()).isEqualTo(20L);
        assertThat(opt.get().getSegmentId()).isEqualTo(999L);
        assertThat(opt.get().getSource()).isEqualTo("LIBRARY");
    }

    @Test
    @DisplayName("Dictation Today: returns hidden transcript and deep link with ?segment= only")
    void testDictationTodayHiddenTranscript() {
        TranscriptSegment seg1 = TranscriptSegment.builder().id(101L).startTimeMs(1000).endTimeMs(10000).text("Welcome everyone to this interesting presentation and workshop today.").build();
        TranscriptSegment seg2 = TranscriptSegment.builder().id(102L).startTimeMs(10000).endTimeMs(29000).text("We are studying natural language processing and practical listening skills today with high precision.").build(); // 19s (closest to 20s)
        TranscriptSegment seg3 = TranscriptSegment.builder().id(103L).startTimeMs(29000).endTimeMs(40000).text("Scientists have made significant discoveries in modern speech recognition systems recently.").build();

        ListeningMaterial lesson = ListeningMaterial.builder()
                .id(1L)
                .title("Dictation Lesson")
                .audioUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                .durationSeconds(120)
                .cefrLevel("B1")
                .isSystem(true)
                .segments(List.of(seg1, seg2, seg3))
                .build();

        when(listeningMaterialRepository.findSystemMaterialsWithSegmentsAndExercises()).thenReturn(List.of(lesson));
        when(transcriptSegmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(1L)).thenReturn(List.of(seg1, seg2, seg3));

        Optional<DictationTodayDto> opt = contentService.getDictationToday(LocalDate.of(2026, 9, 30));

        assertThat(opt).isPresent();
        DictationTodayDto dto = opt.get();
        assertThat(dto.getSource()).isEqualTo("LIBRARY");
        assertThat(dto.getSegmentId()).isEqualTo(102L);
        assertThat(dto.getDurationSeconds()).isEqualTo(19);
        assertThat(dto.getTranscriptHidden()).isTrue();
        assertThat(dto.getTranscript()).isNull();
        assertThat(dto.getDeepLink()).isEqualTo("/listening/1/practice?segment=102");
        assertThat(dto.getDeepLink()).doesNotContain("start");
        assertThat(dto.getDeepLink()).doesNotContain("end");
    }

    @Test
    @DisplayName("Task F2 Regression: Daily Dictation deepLink contains only ?segment=, no start or end params, even with fractional segment bounds 669.56 -> 674.44")
    void testDictationDeepLinkNoStartEndParamsWithFractionalSegment() {
        // 669.56s = 669560ms, 674.44s = 674440ms
        TranscriptSegment seg = TranscriptSegment.builder()
                .id(777L)
                .startTimeMs(669560)
                .endTimeMs(674440)
                .text("This is an important segment with speech for dictation practice.")
                .build();

        ListeningMaterial lesson = ListeningMaterial.builder()
                .id(42L)
                .title("Fractional Segment Lesson")
                .audioUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                .durationSeconds(800)
                .cefrLevel("B2")
                .isSystem(true)
                .build();

        when(listeningMaterialRepository.findSystemMaterialsWithSegmentsAndExercises()).thenReturn(List.of(lesson));
        when(transcriptSegmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(42L)).thenReturn(List.of(seg));

        Optional<DictationTodayDto> opt = contentService.getDictationToday(LocalDate.of(2026, 9, 30));

        assertThat(opt).isPresent();
        DictationTodayDto dto = opt.get();
        assertThat(dto.getDeepLink()).isEqualTo("/listening/42/practice?segment=777");
        assertThat(dto.getDeepLink()).doesNotContain("start");
        assertThat(dto.getDeepLink()).doesNotContain("end");
        assertThat(dto.getStartSeconds()).isEqualTo(670);
        assertThat(dto.getEndSeconds()).isEqualTo(674);
        assertThat(dto.getDurationSeconds()).isEqualTo(4);
    }

    @Test
    @DisplayName("Task A4 Regression: Uninitialized lazy segments collection does not throw LazyInitializationException")
    void testRegressionLazyCollectionHandling() {
        // Material with segments uninitialized or detached
        ListeningMaterial lesson = ListeningMaterial.builder()
                .id(99L)
                .title("Lazy Test Lesson")
                .audioUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
                .durationSeconds(150)
                .cefrLevel("B2")
                .isSystem(true)
                .segments(null)
                .build();

        when(listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc()).thenReturn(List.of(lesson));
        when(transcriptSegmentRepository.existsByListeningMaterialId(99L)).thenReturn(true);

        Optional<ListeningTodayDto> opt = contentService.getListeningToday(LocalDate.of(2026, 9, 30));

        assertThat(opt).isPresent();
        assertThat(opt.get().getSource()).isEqualTo("LIBRARY");
        assertThat(opt.get().isHasTranscript()).isTrue();
        assertThat(opt.get().getYoutubeVideoId()).isEqualTo("dQw4w9WgXcQ");
    }

    @Test
    @DisplayName("Task A4 Regression: URL-format YouTube ID is correctly normalized and accepted")
    void testRegressionUrlFormatYoutubeIdAccepted() {
        ListeningMaterial lesson = ListeningMaterial.builder()
                .id(50L)
                .title("URL Format Lesson")
                .audioUrl("https://youtu.be/dQw4w9WgXcQ")
                .durationSeconds(200)
                .cefrLevel("B1")
                .isSystem(true)
                .build();

        when(listeningMaterialRepository.findByIsSystemTrueOrderByIdAsc()).thenReturn(List.of(lesson));
        when(transcriptSegmentRepository.existsByListeningMaterialId(50L)).thenReturn(false);

        Optional<ListeningTodayDto> opt = contentService.getListeningToday(LocalDate.of(2026, 9, 30));

        assertThat(opt).isPresent();
        assertThat(opt.get().getYoutubeVideoId()).isEqualTo("dQw4w9WgXcQ");
        assertThat(opt.get().getSource()).isEqualTo("LIBRARY");
    }

    @Test
    @DisplayName("Task C6 Feed Selection Order: Fresh Live (14d) > Older Live (30d) > Seed, stale source (>30d) excluded")
    void testFeedSelectionOrderHierarchy() {
        Instant now = testInstant;
        Instant day2Ago = now.minus(2, java.time.temporal.ChronoUnit.DAYS);   // fresh (< 14d)
        Instant day5Ago = now.minus(5, java.time.temporal.ChronoUnit.DAYS);   // fresh (< 14d)
        Instant day20Ago = now.minus(20, java.time.temporal.ChronoUnit.DAYS); // older live (14-30d)
        Instant day40Ago = now.minus(40, java.time.temporal.ChronoUnit.DAYS); // stale (> 30d)

        List<FeedArticle> candidates = List.of(
                FeedArticle.builder().id(1L).providerKey("bbc-world").source("BBC").title("BBC Fresh").publishedAt(day2Ago).readMinutes(4).level("B2").build(),
                FeedArticle.builder().id(2L).providerKey("guardian-world").source("The Guardian").title("Guardian Fresh").publishedAt(day5Ago).readMinutes(5).level("C1").build(),
                FeedArticle.builder().id(3L).providerKey("guardian-world").source("The Guardian").title("Guardian Older").publishedAt(day20Ago).readMinutes(5).level("C1").build(),
                FeedArticle.builder().id(4L).providerKey("voa-learning-english").source("VOA").title("VOA Stale 40d").publishedAt(day40Ago).readMinutes(3).level("B1").build(),
                FeedArticle.builder().id(5L).providerKey("seed").source("The Economist").title("Seed Economy").publishedAt(now.minusSeconds(100)).readMinutes(4).level("B2").build()
        );

        when(feedArticleRepository.findTop40ByOrderByPublishedAtDesc()).thenReturn(candidates);

        List<FeedArticleDto> feed = contentService.getFeed();

        assertThat(feed).hasSize(4);
        List<String> titles = feed.stream().map(FeedArticleDto::getTitle).toList();
        // BBC Fresh (fresh), Guardian Fresh (fresh), Guardian Older (older live), Seed Economy (seed)
        // Stale VOA 40d is strictly excluded from all 4 slots!
        assertThat(titles).contains("BBC Fresh", "Guardian Fresh", "Guardian Older", "Seed Economy");
        assertThat(titles).doesNotContain("VOA Stale 40d");
    }

    @Test
    @DisplayName("Daily Vocabulary: Same day produces deterministic identical result (no random on request)")
    void testDailyVocabularyDeterministicSameDay() {
        List<ContentVocabulary> candidates = List.of(
                ContentVocabulary.builder().id(1L).word("productivity").meaning("Năng suất").phonetic("/prɒd/").exampleSentence("Focus on productivity.").frequency(15).build(),
                ContentVocabulary.builder().id(2L).word("fatigue").meaning("Mệt mỏi").phonetic("/fəˈtiːɡ/").exampleSentence("Chronic fatigue.").frequency(12).build(),
                ContentVocabulary.builder().id(3L).word("turnover").meaning("Tỷ lệ thôi việc").phonetic("/ˈtɜːn/").exampleSentence("Reduce turnover.").frequency(10).build(),
                ContentVocabulary.builder().id(4L).word("streamline").meaning("Tinh gọn").phonetic("/ˈstriːm/").exampleSentence("Streamline process.").frequency(8).build(),
                ContentVocabulary.builder().id(5L).word("serenity").meaning("Thanh bình").phonetic("/səˈren/").exampleSentence("Sonic serenity.").frequency(9).build(),
                ContentVocabulary.builder().id(6L).word("prioritize").meaning("Ưu tiên").phonetic("/praɪˈɒr/").exampleSentence("Prioritize tasks.").frequency(8).build(),
                ContentVocabulary.builder().id(7L).word("burnout").meaning("Kiệt sức").phonetic("/ˈbɝːn/").exampleSentence("Avoid burnout.").frequency(40).build()
        );

        when(contentVocabularyRepository.findAllEligibleDailyVocabulary()).thenReturn(candidates);

        LocalDate date = LocalDate.of(2026, 10, 1);
        List<TrendingVocabularyDto> first = contentService.getDailyVocabulary(date);
        List<TrendingVocabularyDto> second = contentService.getDailyVocabulary(date);

        assertThat(first).hasSize(5);
        assertThat(second).hasSize(5);
        List<String> firstWords = first.stream().map(TrendingVocabularyDto::getWord).toList();
        List<String> secondWords = second.stream().map(TrendingVocabularyDto::getWord).toList();
        assertThat(firstWords).isEqualTo(secondWords);
    }

    @Test
    @DisplayName("Daily Vocabulary: Different days produce rotated deterministic sets")
    void testDailyVocabularyRotatesNextDay() {
        List<ContentVocabulary> candidates = List.of(
                ContentVocabulary.builder().id(1L).word("productivity").meaning("Năng suất").phonetic("/prɒd/").exampleSentence("Focus on productivity.").frequency(15).build(),
                ContentVocabulary.builder().id(2L).word("fatigue").meaning("Mệt mỏi").phonetic("/fəˈtiːɡ/").exampleSentence("Chronic fatigue.").frequency(12).build(),
                ContentVocabulary.builder().id(3L).word("turnover").meaning("Tỷ lệ thôi việc").phonetic("/ˈtɜːn/").exampleSentence("Reduce turnover.").frequency(10).build(),
                ContentVocabulary.builder().id(4L).word("streamline").meaning("Tinh gọn").phonetic("/ˈstriːm/").exampleSentence("Streamline process.").frequency(8).build(),
                ContentVocabulary.builder().id(5L).word("serenity").meaning("Thanh bình").phonetic("/səˈren/").exampleSentence("Sonic serenity.").frequency(9).build(),
                ContentVocabulary.builder().id(6L).word("prioritize").meaning("Ưu tiên").phonetic("/praɪˈɒr/").exampleSentence("Prioritize tasks.").frequency(8).build(),
                ContentVocabulary.builder().id(7L).word("burnout").meaning("Kiệt sức").phonetic("/ˈbɝːn/").exampleSentence("Avoid burnout.").frequency(40).build(),
                ContentVocabulary.builder().id(8L).word("doomscrolling").meaning("Lướt tin tiêu cực").phonetic("/duːm/").exampleSentence("Stop doomscrolling.").frequency(50).build()
        );

        when(contentVocabularyRepository.findAllEligibleDailyVocabulary()).thenReturn(candidates);

        LocalDate day1 = LocalDate.of(2026, 10, 1);
        LocalDate day2 = LocalDate.of(2026, 10, 2);

        List<TrendingVocabularyDto> set1 = contentService.getDailyVocabulary(day1);
        List<TrendingVocabularyDto> set2 = contentService.getDailyVocabulary(day2);

        assertThat(set1).hasSize(5);
        assertThat(set2).hasSize(5);
        List<String> words1 = set1.stream().map(TrendingVocabularyDto::getWord).toList();
        List<String> words2 = set2.stream().map(TrendingVocabularyDto::getWord).toList();
        assertThat(words1).isNotEqualTo(words2);
    }

    @Test
    @DisplayName("Daily Vocabulary: Filters blanks and deduplicates candidate items")
    void testDailyVocabularyDeduplicatesAndFiltersBlanks() {
        List<ContentVocabulary> candidates = List.of(
                ContentVocabulary.builder().id(1L).word("productivity").meaning("Năng suất").build(),
                ContentVocabulary.builder().id(2L).word("productivity").meaning("Năng suất khác").build(), // duplicate
                ContentVocabulary.builder().id(3L).word("   ").meaning("Trống").build(), // blank word
                ContentVocabulary.builder().id(4L).word("valid1").meaning("").build(), // blank meaning
                ContentVocabulary.builder().id(5L).word("valid2").meaning("Nghĩa 2").build(),
                ContentVocabulary.builder().id(6L).word("valid3").meaning("Nghĩa 3").build(),
                ContentVocabulary.builder().id(7L).word("valid4").meaning("Nghĩa 4").build(),
                ContentVocabulary.builder().id(8L).word("valid5").meaning("Nghĩa 5").build()
        );

        when(contentVocabularyRepository.findAllEligibleDailyVocabulary()).thenReturn(candidates);

        List<TrendingVocabularyDto> result = contentService.getDailyVocabulary(LocalDate.of(2026, 10, 1));

        assertThat(result).hasSize(5);
        List<String> words = result.stream().map(TrendingVocabularyDto::getWord).toList();
        assertThat(words).doesNotContain("   ");
        assertThat(words).doesNotContain("valid1");
        long countProductivity = words.stream().filter(w -> w.equalsIgnoreCase("productivity")).count();
        assertThat(countProductivity).isEqualTo(1);
    }
}
