package com.englishcoach.content.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ReadingArticleDto {
    private Long articleId;
    private String title;
    private String source;
    private String url;
    private String level;
    private Integer wordCount;
    private Integer readMinutes;
    private String content;
    private String contentMode;
    private String sourceUrl;
    private Boolean saved;

    @Builder.Default
    private List<ContentVocabularyDto> vocabulary = new ArrayList<>();
}
