package com.englishcoach.coach.dto;

import jakarta.validation.constraints.*;

public record CreateLearningPlanRequest(@NotBlank String currentLevel, @NotBlank String target,
        @Min(5) int dailyMinutes) {
}
