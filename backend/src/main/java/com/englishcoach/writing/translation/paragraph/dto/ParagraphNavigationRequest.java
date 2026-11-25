package com.englishcoach.writing.translation.paragraph.dto;

import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphNavigationRequest {
    @NotNull(message = "targetOrdinal is required")
    private Integer targetOrdinal;
}
