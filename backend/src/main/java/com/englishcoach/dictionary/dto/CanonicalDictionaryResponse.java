package com.englishcoach.dictionary.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CanonicalDictionaryResponse {
    private String query;
    private String normalizedQuery;
    private String entryType; // WORD, PHRASAL_VERB, IDIOM, COLLOCATION, EXPRESSION
    private String headword;
    private String cefr;
    private String source;
    private String generalTranslationVi;
    private String searchedForm;
    private String inflectionNote;

    private List<PronunciationDto> pronunciations;
    private List<PartOfSpeechGroupDto> partsOfSpeech;
    private List<String> forms;
    private List<CollocationDto> collocations;
    private List<PhrasalVerbDto> phrasalVerbs;
    private List<IdiomDto> idioms;
    private List<IdiomDto> expressions;
    private List<String> relatedWords;

    /**
     * Build revision of this payload (owner brief 2026-10-24). A stored payload of an older revision (null = 1, built
     * with GTX terms assigned to senses by position) is never served as it is: the engine rebuilds it.
     */
    private Integer lexiconRevision;
    /**
     * The word's Vietnamese senses from the local EN–VI dictionary, grouped by part of speech in the dictionary's
     * own order. NOT aligned with {@link #partsOfSpeech}: a sense's own {@code translationVi} is set only when a source
     * gives it for that sense.
     */
    private List<VietnameseSenseGroupDto> vietnameseSenses;
    /** Attribution of {@link #vietnameseSenses} (the dataset's licence requires it). */
    private String vietnameseSource;
    /** Word-level synonyms / antonyms (Datamuse knows no senses, so they never sit on one sense). */
    private List<String> synonyms;
    private List<String> antonyms;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class VietnameseSenseGroupDto {
        private String partOfSpeech;
        private List<String> meanings;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class PronunciationDto {
        private String ipa;
        private String region;
        private String audioUrl;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class PartOfSpeechGroupDto {
        private String partOfSpeech;
        private List<SenseDto> senses;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SenseDto {
        private String id;
        private String definitionEn;
        private String translationVi;
        private String register;
        private List<String> labels;
        private List<String> examples;
        private List<String> synonyms;
        private List<String> antonyms;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class CollocationDto {
        private String phrase;
        private String pattern;
        private Integer score;
        private String source;
        private String example;
        private String translationVi;
        private Boolean hasExactEntry;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class PhrasalVerbDto {
        private String phrase;
        private String shortMeaning;
        private String translationVi;
        private List<String> examples;
        private List<SenseDto> senses;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class IdiomDto {
        private String phrase;
        private String shortMeaning;
        private String translationVi;
        private List<String> examples;
    }
}
