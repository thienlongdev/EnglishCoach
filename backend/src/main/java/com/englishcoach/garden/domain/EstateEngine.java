package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.EstateRules.Building;
import com.englishcoach.garden.domain.EstateRules.BuildingLevel;
import com.englishcoach.garden.domain.EstateRules.Gate;
import com.englishcoach.garden.domain.EstateRules.LandPlot;
import com.englishcoach.garden.domain.EstateRules.PestDamage;
import com.englishcoach.garden.domain.EstateRules.Region;
import com.englishcoach.garden.domain.GrowthCalculator.Slowdown;
import com.englishcoach.garden.domain.PestPlanner.Host;
import com.englishcoach.garden.domain.PestPlanner.PestFacts;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Phase 3C pure rules (no Spring, no database, explicit instants): what building levels change, what a bed of a region
 * costs, how a Forgotten Pest's damage progresses and how many contribution points a fact is worth under the caps.
 * Kept beside {@link GardenEngine} / {@link LivingEngine} so the earlier engines and their tests are untouched.
 */
public final class EstateEngine {

    /**
     * What the buildings of one garden change. Everything is bounded by the seeded levels: no price is touched, no
     * growth speed, no XP and no learning reward.
     */
    public record Perks(double freshBonus, int forecastExtra, int compostDaily, int premiumCompostDaily, int featuredExtra,
                        int stapleCapExtra, int packCapExtra) {

        public static final Perks NONE = new Perks(0, 0, 0, 0, 0, 0, 0);
    }

    /** Damage stage of a crop pest. RESOLVED = its word was genuinely reviewed (the pest only waits to be sent away). */
    public enum PestStage { RESOLVED, WARNING, LEAF, WILT }

    /** Facts of a region against its gate (the region is open when every part is met). */
    public record GateCheck(boolean levelOk, boolean plotsOk, boolean ordersOk, boolean harvestsOk) {

        public boolean open() {
            return levelOk && plotsOk && ordersOk && harvestsOk;
        }
    }

    private final EstateRules rules;

    public EstateEngine(EstateRules rules) {
        this.rules = rules;
    }

    public EstateRules rules() {
        return rules;
    }

    // ------------------------------------------------------------------ buildings

    private double effect(String building, int level, String key) {
        Building b = rules.building(building);
        if (b == null || level <= 0) return 0;
        return b.level(Math.min(level, b.maxLevel())).map(l -> l.effects().getOrDefault(key, 0.0)).orElse(0.0);
    }

    /** The perks of a garden from its building levels (a missing building = level 0 = no perk). */
    public Perks perks(Map<String, Integer> levels) {
        int cottage = levels.getOrDefault(EstateRules.COTTAGE, 0);
        int warehouse = levels.getOrDefault(EstateRules.WAREHOUSE, 0);
        int market = levels.getOrDefault(EstateRules.MARKET, 0);
        return new Perks(effect(EstateRules.COTTAGE, cottage, "freshBonus"),
                (int) effect(EstateRules.COTTAGE, cottage, "forecastExtra"),
                (int) effect(EstateRules.WAREHOUSE, warehouse, "compostDaily"),
                (int) effect(EstateRules.WAREHOUSE, warehouse, "premiumCompostDaily"),
                (int) effect(EstateRules.MARKET, market, "featuredExtra"),
                (int) effect(EstateRules.MARKET, market, "stapleCapExtra"),
                (int) effect(EstateRules.MARKET, market, "packCapExtra"));
    }

    /** The level a building can be raised to next, or empty at its top level. */
    public Optional<BuildingLevel> nextLevel(String building, int currentLevel) {
        Building b = rules.building(building);
        return b == null ? Optional.empty() : b.level(currentLevel + 1);
    }

    // ------------------------------------------------------------------ land

    /** Share of a bed's coin price waived for a learner with this many verified learning days (0 for none). */
    public double learningDiscount(int learningDays) {
        double best = 0;
        for (double[] row : rules.land().learningDiscount()) {
            if (learningDays >= row[0]) best = Math.max(best, row[1]);
        }
        return Math.max(0, Math.min(0.9, best));
    }

    /** Coins a bed costs this garden right now: the seeded price minus the learning discount, rounded down. */
    public long landPrice(LandPlot plot, int learningDays) {
        return (long) Math.floor(plot.coins() * (1 - learningDiscount(learningDays)) + 1e-9);
    }

    public GateCheck gate(Region region, int level, int plotsOwned, int ordersFilled, int harvests) {
        Gate g = region.gate();
        return new GateCheck(level >= g.level(), plotsOwned >= g.plots(), ordersFilled >= g.ordersFilled(), harvests >= g.harvests());
    }

    /** The next bed of a region that may be bought (in order), given the slots already owned; empty when all are owned. */
    public Optional<LandPlot> nextPlot(Region region, Set<Integer> ownedSlots) {
        return region.plots().stream().filter(p -> !ownedSlots.contains(p.slot())).findFirst();
    }

    // ------------------------------------------------------------------ pests

    private static Duration hours(double h) {
        return Duration.ofSeconds(Math.round(h * 3600));
    }

    /**
     * Stage of a crop pest at {@code now}: RESOLVED once its word was reviewed (or the pest is gone), otherwise by the
     * time since it appeared. A stage never goes back except through the review.
     */
    public PestStage stage(PestFacts p, Instant now) {
        if (p.reviewedAt() != null || p.clearedAt() != null) return PestStage.RESOLVED;
        PestDamage d = rules.pestDamage();
        if (now.isBefore(p.spawnedAt().plus(hours(d.warnHours())))) return PestStage.WARNING;
        if (now.isBefore(p.spawnedAt().plus(hours(d.wiltHours())))) return PestStage.LEAF;
        return PestStage.WILT;
    }

    /** When the next stage begins for an unresolved pest (null at the last stage or once resolved). */
    public Instant nextStageAt(PestFacts p, Instant now) {
        PestDamage d = rules.pestDamage();
        return switch (stage(p, now)) {
            case WARNING -> p.spawnedAt().plus(hours(d.warnHours()));
            case LEAF -> p.spawnedAt().plus(hours(d.wiltHours()));
            default -> null;
        };
    }

    /** When the pest stops slowing growth whatever happens (the cap of the wilting penalty). */
    public Instant effectEndsAt(PestFacts p) {
        PestDamage d = rules.pestDamage();
        return p.spawnedAt().plus(hours(d.wiltHours() + d.wiltEffectHours()));
    }

    private static double relieved(double factor, double relief) {
        return 1 - (1 - factor) * (1 - Math.max(0, Math.min(1, relief)));
    }

    /**
     * Growth windows of a planting's pests. Nothing before {@code warnHours}; leaf damage until {@code wiltHours};
     * wilting for at most {@code wiltEffectHours}. Every window ends at the review (or when the pest is cleared).
     * {@code careAt}: instants the crop was watered or fertilized — from the first one after the pest appeared the
     * remaining penalty is softened by {@code tendedRelief}. Windows only start in the future of the pest's appearance
     * and can only end earlier, so growth stays monotonic: a ripe crop never becomes unripe.
     */
    public List<Slowdown> slowdowns(List<PestFacts> pestsOfPlanting, List<Instant> careAt) {
        PestDamage d = rules.pestDamage();
        List<Slowdown> out = new ArrayList<>();
        for (PestFacts p : pestsOfPlanting) {
            if (p.host() != Host.CROP) continue;
            Instant leafStart = p.spawnedAt().plus(hours(d.warnHours()));
            Instant wiltStart = p.spawnedAt().plus(hours(d.wiltHours()));
            Instant end = effectEndsAt(p);
            if (p.reviewedAt() != null && p.reviewedAt().isBefore(end)) end = p.reviewedAt();
            if (p.clearedAt() != null && p.clearedAt().isBefore(end)) end = p.clearedAt();
            Instant tended = null;
            for (Instant c : careAt) {
                if (!c.isBefore(p.spawnedAt()) && (tended == null || c.isBefore(tended))) tended = c;
            }
            window(out, leafStart, min(wiltStart, end), d.leafFactor(), tended, d.tendedRelief());
            window(out, wiltStart, end, d.wiltFactor(), tended, d.tendedRelief());
        }
        return out;
    }

    private static void window(List<Slowdown> out, Instant start, Instant end, double factor, Instant tended, double relief) {
        if (!end.isAfter(start)) return;
        if (tended == null || !tended.isBefore(end)) {
            out.add(new Slowdown(start, end, factor));
        } else if (!tended.isAfter(start)) {
            out.add(new Slowdown(start, end, relieved(factor, relief)));
        } else {
            out.add(new Slowdown(start, tended, factor));
            out.add(new Slowdown(tended, end, relieved(factor, relief)));
        }
    }

    /**
     * The pest part of a harvest's quality: the clean score unless a pest is still unresolved at the harvest instant, in
     * which case the worst unresolved stage decides (a warning costs nothing).
     */
    public int harvestPestScore(List<PestFacts> pestsOfPlanting, Instant harvestAt, int cleanScore) {
        PestDamage d = rules.pestDamage();
        int score = cleanScore;
        for (PestFacts p : pestsOfPlanting) {
            if (p.host() != Host.CROP) continue;
            boolean resolved = (p.reviewedAt() != null && !p.reviewedAt().isAfter(harvestAt))
                    || (p.clearedAt() != null && !p.clearedAt().isAfter(harvestAt));
            if (resolved) continue;
            PestStage s = stage(new PestFacts(p.id(), p.flashcardId(), p.host(), p.plantingId(), p.treeId(), p.spawnedAt(), null, null), harvestAt);
            if (s == PestStage.LEAF) score = Math.min(score, d.leafScore());
            if (s == PestStage.WILT) score = Math.min(score, d.wiltScore());
        }
        return score;
    }

    /** Largest growth work (seconds at base speed) one pest can ever cost a crop: the bound the design promises. */
    public double maxGrowthLossSeconds() {
        PestDamage d = rules.pestDamage();
        return (d.wiltHours() - d.warnHours()) * 3600 * (1 - d.leafFactor()) + d.wiltEffectHours() * 3600 * (1 - d.wiltFactor());
    }

    private static Instant min(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }

    // ------------------------------------------------------------------ contribution

    /**
     * Points a capped fact receives: its nominal value, cut to what the day, week and month of the fact still allow.
     * Uncapped (one-time milestone) sources always receive their nominal value.
     */
    public int granted(String source, int nominal, int dayUsed, int weekUsed, int monthUsed) {
        var c = rules.contribution();
        var s = c.sources().get(source);
        if (s == null || nominal <= 0) return 0;
        if (!s.capped()) return nominal;
        int room = Math.min(c.dayCap() - dayUsed, Math.min(c.weekCap() - weekUsed, c.monthCap() - monthUsed));
        return Math.max(0, Math.min(nominal, room));
    }

    public int nominal(String source, int tier) {
        var s = rules.contribution().sources().get(source);
        return s == null ? 0 : s.pointsFor(tier);
    }
}
