package com.englishcoach.content.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class NormalizedArticleItem {
    private String providerKey;
    private String source;
    private String title;
    private String url;
    private String thumbnail;
    private String summary;
    private String category;
    private String level;
    private Integer readMinutes;
    private Instant publishedAt;
    private String readingContent;

    @Builder.Default
    private List<NormalizedVocabularyItem> vocabulary = new ArrayList<>();
}
