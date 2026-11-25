package com.englishcoach.listening.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CreateTranscriptSegmentRequest {
    @NotNull
    private Integer startTimeMs;

    @NotNull
    private Integer endTimeMs;

    private String speakerName;

    @NotBlank
    private String text;

    private Double difficultyScore;
}
