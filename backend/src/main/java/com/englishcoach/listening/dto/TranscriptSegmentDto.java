package com.englishcoach.listening.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranscriptSegmentDto {
    private Long id;
    private Integer startTimeMs;
    private Integer endTimeMs;
    private String speakerName;
    private String text;
    private Double difficultyScore;
    private java.util.List<WordTimestampDto> words;
}

