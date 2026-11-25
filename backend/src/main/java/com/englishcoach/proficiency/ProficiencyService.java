package com.englishcoach.proficiency;

import com.englishcoach.proficiency.model.EvidenceRow;
import com.englishcoach.proficiency.model.ProficiencySkill;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Proficiency orchestration. Every public method runs in its own transaction with a per-user
 * advisory lock. Rating fields are written only by {@link #recompute} (new evidence); the nightly
 * {@link #refreshNightly} writes only weight_sum / confidence / status and the snapshot.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ProficiencyService {

    private final ProficiencyProperties props;
    private final ProficiencyEvidenceRepository evidenceRepository;
    private final ProficiencyStateRepository stateRepository;
    private final SkillRatingCalculator skillCalculator;
    private final OverallCalculator overallCalculator;

    /** Stores evidence rows idempotently; returns the rows that were newly inserted. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<EvidenceRow> storeEvidence(List<EvidenceRow> rows) {
        List<EvidenceRow> inserted = new ArrayList<>();
        if (!props.isEnabled() || rows == null || rows.isEmpty()) {
            return inserted;
        }
        rows.stream().map(EvidenceRow::userId).distinct().sorted().forEach(evidenceRepository::lockUser);
        for (EvidenceRow row : rows) {
            if (!props.isActive(row.skill())) {
                continue; // disabled skills (VOCABULARY) never receive evidence
            }
            if (evidenceRepository.insertIfAbsent(row)) {
                inserted.add(row);
            }
        }
        return inserted;
    }

    /**
     * Recompute after new evidence: skills in {@code changedSkills} (or without a stored row) are
     * fully recomputed by {@link SkillRatingCalculator}; other skills only refresh W/confidence/status.
     * Overall is recomputed (rating, CEFR, peak rule).
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recompute(long userId, Set<ProficiencySkill> changedSkills, Instant now) {
        evidenceRepository.lockUser(userId);
        Map<ProficiencySkill, List<SkillRatingCalculator.Input>> evidence = evidenceBySkill(userId);
        Map<ProficiencySkill, ProficiencyStateRepository.StoredSkill> stored = stateRepository.findSkills(userId);
        Map<ProficiencySkill, OverallCalculator.SkillState> states = new EnumMap<>(ProficiencySkill.class);

        for (ProficiencySkill skill : props.activeSkills()) {
            List<SkillRatingCalculator.Input> ev = evidence.getOrDefault(skill, List.of());
            ProficiencyStateRepository.StoredSkill st = stored.get(skill);
            if (ev.isEmpty() && st == null) {
                continue;
            }
            boolean previouslyVerified = st != null && st.everVerified();
            SkillRatingCalculator.Result r;
            if (st == null || changedSkills.contains(skill)) {
                r = skillCalculator.calculate(skill, ev, now, previouslyVerified);
                Instant reached = (st == null || !Objects.equals(st.rating(), r.rating())) ? now : st.ratingReachedAt();
                stateRepository.upsertSkillFromCalculation(userId, r, reached, now);
            } else {
                r = skillCalculator.refresh(skill, ev, now, previouslyVerified, st.rating(), st.sd());
                stateRepository.refreshSkill(userId, skill, r.weightSum(), r.confidence(), r.status(), now);
            }
            states.put(skill, new OverallCalculator.SkillState(skill, r.rating(), r.confidence(), r.status(), r.everVerified()));
        }
        OverallCalculator.Previous prev = previous(userId);
        OverallCalculator.Result overall = overallCalculator.calculate(states, prev, now, true);
        stateRepository.upsertUserFromCalculation(userId, overall, now);
    }

    /**
     * Nightly: never writes skill rating, overall_rating, current_cefr or peak_* (Hardening #5).
     * Updates weight_sum / confidence / status per skill, overall confidence / status, and the snapshot.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void refreshNightly(long userId, Instant now) {
        evidenceRepository.lockUser(userId);
        Map<ProficiencySkill, List<SkillRatingCalculator.Input>> evidence = evidenceBySkill(userId);
        Map<ProficiencySkill, ProficiencyStateRepository.StoredSkill> stored = stateRepository.findSkills(userId);
        Map<ProficiencySkill, OverallCalculator.SkillState> states = new EnumMap<>(ProficiencySkill.class);

        for (ProficiencySkill skill : props.activeSkills()) {
            ProficiencyStateRepository.StoredSkill st = stored.get(skill);
            if (st == null) {
                continue;
            }
            SkillRatingCalculator.Result r = skillCalculator.refresh(skill, evidence.getOrDefault(skill, List.of()), now,
                    st.everVerified(), st.rating(), st.sd());
            stateRepository.refreshSkill(userId, skill, r.weightSum(), r.confidence(), r.status(), now);
            states.put(skill, new OverallCalculator.SkillState(skill, r.rating(), r.confidence(), r.status(), r.everVerified()));
        }
        Optional<ProficiencyStateRepository.StoredUser> user = stateRepository.findUser(userId);
        OverallCalculator.Result overall = overallCalculator.calculate(states, previous(userId), now, false);
        if (user.isPresent()) {
            stateRepository.refreshUser(userId, overall.overallConfidence(), overall.status(), now);
        }
        LocalDate day = now.atZone(ZoneId.of(props.getTimeZone())).toLocalDate();
        stateRepository.upsertSnapshot(userId, day, overall.overallRating(), overall.currentCefr(),
                overall.overallConfidence(), overall.status(), skillsJson(states));
    }

    // ---- helpers --------------------------------------------------------------------------------

    private Map<ProficiencySkill, List<SkillRatingCalculator.Input>> evidenceBySkill(long userId) {
        return evidenceRepository.findByUser(userId).stream().collect(Collectors.groupingBy(
                EvidenceRow::skill,
                () -> new EnumMap<>(ProficiencySkill.class),
                Collectors.mapping(e -> new SkillRatingCalculator.Input(e.id(), e.tier(), e.kind(),
                        e.sourceModule().name(), e.materialKey(), e.observedRating(), e.tierWeight(), e.occurredAt()),
                        Collectors.toList())));
    }

    private OverallCalculator.Previous previous(long userId) {
        return stateRepository.findUser(userId)
                .map(u -> new OverallCalculator.Previous(u.overallRating(), u.currentCefr(), u.peakRating(),
                        u.peakCefr(), u.peakReachedAt(), u.everVerified()))
                .orElse(OverallCalculator.Previous.none());
    }

    private static String skillsJson(Map<ProficiencySkill, OverallCalculator.SkillState> states) {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (OverallCalculator.SkillState s : states.values()) {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"skill\":\"").append(s.skill().name()).append("\",\"rating\":")
                    .append(s.rating() == null ? "null" : s.rating())
                    .append(",\"confidence\":").append(s.confidence())
                    .append(",\"status\":\"").append(s.status().name()).append("\"}");
        }
        return sb.append(']').toString();
    }
}
