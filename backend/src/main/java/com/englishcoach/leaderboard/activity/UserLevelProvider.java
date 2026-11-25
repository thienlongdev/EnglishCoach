package com.englishcoach.leaderboard.activity;

import java.util.Optional;

/**
 * Supplies a learner's level to the Activity engine. Activity uses it only for relativeMult
 * (per scored event) and board scope. Implementation: {@link ProficiencyUserLevelProvider}
 * (Phase 2, backed by the Proficiency Engine; undetermined users ⇒ empty).
 */
public interface UserLevelProvider {

    Optional<Cefr> currentLevel(Long userId);

    /** max(Current Level, Peak Level − 1 step) — anti-sandbagging floor for board scope. */
    Optional<Cefr> activityDivisionLevel(Long userId);
}
