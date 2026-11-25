package com.englishcoach.flashcard.dto;

/**
 * The sense a curated SYSTEM topic deck teaches for one word (V106, owner brief 2026-10-30): part of speech, the
 * Vietnamese meaning of that sense, an example showing it and the example's Vietnamese translation. Read from the deck
 * link (deck_dictionary_entries), never from the shared dictionary row.
 */
public record DeckSense(String partOfSpeech, String meaningVi, String example, String exampleVi, String definitionEn, String sourceKind, String referenceLevel, String referenceIpa) {}
