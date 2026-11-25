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
public class NormalizedVideoItem {
    private String videoId;
    private String title;
    private String channel;
    private String thumbnail;
    private String duration;
    private Instant publishedAt;
}
