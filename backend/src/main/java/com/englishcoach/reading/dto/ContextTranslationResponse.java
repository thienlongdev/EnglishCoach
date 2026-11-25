package com.englishcoach.reading.dto;

import com.englishcoach.reading.service.ContextTranslationService;

/** Contextual meaning + translation of a selection (My Books). Mirrors FE/types/readingBooks.ts ContextTranslation. */
public record ContextTranslationResponse(
        String meaningInContext,
        String sentenceTranslation,
        String explanation,
        String expressionType,
        String literalMeaning,
        String lemma,
        String partOfSpeech,
        String cefr,
        String register,
        String confidence,
        String ambiguityNote
) {
    public static ContextTranslationResponse of(ContextTranslationService.Result r) {
        return new ContextTranslationResponse(r.meaningInContext(), r.sentenceTranslation(), r.explanation(), r.expressionType(),
                r.literalMeaning(), r.lemma(), r.partOfSpeech(), r.cefr(), r.register(), r.confidence(), r.ambiguityNote());
    }
}
