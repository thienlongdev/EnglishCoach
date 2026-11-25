package com.englishcoach.flashcard.dto;

import java.util.List;

/**
 * The end of a solo Card Blast run. {@code runId} is the id the server issued when the run started
 * ({@code POST /flashcards/card-blast/start-run}); without it the result is not counted. Every number is a claim of the
 * client and is bounded on the server before it is stored or scored.
 */
public record CardBlastFinishRunRequest(
    Long deckId,
    Integer score,
    Double accuracy,
    List<Long> weakWordIds,
    Integer hits,
    Integer totalAttempts,
    String runId
) {
    public CardBlastFinishRunRequest(Long deckId, Integer score, Double accuracy, List<Long> weakWordIds) {
        this(deckId, score, accuracy, weakWordIds, null, null, null);
    }

    public CardBlastFinishRunRequest(Long deckId, Integer score, Double accuracy, List<Long> weakWordIds,
                                     Integer hits, Integer totalAttempts) {
        this(deckId, score, accuracy, weakWordIds, hits, totalAttempts, null);
    }
}
