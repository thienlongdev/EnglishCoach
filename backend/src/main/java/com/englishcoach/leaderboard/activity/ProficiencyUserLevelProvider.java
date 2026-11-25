package com.englishcoach.leaderboard.activity;

import com.englishcoach.proficiency.ProficiencyLevelQuery;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * Phase 2 implementation backed by the Proficiency Engine (replaces the Phase 1 always-empty
 * provider). Dependency direction is Activity → Proficiency only; Proficiency never imports
 * leaderboard.activity (except its event records). Reads only current/peak CEFR + overall status
 * through {@link ProficiencyLevelQuery}; undetermined users stay empty (relativeMult 1.0, GLOBAL).
 */
@Component
@RequiredArgsConstructor
public class ProficiencyUserLevelProvider implements UserLevelProvider {

    private final ProficiencyLevelQuery proficiency;

    @Override
    public Optional<Cefr> currentLevel(Long userId) {
        if (userId == null) {
            return Optional.empty();
        }
        return proficiency.currentLevel(userId).flatMap(c -> Cefr.parse(c.name()));
    }

    @Override
    public Optional<Cefr> activityDivisionLevel(Long userId) {
        if (userId == null) {
            return Optional.empty();
        }
        return proficiency.activityDivisionLevel(userId).flatMap(c -> Cefr.parse(c.name()));
    }
}
