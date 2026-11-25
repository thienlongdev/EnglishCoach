package com.englishcoach.content.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ContentVocabularyDto {
    private Long id;
    private String word;
    private String lemma;
    private String phonetic;
    private String meaning;
    private String exampleSentence;
    private Integer frequency;
}
