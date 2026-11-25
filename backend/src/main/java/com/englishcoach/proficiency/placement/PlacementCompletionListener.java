package com.englishcoach.proficiency.placement;

/**
 * Optional callback after a placement attempt is stored (no Spring event: proficiency publishes none). The
 * leaderboard implements it to refresh the boards so a new VALID result (eligibility + division) shows at once.
 * Implementations must never throw into the placement request.
 */
public interface PlacementCompletionListener {

    void placementCompleted(long userId);
}
