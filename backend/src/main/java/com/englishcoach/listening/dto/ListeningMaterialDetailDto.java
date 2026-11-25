package com.englishcoach.listening.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ListeningMaterialDetailDto {
    private Long id;
    private String title;
    private String audioUrl;

    private String sourceType;
    private String voiceId;
    private Integer durationSeconds;
    private String cefrLevel;
    private String topic;
    private String accent;
    private Integer speakerCount;

    private Double speechRate;
    private Double backgroundNoiseLevel;
    private Double vocabularyDifficulty;
    private Double connectedSpeechDifficulty;
    private Double inferenceDifficulty;

    private String channel;
    private String thumbnail;
    private String youtubeVideoId;
    private Boolean practiceAvailable;
    private Boolean hasTranscript;

    private List<TranscriptSegmentDto> segments;
}
