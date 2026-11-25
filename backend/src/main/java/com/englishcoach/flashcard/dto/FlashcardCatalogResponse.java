package com.englishcoach.flashcard.dto;

import java.util.List;

/** Shared metadata only; deliberately has no user progress or dictionary bodies. */
public record FlashcardCatalogResponse(String catalogRevision, int totalDecks, long totalWords,
                                       List<Deck> decks) {
    public record Deck(Long id, String slug, String title, String description, String category,
                       String themeColor, String icon, int totalWords, boolean isSystem, int sortOrder) {}
    public record Progress(Long deckId, long totalCards, long masteredCount, long reviewedCount,
                           long learningCount, long dueCount, List<String> latestRatings) {
        public Progress(Long deckId,long totalCards,long masteredCount,long reviewedCount,long learningCount,long dueCount) {
            this(deckId,totalCards,masteredCount,reviewedCount,learningCount,dueCount,List.of());
        }
    }
}
