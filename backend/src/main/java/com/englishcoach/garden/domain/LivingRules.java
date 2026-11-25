package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.GardenRules.Rarity;

import java.util.List;
import java.util.Map;

/**
 * Phase 3B rules (monument, crop mastery, crop skins), loaded from the Flyway-seeded configuration ({@code garden_config}
 * keys {@code monument}, {@code mastery} and the {@code garden_skin_def} catalogue, V82). Pure value object kept apart from
 * {@link GardenRules} / {@link FarmEconomyRules} so the Phase 1–3A rule sets and their equivalence checks stay unchanged.
 */
public record LivingRules(Monument monument, Mastery mastery, Map<String, SkinDef> skins) {

    /** A skill branch of the monumental Knowledge Tree: one verified learning source each. */
    public enum Family { VOCABULARY, LISTENING, SPEAKING, WRITING, EXAM }

    /** Era {@code era} needs all of: verified learning days, credited graduations, branch tiers summed over the families. */
    public record EraGate(int era, int days, int graduations, int branchTiers) {}

    /**
     * {@code minCardReviews}: different cards reviewed on a Vietnam day for a verified vocabulary day.
     * {@code familySources}: the learning source of each branch ({@code FLASHCARD} = the Flashcard review log);
     * {@code playSources}: sources that verify a day without feeding a branch. {@code branchTiers} / {@code memoryTiers}:
     * thresholds of ornament tiers 1..n. A graduated tree is credited when at least {@code minNewWords} of its words were
     * never credited before. After the last era a ring is recorded every {@code ringEveryDays} further verified days.
     * {@code scanDays}, {@code overlapHours}, {@code creditBatch}, {@code historyLimit}: read bounds.
     */
    public record Monument(int minCardReviews, int scanDays, int overlapHours, int creditBatch, int historyLimit,
                           Map<Family, String> familySources, List<String> playSources, List<Integer> branchTiers,
                           List<Integer> memoryTiers, int minNewWords, List<EraGate> eras, int ringEveryDays) {

        public int maxEra() {
            return eras.isEmpty() ? 0 : eras.getLast().era();
        }
    }

    /**
     * Mastery tier {@code tier} of a crop: harvests (scaled by rarity), best quality tier rank reached, distinct seasons
     * harvested in and codex forms discovered.
     */
    public record MasteryTier(int tier, int harvests, int bestTier, int seasons, int forms) {}

    public record Mastery(List<MasteryTier> tiers, Map<Rarity, Double> rarityScale) {

        public int maxTier() {
            return tiers.isEmpty() ? 0 : tiers.getLast().tier();
        }
    }

    /**
     * A cosmetic cultivar of one crop. {@code unlockKind}: MASTERY (earned at {@code masteryTier} of its crop), COIN
     * (bought for {@code coinPrice}; a {@code masteryTier} above 0 is an extra prerequisite), LEARNING (earned at
     * {@code learningDays} verified learning days). A skin never changes growth, quality, price, XP or chance.
     */
    public record SkinDef(String code, String cropCode, String nameVi, String descriptionVi, String unlockKind,
                          long coinPrice, int masteryTier, int learningDays, String artKey, int sortOrder) {}

    public SkinDef skin(String code) {
        return skins.get(code);
    }
}
