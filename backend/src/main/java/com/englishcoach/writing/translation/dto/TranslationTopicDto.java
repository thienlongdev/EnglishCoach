package com.englishcoach.writing.translation.dto;

import lombok.*;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationTopicDto {
    private String code;
    private String displayName;
    private long count;
}
