package com.englishcoach.listening.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ListeningLibraryItemDto {
    private Long id;
    private String title;
    private String channel;
    private String topic;
    private String level;
    private String accent;
    private Integer durationSeconds;
    private String thumbnail;
    private String youtubeVideoId;
    private Boolean practiceAvailable;
    private Boolean hasTranscript;
}
