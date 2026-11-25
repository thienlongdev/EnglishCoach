package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GardenRules.QualityTier;
import com.englishcoach.garden.domain.GardenRules.Season;

import java.time.Duration;
import java.time.Instant;

/**
 * Harvest quality (02 §5): recall (10 per correct answer, 0 when skipped) + pest (clean unless a Forgotten Pest on the
 * planting was still unreviewed at harvest, Phase 2) + season
 * (in season 20 / Common 10 / off season 0) + care (any water or fertilizer) + freshness (harvested within
 * max(2 h, 50 % of the base time) after becoming ready). Common crops therefore top out at Perfect; only seasonal crops
 * planted or harvested in their theme week can reach Golden.
 */
public final class QualityCalculator {

    public enum SeasonFit { IN_SEASON, ALL_SEASON, OFF_SEASON }

    public record Input(int recallCorrect, boolean skipped, boolean pestClean, SeasonFit seasonFit, boolean cared,
                        boolean fresh) {}

    public record Result(int recall, int pest, int season, int care, int fresh, int total, QualityTier tier) {}

    private final GardenRules rules;
    private final GardenCalendar calendar;

    public QualityCalculator(GardenRules rules) {
        this.rules = rules;
        this.calendar = new GardenCalendar(rules);
    }

    public Result score(Input in) {
        var q = rules.quality();
        return score(in, in.pestClean() ? q.pestClean() : q.pestLate());
    }

    /**
     * Phase 3C: the pest part is given explicitly (staged damage: a warning costs nothing, leaf damage and wilting cost
     * progressively more), bounded to [0, pestClean]; {@code in.pestClean()} is not read.
     */
    public Result score(Input in, int pestPoints) {
        return score(in, pestPoints, in.cared() ? rules.quality().cared() : 0);
    }

    /**
     * Phase 3D: the care part is given explicitly as well (growth model 2: a tended crop on healthy soil keeps the full
     * care score, stressed soil scales it down), bounded to [0, cared]; {@code in.cared()} is not read.
     */
    public Result score(Input in, int pestPoints, int carePoints) {
        var q = rules.quality();
        int recall = in.skipped() ? 0 : Math.max(0, Math.min(rules.challenge().questions(), in.recallCorrect())) * q.recallPerCorrect();
        int pest = Math.max(0, Math.min(q.pestClean(), pestPoints));
        int season = switch (in.seasonFit()) {
            case IN_SEASON -> q.seasonIn();
            case ALL_SEASON -> q.seasonCommon();
            case OFF_SEASON -> q.seasonOff();
        };
        int care = Math.max(0, Math.min(q.cared(), carePoints));
        int fresh = in.fresh() ? q.fresh() : 0;
        int total = recall + pest + season + care + fresh;
        return new Result(recall, pest, season, care, fresh, total, q.tierFor(total));
    }

    /** In season if the crop's theme week matches the week at planting OR at harvest (GDD 03 §4). */
    public SeasonFit seasonFit(CropDef crop, Instant plantedAt, Instant harvestedAt) {
        if (crop.season() == Season.ALL) return SeasonFit.ALL_SEASON;
        boolean in = calendar.theme(plantedAt) == crop.season() || calendar.theme(harvestedAt) == crop.season();
        return in ? SeasonFit.IN_SEASON : SeasonFit.OFF_SEASON;
    }

    public boolean fresh(int baseSeconds, Instant readyAt, Instant harvestedAt) {
        return fresh(baseSeconds, readyAt, harvestedAt, 0);
    }

    /** Phase 3C: the cottage keeps a ripe crop fresh {@code (1 + bonus)} times longer (bonus 0 = the base window). */
    public boolean fresh(int baseSeconds, Instant readyAt, Instant harvestedAt, double bonus) {
        return readyAt != null && !harvestedAt.isAfter(readyAt.plus(freshWindow(rules, baseSeconds, bonus)));
    }

    /** Final unit price: floor(sell price × tier multiplier × blessing × coin scale) (02 §5, §15). */
    public long unitSellPrice(CropDef crop, QualityTier tier, boolean blessing) {
        double price = crop.sellPrice() * tier.sellMultiplier() * (blessing ? rules.blessingSellMultiplier() : 1.0)
                * rules.coinScale();
        return (long) Math.floor(price + 1e-9);
    }

    public int harvestXp(CropDef crop, QualityTier tier) {
        return (int) Math.floor(crop.harvestXp() * tier.xpMultiplier() + 1e-9);
    }

    /** Mutation flag (3 %), deterministic per planting so a replayed harvest yields the same codex form. */
    public boolean mutated(long plantingId) {
        return mutated(plantingId, false);
    }

    /** Phase 2: a harvest inside a rainbow window uses the rainbow chance (same deterministic draw per planting). */
    public boolean mutated(long plantingId, boolean rainbow) {
        double chance = rainbow && rules.weather() != null
                ? Math.max(rules.quality().mutationBase(), rules.weather().rainbowMutation())
                : rules.quality().mutationBase();
        return DeterministicRandom.unit("mutation:" + plantingId) < chance;
    }

    public static Duration freshWindow(GardenRules rules, int baseSeconds) {
        return freshWindow(rules, baseSeconds, 0);
    }

    public static Duration freshWindow(GardenRules rules, int baseSeconds, double bonus) {
        var q = rules.quality();
        double seconds = Math.max(q.freshMinHours() * 3600, q.freshFraction() * baseSeconds) * (1 + Math.max(0, bonus));
        return Duration.ofMillis((long) (seconds * 1000));
    }
}
