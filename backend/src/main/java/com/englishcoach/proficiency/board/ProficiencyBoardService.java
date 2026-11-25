package com.englishcoach.proficiency.board;

import com.englishcoach.proficiency.ProficiencyProperties;
import com.englishcoach.proficiency.ProficiencyStateRepository;
import com.englishcoach.proficiency.model.OverallStatus;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import com.englishcoach.proficiency.model.SkillStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;

/**
 * Năng lực board read model (Phase 3). Ranking comes only from {@code mv_proficiency_rank}; the
 * caller's own status comes from skill_proficiency / user_proficiency. Never reads evidence.
 */
@Service
@RequiredArgsConstructor
public class ProficiencyBoardService {

    private final ProficiencyProperties props;
    private final ProficiencyBoardRepository repository;
    private final ProficiencyStateRepository stateRepository;

    /**
     * @param rank   visible rank, or the would-be rank against the visible board when hidden; null when the
     *               learner is not on this board (not VERIFIED, excluded account, or view not refreshed yet)
     * @param status VERIFIED / PROVISIONAL / STALE / UNDETERMINED / UNSUPPORTED
     */
    public record Standing(ProficiencyBoardType board, Integer rank, Integer rating, String cefr, String status,
                           String division, boolean hidden) {}

    public List<ProficiencyBoardRepository.BoardRow> top(ProficiencyBoardType board, String division, int limit) {
        return repository.top(board, division, limit);
    }

    public Standing standing(ProficiencyBoardType board, long userId) {
        Optional<ProficiencyStateRepository.StoredUser> user = stateRepository.findUser(userId);
        boolean hidden = user.map(u -> !u.showOnProficiencyBoard()).orElse(false);
        Optional<ProficiencyBoardRepository.BoardRow> row = repository.find(board, userId);
        Integer rank = row.map(r -> r.visible() ? r.rank() : r.wouldBeRank()).orElse(null);
        String division = row.map(ProficiencyBoardRepository.BoardRow::division).orElse(null);

        if (board.skill() == null) {
            OverallStatus status = user.map(ProficiencyStateRepository.StoredUser::overallStatus)
                    .orElse(OverallStatus.UNDETERMINED);
            return new Standing(board, rank, user.map(ProficiencyStateRepository.StoredUser::overallRating).orElse(null),
                    user.map(ProficiencyStateRepository.StoredUser::currentCefr).map(Enum::name).orElse(null),
                    status.name(), division, hidden);
        }
        if (!props.isActive(board.skill())) {
            return new Standing(board, null, null, null, SkillStatus.UNSUPPORTED.name(), null, hidden);
        }
        ProficiencyStateRepository.StoredSkill st = stateRepository.findSkills(userId).get(board.skill());
        if (st == null) {
            return new Standing(board, rank, null, null, SkillStatus.UNDETERMINED.name(), division, hidden);
        }
        return new Standing(board, rank, st.rating(),
                st.rating() == null ? null : ProficiencyCefr.fromRating(st.rating()).name(),
                st.status().name(), division, hidden);
    }

    public void refreshView() {
        repository.refreshView();
    }
}
