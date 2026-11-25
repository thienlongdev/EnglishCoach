package com.englishcoach.reading.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

public record ContextualExplainRequest(
        @NotBlank(message = "Selected text is required")
        @Size(max = 200, message = "Selected text must not exceed 200 characters")
        String text,

        @NotBlank(message = "Surrounding sentence context is required")
        @Size(max = 1500, message = "Surrounding sentence must not exceed 1500 characters")
        String sentence,

        @NotNull(message = "Reading material ID is required")
        Long readingMaterialId,

        @Size(max = 300, message = "Passage title must not exceed 300 characters")
        String passageTitle
) {
}
