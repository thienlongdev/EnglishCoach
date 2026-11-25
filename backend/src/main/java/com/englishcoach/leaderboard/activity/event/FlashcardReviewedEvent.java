package com.englishcoach.leaderboard.activity.event;

import java.time.Instant;

/**
 * Published once by {@code FlashcardService#reviewFlashcard} after the card is saved.
 * Feeds FLASHCARD_REVIEW / FLASHCARD_NEW / FLASHCARD_MASTERED (Activity) and Phase 2.
 *
 * @param quality        normalized review quality as received ("again", "hard", "good", "easy", …)
 * @param previousStatus card status before the review (NEW / LEARNED / MASTERED)
 * @param newStatus      card status after the review
 * @param contentCefr    {@code dictionary_entries.cefr} (nullable)
 */
public record FlashcardReviewedEvent(
        Long userId,
        Long flashcardId,
        Integer reviewCount,
        String quality,
        String previousStatus,
        String newStatus,
        Long dictionaryEntryId,
        String contentCefr,
        Long deckId,
        Instant occurredAt
) {}
