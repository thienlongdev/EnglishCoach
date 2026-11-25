package com.englishcoach.reading.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ContextualVocabularyResponse {
    private Long id;
    private String text;
    private String lemma;
    private String pos;
    private String ipa;
    private String cefr;
    private String frequency;
    private String meaningInContext;
    private String nativeExplanation;
    private String sentence;
    private List<CollocationItem> collocations;
    private List<SynonymItem> synonyms;
    private String grammarNote;
    private Long readingMaterialId;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    public record CollocationItem(String phrase, String meaning) {}
    public record SynonymItem(String word, String nuance) {}
}
