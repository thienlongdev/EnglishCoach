package com.englishcoach.proficiency;

import com.englishcoach.proficiency.model.OverallStatus;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import com.englishcoach.proficiency.model.ProficiencySkill;
import com.englishcoach.proficiency.model.SkillStatus;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.EnumMap;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/** Pure §7 behaviour of {@link OverallCalculator}. */
class OverallCalculatorTest {

    static final Instant NOW = Instant.parse("2026-10-01T03:00:00Z");

    private final ProficiencyProperties props = new ProficiencyProperties();
    private final OverallCalculator calc = new OverallCalculator(props);

    private static Map<ProficiencySkill, OverallCalculator.SkillState> skills(OverallCalculator.SkillState... states) {
        Map<ProficiencySkill, OverallCalculator.SkillState> m = new EnumMap<>(ProficiencySkill.class);
        for (OverallCalculator.SkillState s : states) m.put(s.skill(), s);
        return m;
    }

    private static OverallCalculator.SkillState s(ProficiencySkill skill, int rating, double conf, SkillStatus status) {
        return new OverallCalculator.SkillState(skill, rating, conf, status, status == SkillStatus.VERIFIED || status == SkillStatus.STALE);
    }

    @Test
    @DisplayName("Bottleneck: L/R/W C1 VERIFIED, S B1 VERIFIED ⇒ overall ≤ 666 (B2 upper bound)")
    void bottleneck() {
        OverallCalculator.Result r = calc.calculate(skills(
                s(ProficiencySkill.LISTENING, 750, 0.8, SkillStatus.VERIFIED),
                s(ProficiencySkill.READING, 750, 0.8, SkillStatus.VERIFIED),
                s(ProficiencySkill.WRITING, 750, 0.8, SkillStatus.VERIFIED),
                s(ProficiencySkill.SPEAKING, 450, 0.8, SkillStatus.VERIFIED)), OverallCalculator.Previous.none(), NOW, true);
        assertEquals(666, r.overallRating()); // base 675 capped at B2.hi
        assertEquals(ProficiencyCefr.B2, r.currentCefr());
        assertEquals(OverallStatus.VERIFIED, r.status());
    }

    @Test
    @DisplayName("activeSkillCount = 4 (VOCABULARY disabled): overallConfidence = mean × sqrt(3/4)")
    void activeSkillCount() {
        assertEquals(4, props.activeSkills().size());
        assertFalse(props.activeSkills().contains(ProficiencySkill.VOCABULARY));
        OverallCalculator.Result r = calc.calculate(skills(
                s(ProficiencySkill.LISTENING, 600, 0.8, SkillStatus.VERIFIED),
                s(ProficiencySkill.READING, 600, 0.8, SkillStatus.VERIFIED),
                s(ProficiencySkill.SPEAKING, 600, 0.8, SkillStatus.PROVISIONAL)), OverallCalculator.Previous.none(), NOW, true);
        assertEquals(0.69, r.overallConfidence(), 1e-9); // 0.8 × sqrt(0.75) = 0.693
        assertEquals(OverallStatus.VERIFIED, r.status());
    }

    @Test
    @DisplayName("UNDETERMINED: fewer than 3 determined skills, or neither LISTENING nor READING")
    void undetermined() {
        OverallCalculator.Result two = calc.calculate(skills(
                s(ProficiencySkill.LISTENING, 600, 0.8, SkillStatus.VERIFIED),
                s(ProficiencySkill.READING, 600, 0.8, SkillStatus.VERIFIED)), OverallCalculator.Previous.none(), NOW, true);
        assertEquals(OverallStatus.UNDETERMINED, two.status());
        assertNull(two.overallRating());

        Map<ProficiencySkill, OverallCalculator.SkillState> noLR = skills(
                s(ProficiencySkill.WRITING, 600, 0.8, SkillStatus.VERIFIED),
                s(ProficiencySkill.SPEAKING, 600, 0.8, SkillStatus.VERIFIED),
                new OverallCalculator.SkillState(ProficiencySkill.LISTENING, 600, 0.3, SkillStatus.UNDETERMINED, false));
        assertEquals(OverallStatus.UNDETERMINED, calc.calculate(noLR, OverallCalculator.Previous.none(), NOW, true).status());
    }

    @Test
    @DisplayName("Peak never decreases; activityDivisionLevel = max(Current, peak − 1 step)")
    void peakAndDivision() {
        OverallCalculator.Previous prev = new OverallCalculator.Previous(700, ProficiencyCefr.C1, 700, ProficiencyCefr.C1,
                NOW.minusSeconds(86_400), true);
        OverallCalculator.Result r = calc.calculate(skills(
                s(ProficiencySkill.LISTENING, 600, 0.8, SkillStatus.VERIFIED),
                s(ProficiencySkill.READING, 600, 0.8, SkillStatus.VERIFIED),
                s(ProficiencySkill.WRITING, 600, 0.8, SkillStatus.VERIFIED)), prev, NOW, true);
        assertEquals(600, r.overallRating());
        assertEquals(700, r.peakRating());
        assertEquals(ProficiencyCefr.C1, r.peakCefr());
        assertEquals(Optional.of(ProficiencyCefr.B2), OverallCalculator.activityDivisionLevel(r.status(), r.currentCefr(), r.peakCefr()));
        assertEquals(Optional.of(ProficiencyCefr.B2),
                OverallCalculator.activityDivisionLevel(OverallStatus.PROVISIONAL, ProficiencyCefr.B1, ProficiencyCefr.C1));
        assertEquals(Optional.of(ProficiencyCefr.C1),
                OverallCalculator.activityDivisionLevel(OverallStatus.VERIFIED, ProficiencyCefr.C1, ProficiencyCefr.B2));
        assertEquals(Optional.empty(),
                OverallCalculator.activityDivisionLevel(OverallStatus.UNDETERMINED, null, ProficiencyCefr.C1));
    }

    @Test
    @DisplayName("Peak updates only when overall is VERIFIED and the rating is higher")
    void peakUpdate() {
        OverallCalculator.Result provisional = calc.calculate(skills(
                s(ProficiencySkill.LISTENING, 800, 0.4, SkillStatus.PROVISIONAL),
                s(ProficiencySkill.READING, 800, 0.4, SkillStatus.PROVISIONAL),
                s(ProficiencySkill.WRITING, 800, 0.4, SkillStatus.PROVISIONAL)), OverallCalculator.Previous.none(), NOW, true);
        assertNull(provisional.peakRating());
        OverallCalculator.Result verified = calc.calculate(skills(
                s(ProficiencySkill.LISTENING, 800, 0.9, SkillStatus.VERIFIED),
                s(ProficiencySkill.READING, 800, 0.9, SkillStatus.VERIFIED),
                s(ProficiencySkill.WRITING, 800, 0.9, SkillStatus.VERIFIED)), OverallCalculator.Previous.none(), NOW, true);
        assertEquals(800, verified.peakRating());
        assertEquals(ProficiencyCefr.C1, verified.peakCefr());
        assertEquals(NOW, verified.peakReachedAt());
    }

    @Test
    @DisplayName("Nightly mode keeps rating/CEFR/peak; overall STALE when every ever-verified core skill is STALE")
    void nightlyAndStale() {
        OverallCalculator.Previous prev = new OverallCalculator.Previous(650, ProficiencyCefr.B2, 650, ProficiencyCefr.B2, NOW, true);
        OverallCalculator.Result r = calc.calculate(skills(
                s(ProficiencySkill.LISTENING, 640, 0.3, SkillStatus.STALE),
                s(ProficiencySkill.READING, 660, 0.3, SkillStatus.STALE),
                s(ProficiencySkill.WRITING, 650, 0.3, SkillStatus.STALE)), prev, NOW, false);
        assertEquals(OverallStatus.STALE, r.status());
        assertEquals(650, r.overallRating());
        assertEquals(ProficiencyCefr.B2, r.currentCefr());
        assertEquals(650, r.peakRating());
    }
}
