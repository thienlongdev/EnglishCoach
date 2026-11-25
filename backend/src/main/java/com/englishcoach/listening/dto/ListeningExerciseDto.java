package com.englishcoach.listening.dto;

import com.englishcoach.listening.entity.enums.ExerciseType;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ListeningExerciseDto {
    private Long id;
    private Long listeningMaterialId;
    private Long transcriptSegmentId;
    private ExerciseType exerciseType;
    private String questionText;
    // Do NOT expose expectedAnswer in standard payload to prevent cheating
    private Double difficultyScore;
}
