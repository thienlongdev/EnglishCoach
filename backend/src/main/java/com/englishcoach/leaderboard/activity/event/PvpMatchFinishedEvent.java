package com.englishcoach.leaderboard.activity.event;

import java.time.Instant;

/**
 * Published once by {@code CardBlastPvPService#persistMatchDataAsync} after the match, player
 * stats and missed words are saved. One event per match; the listener scores each human player.
 *
 * @param mode      HUMAN or BOT
 * @param guestUserId null when the guest is a bot
 * @param winnerId  raw winner id from the room: a user id, a bot id, or "DRAW"
 * @param endReason KO / FORFEIT / WORDS_EXHAUSTED
 */
public record PvpMatchFinishedEvent(
        Long matchId,
        String mode,
        Long hostUserId,
        Long guestUserId,
        String winnerId,
        String endReason,
        Long durationMs,
        Boolean ranked,
        Integer hostHits,
        Integer guestHits,
        Long deckId,
        Instant occurredAt
) {}
