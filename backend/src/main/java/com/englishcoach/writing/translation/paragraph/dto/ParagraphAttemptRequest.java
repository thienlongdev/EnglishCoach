package com.englishcoach.writing.translation.paragraph.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphAttemptRequest {

    @NotNull(message = "Ordinal is required")
    private Integer ordinal;

    @NotBlank(message = "Action is required (SUBMIT, REVISE, CONTINUE, SKIP)")
    private String action;

    @NotBlank(message = "clientMutationId is required for idempotency")
    private String clientMutationId;

    private String submittedText;
}
