package com.englishcoach.proficiency;

import com.englishcoach.proficiency.model.ProficiencyCefr;

import java.util.Optional;

/**
 * Read API for other modules (Activity's UserLevelProvider adapter). Activity → Proficiency is the
 * only allowed dependency direction; Proficiency never imports leaderboard.activity (except events).
 */
public interface ProficiencyLevelQuery {

    /** Current Level; empty when overall is UNDETERMINED. */
    Optional<ProficiencyCefr> currentLevel(long userId);

    /** max(Current Level, peak_cefr − 1 step); empty when overall is UNDETERMINED. */
    Optional<ProficiencyCefr> activityDivisionLevel(long userId);
}
