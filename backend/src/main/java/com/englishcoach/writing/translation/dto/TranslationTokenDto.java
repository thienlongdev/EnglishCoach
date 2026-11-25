package com.englishcoach.writing.translation.dto;

import lombok.*;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationTokenDto {
    private int index;
    private String firstChar;
    private int length;
    private String leadingPunct;
    private String trailingPunct;
    private boolean revealed;
    private String word; // null if unrevealed to prevent network leakage
    private boolean punctuationOnly;
}
