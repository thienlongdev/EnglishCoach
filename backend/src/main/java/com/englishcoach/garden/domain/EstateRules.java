package com.englishcoach.garden.domain;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Phase 3C rules (buildings, compost bin, farmland regions, staged pest damage, Echo Contribution), loaded from the
 * Flyway-seeded configuration ({@code garden_config} keys {@code buildings}, {@code compost}, {@code land},
 * {@code pestDamage}, {@code contribution}, V83). Pure value object kept apart from {@link GardenRules},
 * {@link FarmEconomyRules} and {@link LivingRules} so the earlier rule sets and their equivalence checks stay unchanged.
 */
public record EstateRules(Map<String, Building> buildings, Compost compost, Land land, PestDamage pestDamage,
                          Contribution contribution) {

    public static final String COTTAGE = "COTTAGE";
    public static final String WAREHOUSE = "WAREHOUSE";
    public static final String MARKET = "MARKET";

    /**
     * One level of a building: the farm level, coins and produce (any tier, consumed) it costs and the effects it has
     * from then on. Effects are absolute per level (level 2 replaces level 1), never additive.
     */
    public record BuildingLevel(int level, int minLevel, long coins, Map<String, Integer> materials, Map<String, Double> effects) {}

    public record Building(String code, String nameVi, List<BuildingLevel> levels) {

        public int maxLevel() {
            return levels.isEmpty() ? 0 : levels.getLast().level();
        }

        public Optional<BuildingLevel> level(int level) {
            return levels.stream().filter(l -> l.level() == level).findFirst();
        }
    }

    /** A compost recipe: {@code units} produce of {@code minTier} or better become one {@code gives}. */
    public record Recipe(int units, String minTier, String gives) {}

    public record Compost(Recipe standard, Recipe premium) {}

    /** A purchasable bed of a region: its slot, cell, coin price (before the learning discount) and produce. */
    public record LandPlot(int slot, int gx, int gy, long coins, Map<String, Integer> materials) {}

    /**
     * What opens a region: farm level, beds already owned, delivered orders and closed harvests (all recorded facts of
     * this garden). Learning is never part of a gate.
     */
    public record Gate(int level, int plots, int ordersFilled, int harvests) {}

    public record Region(String code, String nameVi, String field, Gate gate, List<LandPlot> plots) {}

    /**
     * {@code learningDiscount}: rows {verified learning days, share of the coin price waived}, the best reached row
     * applies. {@code maxPlots}: the total number of beds a garden can ever own (starter + V80 + regions).
     */
    public record Land(int maxPlots, List<double[]> learningDiscount, List<Region> regions) {

        public Optional<LandPlot> plot(int slot) {
            return regions.stream().flatMap(r -> r.plots().stream()).filter(p -> p.slot() == slot).findFirst();
        }

        public Optional<Region> regionOf(int slot) {
            return regions.stream().filter(r -> r.plots().stream().anyMatch(p -> p.slot() == slot)).findFirst();
        }
    }

    /**
     * Staged damage of a Forgotten Pest on a crop, by hours since it appeared while its word stays unreviewed: warning
     * (no effect) until {@code warnHours}, leaf damage until {@code wiltHours}, then wilting whose growth penalty lasts
     * at most {@code wiltEffectHours}. {@code tendedRelief}: share of the growth penalty removed once the crop was
     * watered or fertilized after the pest appeared.
     */
    public record PestDamage(double warnHours, double wiltHours, double leafFactor, double wiltFactor,
                             double wiltEffectHours, int leafScore, int wiltScore, double tendedRelief) {}

    /** A contribution source: points by tier (tier 1 first; one value = every tier) and whether the caps apply. */
    public record Source(String code, List<Integer> points, boolean capped) {

        public int pointsFor(int tier) {
            if (points.isEmpty()) return 0;
            return points.get(Math.max(0, Math.min(points.size(), tier) - 1));
        }
    }

    public record Contribution(Map<String, Source> sources, int dayCap, int weekCap, int monthCap, int scanLimit,
                               int historyLimit) {}

    public Building building(String code) {
        return buildings.get(code);
    }
}
