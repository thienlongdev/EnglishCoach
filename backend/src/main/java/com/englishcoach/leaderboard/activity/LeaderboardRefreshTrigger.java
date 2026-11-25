package com.englishcoach.leaderboard.activity;

/**
 * Asks the board layer for a prompt (debounced) refresh after new score_events rows were committed, so new XP and
 * ranks show within seconds instead of waiting for the periodic refresh. Implemented in {@code leaderboard.board};
 * optional (absent ⇒ only the periodic refresh runs). Must never throw into the caller.
 */
public interface LeaderboardRefreshTrigger {

    void requestRefresh(String reason);
}
