package com.englishcoach.reading.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * My Books: explicit contextual explanation of selected text from a book that stays on the learner's device.
 * Carries only the selection, its sentence and a bounded context — never a book, a file or a Reading material id.
 */
public record BookSelectionExplainRequest(
        @NotBlank(message = "Selected text is required")
        @Size(max = 300, message = "Selected text is too long")
        String text,

        @NotBlank(message = "Surrounding sentence context is required")
        @Size(max = 1200, message = "Sentence is too long")
        String sentence,

        @Size(max = 2000, message = "Context is too long")
        String context,

        @Size(max = 200)
        String bookTitle,

        @Size(max = 200)
        String bookAuthor
) {
}
