package com.englishcoach.writing.translation.dto;

import lombok.*;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationDifficultyDto {
    private String code;
    private String displayName;
    private long count;
}
