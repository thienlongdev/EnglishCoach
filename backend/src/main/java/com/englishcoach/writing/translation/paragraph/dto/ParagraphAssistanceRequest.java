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
public class ParagraphAssistanceRequest {

    @NotNull(message = "Ordinal is required")
    private Integer ordinal;

    @NotBlank(message = "Action is required: GET_SEGMENTS, REVEAL_SEGMENT, REVEAL_WORD, REVEAL_ALL, HIDE_ALL")
    private String action;

    private Integer segmentIndex;
    private Integer wordIndex;
}
