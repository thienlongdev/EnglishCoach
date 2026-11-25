package com.englishcoach.writing.translation.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.*;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationAttemptRequest {
    @NotBlank(message = "clientMutationId is required")
    private String clientMutationId;

    private long expectedRevision;

    private String answerText;

    @NotBlank(message = "action is required: SUBMIT, REVISE, CONTINUE, SKIP")
    private String action; // SUBMIT, REVISE, CONTINUE, SKIP
}
