package com.englishcoach.writing.translation.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.*;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationDraftRequest {
    @NotBlank(message = "clientMutationId is required")
    private String clientMutationId;

    private long expectedRevision;

    private String draftText;

    private Short unitOrdinal;
}
