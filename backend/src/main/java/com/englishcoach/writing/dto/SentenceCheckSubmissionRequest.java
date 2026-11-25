package com.englishcoach.writing.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SentenceCheckSubmissionRequest {

    @NotBlank(message = "Sentence text cannot be blank")
    @Size(max = 2000, message = "Sentence text exceeds maximum limit of 2000 characters")
    private String text;

    @Builder.Default
    @Size(max = 64, message = "Target register must not exceed 64 characters")
    @Pattern(
            regexp = "(?i)^(formal|informal|neutral|standard|casual|semi-formal|academic|business|professional|academic formal|formal academic|professional business|professional formal|professional / courteous|casual / friendly|neutral / informative|reflective / expressive)$",
            message = "Invalid target register"
    )
    private String targetRegister = "formal";

    @Size(max = 300, message = "Context note must not exceed 300 characters")
    private String contextNote;

    @Size(max = 128, message = "Client mutation ID must not exceed 128 characters")
    private String clientMutationId;
}
