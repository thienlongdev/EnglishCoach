package com.englishcoach.content.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ListeningTodayDto {
    private Long id;
    private String kind;
    private String title;
    private String channel;
    private String topic;
    private String level;
    private String accent;
    private Integer durationSeconds;
    private String audioUrl;
    private String thumbnail;
    private String youtubeVideoId;
    private boolean hasTranscript;
    private String source;
    private String deepLink;
}
