package com.englishcoach.listening.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CreateListeningMaterialRequest {
    @NotBlank
    private String title;

    @NotBlank
    private String audioUrl;

    @NotNull
    private Integer durationSeconds;

    private String cefrLevel;
    private String topic;
    private String accent;
    private Double speechRate;
    private Integer speakerCount;
    private Double backgroundNoiseLevel;

    private Double vocabularyDifficulty;
    private Double connectedSpeechDifficulty;
    private Double inferenceDifficulty;

    private List<CreateTranscriptSegmentRequest> segments;
}
