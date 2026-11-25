package com.englishcoach.content.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class DictationTodayDto {
    private Long id;
    private Long segmentId;
    private String title;
    private String level;
    private String accent;
    private String topic;
    private Integer durationSeconds;
    private String audioUrl;
    private String youtubeVideoId;
    private Integer startSeconds;
    private Integer endSeconds;
    private String source;
    private String deepLink;
    private Boolean transcriptHidden;
    private String transcript;
}
