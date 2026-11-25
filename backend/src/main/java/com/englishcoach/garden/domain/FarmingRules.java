package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.GardenRules.Season;

import java.util.List;
import java.util.Map;

/**
 * Phase 3D rules (soil moisture, farming supplies, the small harvest coin bonus), loaded from the Flyway-seeded
 * configuration ({@code garden_config} key {@code farming}, V85). Pure value object kept apart from {@link GardenRules},
 * {@link FarmEconomyRules}, {@link LivingRules} and {@link EstateRules} so the earlier rule sets and their equivalence
 * checks stay unchanged. A garden without this configuration runs the Phase 3C rules (no soil, no supplies, no bonus).
 */
public record FarmingRules(Soil soil, Map<String, Double> thirst, Map<String, Item> items, HarvestBonus harvestBonus) {

    /** What a supply does (see the V85 comment for the meaning of {@code hours} and {@code value} per effect). */
    public enum Effect { BOOST, MOISTURE, MULCH, RAIN_COVER, SHADE, DRAINAGE, TONIC, PEST_SPRAY, PEST_NET }

    /** Shop category of a supply. Seeds are the market's packs and are not items of this catalogue. */
    public enum Category { CARE, WEATHER, PEST, UTILITY }

    /**
     * Soil moisture 0..100 of a growing crop: {@code start} when sown; lost at {@code evapPerHour} (× crop thirst ×
     * {@code seasonEvap} of the theme week, × {@code rainbowEvap} under a rainbow) and gained at {@code rainPerHour} in
     * rain. Below {@code dryBelow} the crop grows at {@code dryFactor}, above {@code wetAbove} at {@code wetFactor}; the
     * slowdown is counted for at most {@code maxStressHours} per planting. {@code careShare}: rows {stressed share of the
     * growing time, factor of the harvest care points}; beyond the last row the factor is 0. A crop stressed for more
     * than {@code severeShare} of its growing time is harvested at {@code severeTierCap} at best.
     */
    public record Soil(double start, double dryBelow, double wetAbove, double evapPerHour, double rainPerHour,
                       double rainbowEvap, double dryFactor, double wetFactor, double maxStressHours, double waterGain,
                       Map<Season, Double> seasonEvap, List<double[]> careShare, double severeShare, String severeTierCap) {}

    /** A supply: shop category, effect, how long it lasts (0 = instant or until harvest) and its effect value. */
    public record Item(String code, Category category, Effect effect, double hours, double value) {}

    /** Coins per closed harvest = max({@code min}, round(sell price × {@code share})), at most {@code dailyCap} a day. */
    public record HarvestBonus(double share, int min, int dailyCap) {}

    public double thirstOf(String cropCode) {
        return thirst.getOrDefault(cropCode, 1.0);
    }

    public Item item(String code) {
        return items.get(code);
    }
}
