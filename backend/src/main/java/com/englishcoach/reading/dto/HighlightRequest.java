package com.englishcoach.reading.dto;

import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class HighlightRequest {

    private Long materialId;
    private String highlightedText;
    private String colorCode;
    private String userNote;
}
