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
public class ParagraphDraftRequest {

    @NotNull(message = "ordinal is required")
    private Integer ordinal;

    @NotNull(message = "draftText is required")
    private String draftText;

    @NotNull(message = "expectedRevision is required")
    private Long expectedRevision;

    @NotBlank(message = "clientMutationId is required")
    private String clientMutationId;
}
