package com.englishcoach.writing.translation.dto;

import lombok.*;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationCollectionDto {
    private java.util.UUID exerciseId;
    private String mode;
    private String topicCode;
    private String topicDisplayName;
    private String difficultyBucket;
    private String difficultyDisplayName;
    private long exerciseCount;
    private long sentenceCount;
}
