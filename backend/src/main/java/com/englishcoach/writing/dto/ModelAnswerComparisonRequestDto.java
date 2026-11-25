package com.englishcoach.writing.dto;

import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ModelAnswerComparisonRequestDto {

    @Size(max = 128, message = "Task ID must not exceed 128 characters")
    private String taskId;

    @Size(max = 128, message = "Session ID must not exceed 128 characters")
    private String sessionId;

    @Size(max = 4000, message = "Task prompt must not exceed 4000 characters")
    private String taskPrompt;

    @Size(max = 25000, message = "Learner draft must not exceed 25000 characters")
    private String learnerDraft;

    @Size(max = 64, message = "Target register must not exceed 64 characters")
    @Pattern(
            regexp = "(?i)^(formal|informal|neutral|standard|casual|semi-formal|academic|business|professional|academic formal|formal academic|professional business|professional formal|professional / courteous|casual / friendly|neutral / informative|reflective / expressive)$",
            message = "Invalid target register"
    )
    private String targetRegister;

    @Pattern(regexp = "^(A1|A2|B1|B2|C1|C2)$", message = "Learner level must be one of A1, A2, B1, B2, C1, C2")
    private String learnerLevel;
}
