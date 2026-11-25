package com.englishcoach.content.controller;

import com.englishcoach.content.dto.*;
import com.englishcoach.content.service.ContentService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@ExtendWith(MockitoExtension.class)
class ContentControllerTest {

    @Mock
    private ContentService contentService;

    @InjectMocks
    private ContentController contentController;

    private MockMvc mockMvc;
    private ObjectMapper objectMapper;

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        mockMvc = MockMvcBuilders.standaloneSetup(contentController).build();
    }

    @Test
    @DisplayName("GET /api/v1/content/feed: returns top 4 articles")
    void testGetFeed() throws Exception {
        List<FeedArticleDto> feed = List.of(
                FeedArticleDto.builder().id(1L).title("Title 1").source("BBC").url("https://bbc.com").readMinutes(4).level("B2").publishedAt(Instant.now()).build(),
                FeedArticleDto.builder().id(2L).title("Title 2").source("The Guardian").url("https://theguardian.com").readMinutes(4).level("B2").publishedAt(Instant.now()).build()
        );
        when(contentService.getFeed()).thenReturn(feed);

        mockMvc.perform(get("/api/v1/content/feed").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].title").value("Title 1"))
                .andExpect(jsonPath("$[0].source").value("BBC"))
                .andExpect(jsonPath("$[0].readMinutes").value(4));
    }

    @Test
    @DisplayName("GET /api/v1/content/listening/today: 200 and never contains transcript text")
    void testGetListeningToday() throws Exception {
        ListeningTodayDto listening = ListeningTodayDto.builder()
                .id(10L)
                .kind("LISTENING")
                .title("How Sleep Shapes Memory")
                .channel("English Coach Podcast")
                .topic("Health & Science")
                .level("B2")
                .accent("British")
                .durationSeconds(480)
                .hasTranscript(true)
                .build();

        when(contentService.getListeningToday(any(LocalDate.class))).thenReturn(Optional.of(listening));

        MvcResult result = mockMvc.perform(get("/api/v1/content/listening/today").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(10))
                .andExpect(jsonPath("$.title").value("How Sleep Shapes Memory"))
                .andExpect(jsonPath("$.durationSeconds").value(480))
                .andExpect(jsonPath("$.hasTranscript").value(true))
                .andReturn();

        String responseBody = result.getResponse().getContentAsString();
        assertThat(responseBody).doesNotContain("\"transcript\"");
    }

    @Test
    @DisplayName("GET /api/v1/content/listening/today: 204 when no content available")
    void testGetListeningTodayEmpty() throws Exception {
        when(contentService.getListeningToday(any(LocalDate.class))).thenReturn(Optional.empty());

        mockMvc.perform(get("/api/v1/content/listening/today").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isNoContent());
    }

    @Test
    @DisplayName("GET /api/v1/content/dictation/today with transcriptHidden = true: response JSON contains no transcript key")
    void testGetDictationTodayHiddenTranscript() throws Exception {
        DictationTodayDto dictation = DictationTodayDto.builder()
                .id(20L)
                .title("Ordering Coffee")
                .level("B1")
                .accent("American")
                .topic("Daily Life")
                .durationSeconds(20)
                .transcriptHidden(true)
                .transcript(null) // omitted due to @JsonInclude(NON_NULL)
                .build();

        when(contentService.getDictationToday(any(LocalDate.class))).thenReturn(Optional.of(dictation));

        MvcResult result = mockMvc.perform(get("/api/v1/content/dictation/today").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(20))
                .andExpect(jsonPath("$.title").value("Ordering Coffee"))
                .andExpect(jsonPath("$.transcriptHidden").value(true))
                .andReturn();

        String json = result.getResponse().getContentAsString();
        assertThat(json).doesNotContain("\"transcript\"");
        assertThat(json).doesNotContain("Good morning");
    }

    @Test
    @DisplayName("GET /api/v1/content/dictation/today with transcriptHidden = false: transcript present")
    void testGetDictationTodayVisibleTranscript() throws Exception {
        DictationTodayDto dictation = DictationTodayDto.builder()
                .id(21L)
                .title("Ordering Coffee")
                .level("B1")
                .durationSeconds(20)
                .transcriptHidden(false)
                .transcript("Good morning! I'd like a medium latte.")
                .build();

        when(contentService.getDictationToday(any(LocalDate.class))).thenReturn(Optional.of(dictation));

        MvcResult result = mockMvc.perform(get("/api/v1/content/dictation/today").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.transcriptHidden").value(false))
                .andExpect(jsonPath("$.transcript").value("Good morning! I'd like a medium latte."))
                .andReturn();

        String json = result.getResponse().getContentAsString();
        assertThat(json).contains("\"transcript\":\"Good morning! I'd like a medium latte.\"");
    }

    @Test
    @DisplayName("GET /api/v1/content/dictation/today: 204 when empty")
    void testGetDictationTodayEmpty() throws Exception {
        when(contentService.getDictationToday(any(LocalDate.class))).thenReturn(Optional.empty());

        mockMvc.perform(get("/api/v1/content/dictation/today").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isNoContent());
    }

    @Test
    @DisplayName("GET /api/v1/content/vocabulary/trending: 5 items ordered by frequency DESC")
    void testGetTrendingVocabulary() throws Exception {
        List<TrendingVocabularyDto> trending = List.of(
                TrendingVocabularyDto.builder().id(1L).word("doomscrolling").lemma("doomscroll").phonetic("/ˈduːmˌskroʊlɪŋ/").meaning("lướt tin tiêu cực").exampleSentence("Stop doomscrolling.").frequency(50).build(),
                TrendingVocabularyDto.builder().id(2L).word("burnout").lemma("burnout").phonetic("/ˈbɝːnaʊt/").meaning("kiệt sức").exampleSentence("Avoid burnout.").frequency(40).build(),
                TrendingVocabularyDto.builder().id(3L).word("side hustle").lemma("side hustle").phonetic("/ˈsaɪd ˌhʌsəl/").meaning("nguồn thu nhập phụ").exampleSentence("My side hustle.").frequency(30).build(),
                TrendingVocabularyDto.builder().id(4L).word("ghosting").lemma("ghost").phonetic("/ˈɡoʊstɪŋ/").meaning("im lặng").exampleSentence("She started ghosting.").frequency(20).build(),
                TrendingVocabularyDto.builder().id(5L).word("touch grass").lemma("touch grass").phonetic("/ˌtʌtʃ ˈɡræs/").meaning("ra ngoài đời").exampleSentence("Go touch grass.").frequency(10).build()
        );

        when(contentService.getTrendingVocabulary()).thenReturn(trending);

        mockMvc.perform(get("/api/v1/content/vocabulary/trending").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(5))
                .andExpect(jsonPath("$[0].word").value("doomscrolling"))
                .andExpect(jsonPath("$[0].frequency").value(50))
                .andExpect(jsonPath("$[4].word").value("touch grass"))
                .andExpect(jsonPath("$[4].frequency").value(10));
    }

    @Test
    @DisplayName("GET /api/v1/content/vocabulary/daily: 200 with daily vocabulary items")
    void testGetDailyVocabulary() throws Exception {
        List<TrendingVocabularyDto> daily = List.of(
                TrendingVocabularyDto.builder().id(10L).word("distraction").phonetic("/dɪˈstræk.ʃən/").meaning("sự xao nhãng").exampleSentence("Smartphones are a distraction.").frequency(11).build(),
                TrendingVocabularyDto.builder().id(11L).word("milestone").phonetic("/ˈmaɪl.stəʊn/").meaning("cột mốc").exampleSentence("A major milestone.").frequency(9).build()
        );

        when(contentService.getDailyVocabulary(LocalDate.of(2026, 10, 1))).thenReturn(daily);

        mockMvc.perform(get("/api/v1/content/vocabulary/daily?date=2026-10-01").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.length()").value(2))
                .andExpect(jsonPath("$[0].word").value("distraction"))
                .andExpect(jsonPath("$[1].word").value("milestone"));
    }

    @Test
    @DisplayName("GET /api/v1/content/reading/{articleId}: 200 with vocabulary for seeded article")
    void testGetReadingContentSuccess() throws Exception {
        ReadingArticleDto article = ReadingArticleDto.builder()
                .articleId(1L)
                .title("Why more people are choosing four-day work weeks")
                .source("BBC")
                .url("https://www.bbc.com")
                .level("B2")
                .wordCount(167)
                .readMinutes(4)
                .contentMode("FULL_TEXT")
                .saved(false)
                .content("The concept of the four-day work week...")
                .vocabulary(List.of(
                        ContentVocabularyDto.builder().id(10L).word("productivity").meaning("Năng suất làm việc").exampleSentence("Example").build()
                ))
                .build();

        when(contentService.getReadingContent(eq(1L), any())).thenReturn(article);

        mockMvc.perform(get("/api/v1/content/reading/1").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.articleId").value(1))
                .andExpect(jsonPath("$.title").value("Why more people are choosing four-day work weeks"))
                .andExpect(jsonPath("$.contentMode").value("FULL_TEXT"))
                .andExpect(jsonPath("$.wordCount").value(167))
                .andExpect(jsonPath("$.vocabulary.length()").value(1))
                .andExpect(jsonPath("$.vocabulary[0].word").value("productivity"));
    }

    @Test
    @DisplayName("GET /api/v1/content/reading/{articleId}: 404 for unknown article id")
    void testGetReadingContentNotFound() throws Exception {
        when(contentService.getReadingContent(eq(999L), any()))
                .thenThrow(new ResponseStatusException(HttpStatus.NOT_FOUND, "Article not found"));

        mockMvc.perform(get("/api/v1/content/reading/999").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isNotFound());
    }
}

