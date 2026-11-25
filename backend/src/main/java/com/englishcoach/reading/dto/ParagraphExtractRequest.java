package com.englishcoach.reading.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record ParagraphExtractRequest(
        @NotBlank(message = "Passage content is required")
        @Size(max = 8000, message = "Passage must not exceed 8000 characters")
        String passage,

        @NotNull(message = "Reading material ID is required")
        Long readingMaterialId,

        @Size(max = 300, message = "Passage title must not exceed 300 characters")
        String passageTitle,

        Integer maxItems
) {
}
