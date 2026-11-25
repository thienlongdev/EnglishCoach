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
public class ExerciseAttemptRequest {
    private Long listeningSessionId;

    @NotBlank
    private String rawUserAnswer;
}
