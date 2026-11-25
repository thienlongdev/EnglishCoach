package com.englishcoach.writing.translation.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.*;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationHintRequest {
    @NotBlank(message = "clientMutationId is required")
    private String clientMutationId;

    private long expectedRevision;

    @NotBlank(message = "action is required: NEXT_HINT, REVEAL_TOKEN, REVEAL_ALL, REVEAL_REFERENCE, HIDE_ALL, or HIDE_REFERENCE")
    private String action; // NEXT_HINT, REVEAL_TOKEN, REVEAL_ALL, REVEAL_REFERENCE, HIDE_ALL, HIDE_REFERENCE

    private Integer tokenIndex; // For REVEAL_TOKEN
}
