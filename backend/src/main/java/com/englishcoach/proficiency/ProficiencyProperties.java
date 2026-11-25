package com.englishcoach.proficiency;

import com.englishcoach.proficiency.model.EvidenceTier;
import com.englishcoach.proficiency.model.ProficiencySkill;
import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Proficiency Engine configuration ({@code app.proficiency.*}). Defaults = Proficiency Spec
 * (features/proficiency.md). Score anchors are NOT here — they live in proficiency_score_mapping.
 */
@Data
@Configuration
@ConfigurationProperties(prefix = "app.proficiency")
public class ProficiencyProperties {

    /** Master switch for creating evidence / recomputing. */
    private boolean enabled = true;

    private String timeZone = "Asia/Ho_Chi_Minh";

    /** Skills with no server-computed evidence source yet (UNSUPPORTED everywhere). */
    private Set<ProficiencySkill> disabledSkills = EnumSet.of(ProficiencySkill.VOCABULARY);

    /** Tiers that can make a skill VERIFIED (§0.3). */
    private Set<EvidenceTier> verificationTiers = EnumSet.of(EvidenceTier.T1);

    private Map<EvidenceTier, Double> tierWeights = new EnumMap<>(Map.of(
            EvidenceTier.T1, 1.0, EvidenceTier.T2, 0.7, EvidenceTier.T3, 0.35));

    /**
     * P1 + Phase 2.1: form lifecycle states whose COMPLETED results produce exam evidence, and
     * the tier of that evidence. PUBLISHED forms are verification-grade (T1); PILOT forms are not
     * calibrated, so they count as T2 (rating contribution, never VERIFIED). Other states ⇒ none.
     */
    private Map<String, EvidenceTier> examFormTiers = new HashMap<>(Map.of(
            "PUBLISHED", EvidenceTier.T1, "PILOT", EvidenceTier.T2));

    private Rating rating = new Rating();
    private Status status = new Status();
    private Overall overall = new Overall();
    private Nightly nightly = new Nightly();
    private Backfill backfill = new Backfill();
    private Placement placement = new Placement();

    public boolean isActive(ProficiencySkill skill) {
        return !disabledSkills.contains(skill);
    }

    public List<ProficiencySkill> activeSkills() {
        List<ProficiencySkill> out = new ArrayList<>();
        for (ProficiencySkill s : ProficiencySkill.values()) {
            if (isActive(s)) out.add(s);
        }
        return out;
    }

    public double tierWeight(EvidenceTier tier) {
        return tierWeights.getOrDefault(tier, 0.0);
    }

    /** §5 skill rating parameters. */
    @Data
    public static class Rating {
        private int windowDays = 365;
        /** Weight multiplier for repeats of the same (source_module, material_key). */
        private double repeatWeight = 0.0;
        private double t3PerModuleCap = 1.2;
        private double t3PerSkillCap = 2.0;
        private int bucketDays = 30;
        private LocalDate bucketEpoch = LocalDate.of(2026, 1, 1);
        private double halfLifeDays = 90.0;
    }

    /** §6 confidence + status parameters. */
    @Data
    public static class Status {
        private double confidenceWeightScale = 1.5;
        private double sdScale = 300.0;
        private double sdFloor = 0.5;
        private double verifiedConfidence = 0.60;
        private int staleDays = 120;
        private int undeterminedMinEvidence = 2;
        private double undeterminedMinBaseSum = 0.5;
    }

    /** §7 overall parameters. */
    @Data
    public static class Overall {
        private int minDeterminedSkills = 3;
        private Set<ProficiencySkill> requiresOneOf = EnumSet.of(ProficiencySkill.LISTENING, ProficiencySkill.READING);
        private int minVerifiedCoreSkills = 2;
        private double verifiedConfidence = 0.60;
        private boolean bottleneckEnabled = true;
    }

    /** §9 nightly job (02:00 Asia/Ho_Chi_Minh). */
    @Data
    public static class Nightly {
        private boolean enabled = true;
        private String cron = "0 0 2 * * *";
        private int reconciliationLookbackDays = 7;
    }

    /** One-off T1 backfill from historical COMPLETED exam results (default OFF). */
    @Data
    public static class Backfill {
        private boolean enabled = false;
    }

    /** §8 placement CTA (P6). Form ids are environment-specific; empty = CTA only. */
    @Data
    public static class Placement {
        private String ctaUrl = "/exams";
        private Map<ProficiencySkill, String> formIds = new EnumMap<>(ProficiencySkill.class);
    }
}
