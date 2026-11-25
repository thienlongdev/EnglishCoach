package com.englishcoach.content.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDate;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class NormalizedListeningItem {
    private String kind;
    private String youtubeVideoId;
    private String title;
    private String channel;
    private String level;
    private Integer duration;
    private String audioUrl;
    private String thumbnail;
    private String transcript;
    private Boolean transcriptHidden;
    private String accent;
    private String topic;
    private LocalDate featuredOn;
}
