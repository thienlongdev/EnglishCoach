package com.englishcoach.garden.domain;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * Every Echo Garden balance number, loaded from the Flyway-seeded configuration tables ({@code garden_config},
 * {@code garden_crop_def}, {@code garden_item_def}). Pure value object: no Spring, no database. Logic classes receive
 * it through their constructor so tests and the economy simulator run the exact same rules as production.
 */
public record GardenRules(
        ZoneId zone,
        Growth growth,
        Seasons seasons,
        Quality quality,
        Rewards rewards,
        Level level,
        Challenge challenge,
        Starter starter,
        double blessingSellMultiplier,
        double coinScale,
        Map<String, CropDef> crops,
        Map<String, BoostItem> boosts,
        WeatherRules weather,
        PestRules pests,
        KnowledgeRules knowledge,
        LearningRules learning) {

    public enum Rarity { COMMON, RARE, EPIC, LEGENDARY }

    /** A crop's season: {@code ALL} = Common crops, otherwise one theme week. */
    public enum Season { ALL, LU_HANH, CONG_SO, HOC_THUAT, THANH_NGU }

    public record CropDef(String code, String nameVi, Rarity rarity, int baseSeconds, int seedPrice, int seedEssence,
                          int sellPrice, Season season, int unlockLevel, int harvestXp, boolean seedInFixedShop,
                          boolean qaOnly, int sortOrder) {

        /**
         * Seed bought at planting time (reconciliation R1; Phase 2 adds Epic seeds, which also cost
         * {@code seedEssence}). Legendary seeds are never sold: they come only from graduating a Knowledge Tree.
         */
        public boolean purchasable() {
            return seedInFixedShop && seedPrice >= 0
                    && (rarity == Rarity.COMMON || rarity == Rarity.RARE || rarity == Rarity.EPIC || qaOnly);
        }
    }

    /**
     * A care item: reduces the required growth work by {@code fraction}; {@code group} WATER or FERTILIZER (one
     * fertilizer of either kind per planting). {@code coinPrice}: the Phase 3 fixed-shop price, used by the economy
     * check A6 only (Phase 1 sells no care items).
     */
    public record BoostItem(String code, String nameVi, String group, double fraction, int perPlantingLimit,
                            Integer coinPrice) {}

    public record QualityTier(String code, int minScore, double sellMultiplier, double xpMultiplier) {}

    /** {@code stageThresholds}: progress fractions where visual stage 2 and 3 begin (stage 4 = ready). */
    public record Growth(double maxBoost, double speedFloor, double inSeason, double offSeason, double allSeason,
                         int tutorialSeconds, String tutorialCrop, double[] stageThresholds, int estimateHorizonDays) {}

    public record Seasons(LocalDate epochMonday, List<Season> order) {}

    public record Quality(List<QualityTier> tiers, int recallPerCorrect, int pestClean, int pestLate, int seasonIn,
                          int seasonCommon, int seasonOff, int cared, int fresh, double freshMinHours,
                          double freshFraction, double mutationBase, int moonlitFromHour, int moonlitToHour,
                          int newFormXp) {

        public QualityTier tierFor(int score) {
            return tiers.stream().filter(t -> score >= t.minScore())
                    .max(Comparator.comparingInt(QualityTier::minScore)).orElse(tiers.getFirst());
        }

        public QualityTier tier(String code) {
            return tiers.stream().filter(t -> t.code().equals(code)).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("unknown tier " + code));
        }
    }

    /**
     * {@code diminishing}: rows {upToRawUnits, rate}; {@code repeatSameDayUnit}: units for a further review of the same
     * card on the same day (reconciliation R2). Goal: {@code goalUnits} effective units, the due queue empty after
     * at least {@code goalDueMinReviews} reviews, or (Phase 2) {@code goalMixUnits} units plus {@code goalMixSkills}
     * credited skill lessons the same day. {@code harvestXpDiminishing} (Phase 2): rows {upToRawXp, rate} applied to the
     * day's harvest XP (tier-adjusted crop XP; codex discoveries excluded), so farming volume cannot outrun learning.
     */
    public record Rewards(double unitsPerWater, List<double[]> diminishing, double reviewUnit, double repeatSameDayUnit,
                          double xpPerUnit, double goalUnits, int goalDueMinReviews, int goalXp, double goalMixUnits,
                          int goalMixSkills, List<double[]> harvestXpDiminishing) {}

    public record Level(double a, double p, double b) {}

    public record Challenge(int questions, int reverseQuestions, int options, int expirySeconds, int recentDays) {}

    public record Cell(int x, int y) {}

    /** Starter pack (02 §14) and the starter plot cells (slot order). */
    public record Starter(long coins, Map<String, Integer> items, List<Cell> plots) {}

    // ------------------------------------------------------------------ Phase 2

    /**
     * Global weather timeline (Phase 2): windows of {@code windowHours} from {@code startAt}; per season the chance of
     * rain and the chance of a rainbow in the window right after rain. Rain multiplies growth speed by
     * {@code rainSpeed}; a harvest inside a rainbow window uses {@code rainbowMutation} as its mutation chance.
     * {@code forecastWindows}: how many windows after the current one the forecast reveals.
     */
    public record WeatherRules(java.time.Instant startAt, int windowHours, double rainSpeed, double rainbowMutation,
                               int forecastWindows, Map<Season, double[]> chances) {}

    /**
     * Forgotten Pests: a card overdue by more than {@code graceHours} may host one pest. At most {@code maxCropPests}
     * pests sit on crops; a crop pest slows growth by {@code growthFactor} for at most {@code effectHours}; crops
     * planted less than {@code protectMinutes} ago (and tutorial crops) are never hosts. Sending a reviewed pest away
     * grants {@code cureXp}, at most {@code cureDailyCap} times per day.
     */
    public record PestRules(double graceHours, int maxCropPests, double growthFactor, double effectHours,
                            int protectMinutes, int cureXp, int cureDailyCap, int scanLimit) {}

    /** Stage {@code stage} is reached with at least {@code minEvidence} evidence, {@code minAgeDays} and every card at
     *  {@code minPerCard} or more. */
    public record StageRule(int stage, int minEvidence, int minAgeDays, int minPerCard) {}

    public record Graduation(int minAgeDays, int minPerCard, int questions, int reverseQuestions, int pass,
                             int retryMinutes, int xp, int essence, Map<String, Integer> items) {}

    /**
     * Knowledge Trees: {@code slotLevels[i]} = level that opens sacred spot i + 1; evidence of a card = distinct VN days
     * it was reviewed after planting, capped at {@code evidenceCap}; {@code essencePerDay[stage]} accrues up to
     * {@code essenceStoreDays} days of the current rate.
     */
    public record KnowledgeRules(List<Integer> slotLevels, int cards, int evidenceCap, List<StageRule> stages,
                                 Graduation graduation, double[] essencePerDay, double essenceStoreDays,
                                 int candidateLimit) {}

    /** A learning source adapter: {@code category} SKILL or GAME; {@code minCount} its qualifying threshold. */
    public record SourceRule(String code, String category, boolean enabled, int minCount) {}

    /** Rewards per credited activity of a category, the daily cap and how many of them also grant a fertilizer. */
    public record CategoryRule(int xp, int dailyCap, int fertilizerFirst) {}

    public record LearningRules(Map<String, SourceRule> sources, Map<String, CategoryRule> categories,
                                int lookbackDays, int batchLimit) {}

    public CropDef crop(String code) {
        CropDef c = crops.get(code);
        if (c == null) throw new IllegalArgumentException("unknown crop " + code);
        return c;
    }
}
