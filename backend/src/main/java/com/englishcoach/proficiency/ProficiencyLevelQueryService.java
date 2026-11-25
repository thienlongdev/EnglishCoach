package com.englishcoach.proficiency;

import com.englishcoach.proficiency.model.OverallStatus;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.Optional;

/** {@link ProficiencyLevelQuery} backed by {@code user_proficiency} (current/peak CEFR + overall status). */
@Service
@RequiredArgsConstructor
public class ProficiencyLevelQueryService implements ProficiencyLevelQuery {

    private final ProficiencyStateRepository stateRepository;

    @Override
    public Optional<ProficiencyCefr> currentLevel(long userId) {
        return stateRepository.findUser(userId)
                .filter(u -> u.overallStatus() != OverallStatus.UNDETERMINED)
                .map(ProficiencyStateRepository.StoredUser::currentCefr);
    }

    @Override
    public Optional<ProficiencyCefr> activityDivisionLevel(long userId) {
        return stateRepository.findUser(userId)
                .flatMap(u -> OverallCalculator.activityDivisionLevel(u.overallStatus(), u.currentCefr(), u.peakCefr()));
    }
}
