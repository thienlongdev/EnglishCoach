package com.englishcoach.content.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class FeedArticleDto {
    private Long id;
    private String source;
    private String title;
    private String url;
    private String thumbnail;
    private String summary;
    private String category;
    private String level;
    private Integer readMinutes;
    private Instant publishedAt;
}
