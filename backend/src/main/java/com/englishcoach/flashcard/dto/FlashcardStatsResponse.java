package com.englishcoach.flashcard.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public record FlashcardStatsResponse(
    long totalCards,
    long dueCards,
    long learningCards,
    long masteredCards
) {
    @JsonProperty("totalCount")
    public long totalCount() {
        return totalCards;
    }

    @JsonProperty("dueCount")
    public long dueCount() {
        return dueCards;
    }

    @JsonProperty("learningCount")
    public long learningCount() {
        return learningCards;
    }

    @JsonProperty("masteredCount")
    public long masteredCount() {
        return masteredCards;
    }
}
