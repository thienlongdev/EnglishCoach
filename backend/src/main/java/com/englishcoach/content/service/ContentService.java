package com.englishcoach.content.service;

import com.englishcoach.content.dto.*;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

public interface ContentService {
    List<FeedArticleDto> getFeed();
    Optional<ListeningTodayDto> getListeningToday(LocalDate date);
    Optional<DictationTodayDto> getDictationToday(LocalDate date);
    List<TrendingVocabularyDto> getTrendingVocabulary();
    List<TrendingVocabularyDto> getDailyVocabulary(LocalDate date);
    ReadingArticleDto getReadingContent(Long articleId);
    ReadingArticleDto getReadingContent(Long articleId, Long userId);
    SaveReadingResponseDto saveReadingArticle(Long articleId, Long userId);
    void setShowSeedListening(boolean showSeedListening);
}
