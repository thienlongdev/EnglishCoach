package com.englishcoach.proficiency;

import com.englishcoach.proficiency.model.OverallStatus;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import com.englishcoach.proficiency.model.ProficiencySkill;
import com.englishcoach.proficiency.model.SkillStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Pure overall computation (Proficiency Spec §7): determined skills, confidence-weighted base,
 * bottleneck, overall confidence, status (incl. STALE) and the peak rule. No database access.
 */
@Component
@RequiredArgsConstructor
public class OverallCalculator {

    private final ProficiencyProperties props;

    public record SkillState(ProficiencySkill skill, Integer rating, double confidence, SkillStatus status,
                             boolean everVerified) {}

    public record Previous(Integer overallRating, ProficiencyCefr currentCefr, Integer peakRating,
                           ProficiencyCefr peakCefr, Instant peakReachedAt, boolean everVerified) {
        public static Previous none() {
            return new Previous(null, null, null, null, null, false);
        }
    }

    public record Result(Integer overallRating, ProficiencyCefr currentCefr, double overallConfidence,
                         OverallStatus status, Integer peakRating, ProficiencyCefr peakCefr, Instant peakReachedAt,
                         boolean everVerified) {}

    /**
     * @param recomputeRating true only when triggered by new evidence; false for the nightly job,
     *                        which may change confidence/status but never rating, CEFR or peak.
     */
    public Result calculate(Map<ProficiencySkill, SkillState> skills, Previous prev, Instant now, boolean recomputeRating) {
        ProficiencyProperties.Overall o = props.getOverall();
        List<ProficiencySkill> active = props.activeSkills();

        List<SkillState> determined = new ArrayList<>();
        for (ProficiencySkill s : active) {
            SkillState st = skills.get(s);
            if (st != null && st.rating() != null
                    && st.status() != SkillStatus.UNDETERMINED && st.status() != SkillStatus.UNSUPPORTED) {
                determined.add(st);
            }
        }
        boolean hasRequired = determined.stream().anyMatch(st -> o.getRequiresOneOf().contains(st.skill()));
        if (determined.size() < o.getMinDeterminedSkills() || !hasRequired) {
            if (recomputeRating) {
                return new Result(null, null, 0.0, OverallStatus.UNDETERMINED,
                        prev.peakRating(), prev.peakCefr(), prev.peakReachedAt(), prev.everVerified());
            }
            return new Result(prev.overallRating(), prev.currentCefr(), 0.0, OverallStatus.UNDETERMINED,
                    prev.peakRating(), prev.peakCefr(), prev.peakReachedAt(), prev.everVerified());
        }

        // confidence-weighted base
        double sumC = 0.0;
        double sumCR = 0.0;
        double sumR = 0.0;
        double sumConf = 0.0;
        for (SkillState st : determined) {
            sumC += st.confidence();
            sumCR += st.confidence() * st.rating();
            sumR += st.rating();
            sumConf += st.confidence();
        }
        double base = sumC > 0 ? sumCR / sumC : sumR / determined.size();
        int rating = SkillRatingCalculator.round(base);

        // bottleneck: lowest CEFR among VERIFIED core skills → cap at the upper bound of (L + 1 step)
        List<SkillState> verifiedCore = determined.stream().filter(st -> st.status() == SkillStatus.VERIFIED).toList();
        if (o.isBottleneckEnabled() && !verifiedCore.isEmpty()) {
            ProficiencyCefr lowest = verifiedCore.stream()
                    .map(st -> ProficiencyCefr.fromRating(st.rating()))
                    .min(Enum::compareTo).orElseThrow();
            rating = Math.min(rating, lowest.next().hi());
        }

        double overallConfidence = SkillRatingCalculator.round2(
                (sumConf / determined.size()) * Math.sqrt((double) determined.size() / active.size()));

        OverallStatus status = verifiedCore.size() >= o.getMinVerifiedCoreSkills()
                && overallConfidence >= o.getVerifiedConfidence()
                ? OverallStatus.VERIFIED : OverallStatus.PROVISIONAL;
        List<SkillState> everVerifiedCore = new ArrayList<>();
        for (ProficiencySkill s : active) {
            SkillState st = skills.get(s);
            if (st != null && st.everVerified()) everVerifiedCore.add(st);
        }
        if (prev.everVerified() && status != OverallStatus.VERIFIED && !everVerifiedCore.isEmpty()
                && everVerifiedCore.stream().allMatch(st -> st.status() == SkillStatus.STALE)) {
            status = OverallStatus.STALE;
        }
        boolean everVerified = prev.everVerified() || status == OverallStatus.VERIFIED;

        if (!recomputeRating) {
            return new Result(prev.overallRating(), prev.currentCefr(), overallConfidence, status,
                    prev.peakRating(), prev.peakCefr(), prev.peakReachedAt(), everVerified);
        }

        ProficiencyCefr current = ProficiencyCefr.fromRating(rating);
        Integer peakRating = prev.peakRating();
        ProficiencyCefr peakCefr = prev.peakCefr();
        Instant peakAt = prev.peakReachedAt();
        if (status == OverallStatus.VERIFIED && (peakRating == null || rating > peakRating)) {
            peakRating = rating;
            peakCefr = current;
            peakAt = now;
        }
        return new Result(rating, current, overallConfidence, status, peakRating, peakCefr, peakAt, everVerified);
    }

    /** activityDivisionLevel = max(Current Level, peak_cefr − 1 step); UNDETERMINED ⇒ empty. */
    public static Optional<ProficiencyCefr> activityDivisionLevel(OverallStatus status, ProficiencyCefr current,
                                                                  ProficiencyCefr peak) {
        if (status == null || status == OverallStatus.UNDETERMINED || current == null) {
            return Optional.empty();
        }
        if (peak == null) {
            return Optional.of(current);
        }
        ProficiencyCefr floor = peak.previous();
        return Optional.of(floor.compareTo(current) > 0 ? floor : current);
    }
}
