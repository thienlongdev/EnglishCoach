package com.englishcoach.leaderboard.activity.event;

import java.time.Instant;

/**
 * Published once by {@code FlashcardService#recordCardBlastRun} after the run is saved.
 * {@code score}, {@code accuracyPct} (0–100), {@code hits} (words typed correctly) and {@code attempts}
 * (hits + misses) are CLIENT-REPORTED — never Proficiency evidence. {@code hits} / {@code attempts} are null for
 * runs recorded by older clients and for the backfill (the score proxy is used then).
 */
public record CardBlastRunFinishedEvent(
        Long userId,
        Long runId,
        Long deckId,
        Integer score,
        Double accuracyPct,
        Integer weakWordsCount,
        Integer hits,
        Integer attempts,
        Instant occurredAt
) {
    /** Run without hit counts (older clients, backfill). */
    public CardBlastRunFinishedEvent(Long userId, Long runId, Long deckId, Integer score, Double accuracyPct,
                                     Integer weakWordsCount, Instant occurredAt) {
        this(userId, runId, deckId, score, accuracyPct, weakWordsCount, null, null, occurredAt);
    }
}
