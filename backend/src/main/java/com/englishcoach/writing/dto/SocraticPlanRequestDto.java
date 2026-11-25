package com.englishcoach.writing.dto;

import jakarta.validation.constraints.Size;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SocraticPlanRequestDto {

    @Size(max = 4000, message = "Task prompt must not exceed 4000 characters")
    private String taskPrompt;

    @Size(max = 8000, message = "Current plan must not exceed 8000 characters")
    private String currentPlan;

    @Size(max = 2000, message = "Learner question must not exceed 2000 characters")
    private String learnerQuestion;
}
