package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.FarmingRules.Effect;
import com.englishcoach.garden.domain.FarmingRules.Item;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GrowthCalculator.Slowdown;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Phase 3D pure rules (no Spring, no database, explicit instants): what a farming supply does to one crop, how a pest
 * spray suspends a Forgotten Pest's damage without ever resolving it, how the soil decides the care part of a harvest
 * and how many coins a closed harvest pays. Kept beside {@link GardenEngine} / {@link EstateEngine} so the earlier
 * engines and their tests are untouched.
 */
public final class FarmingEngine {

    /** A supply applied to a planting (a stored fact): which item, when, and when its effect ends ({@code null} = never / instant). */
    public record Treatment(String itemCode, Instant appliedAt, Instant expiresAt) {

        public boolean activeAt(Instant t) {
            return !t.isBefore(appliedAt) && (expiresAt == null || t.isBefore(expiresAt));
        }
    }

    /**
     * The care part of a harvest: the points and the soil facts they come from. {@code tierCap}: the best quality tier a
     * severely stressed crop can still reach ({@code null} = no cap).
     */
    public record Care(int points, double stressShare, double factor, boolean toned, String tierCap) {}

    private final GardenRules rules;
    private final FarmingRules farming;
    private final SoilModel soil;

    public FarmingEngine(GardenRules rules, FarmingRules farming) {
        this.rules = rules;
        this.farming = farming;
        this.soil = new SoilModel(rules, farming);
    }

    public FarmingRules rules() {
        return farming;
    }

    public SoilModel soil() {
        return soil;
    }

    // ------------------------------------------------------------------ supplies

    /** When an item applied at {@code now} stops working: {@code null} for an instant effect or one that lasts until harvest. */
    public Instant expiresAt(Item item, Instant now) {
        return item.hours() <= 0 ? null : now.plus(Duration.ofSeconds(Math.round(item.hours() * 3600)));
    }

    /** True while a treatment of this effect is still working on the planting. */
    public boolean active(List<Treatment> treatments, Effect effect, Instant at) {
        return treatments.stream().anyMatch(t -> effectOf(t) == effect && t.activeAt(at));
    }

    /** True when the effect was ever applied to the planting (once-per-planting effects). */
    public boolean everApplied(List<Treatment> treatments, Effect effect, Instant at) {
        return treatments.stream().anyMatch(t -> effectOf(t) == effect && !t.appliedAt().isAfter(at));
    }

    private Effect effectOf(Treatment t) {
        Item item = farming.item(t.itemCode());
        return item == null ? null : item.effect();
    }

    /**
     * The soil events of a planting: every watering ({@code waterTimes}: the Flashcard-review resource adds
     * {@code waterGain} moisture besides its growth boost) and every supply that touches the soil or the stress.
     */
    public List<SoilModel.Event> soilEvents(List<Instant> waterTimes, List<Treatment> treatments) {
        List<SoilModel.Event> out = new ArrayList<>();
        for (Instant w : waterTimes) out.add(new SoilModel.Event(w, Effect.MOISTURE, null, farming.soil().waterGain()));
        for (Treatment t : treatments) {
            Item item = farming.item(t.itemCode());
            if (item == null) continue;
            switch (item.effect()) {
                case MOISTURE, MULCH, RAIN_COVER, SHADE, DRAINAGE, TONIC ->
                        out.add(new SoilModel.Event(t.appliedAt(), item.effect(), t.expiresAt(), item.value()));
                default -> { }
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ pests

    /**
     * A Forgotten Pest's growth windows with every sprayed stretch cut out. The spray only suspends the damage: the pest,
     * its overdue card and its stage clock are untouched, so the damage resumes when the spray ends unless the word was
     * genuinely reviewed in the meantime.
     */
    public List<Slowdown> suppress(List<Slowdown> pestSlowdowns, List<Treatment> treatments) {
        List<Slowdown> out = new ArrayList<>(pestSlowdowns);
        for (Treatment t : treatments) {
            if (effectOf(t) != Effect.PEST_SPRAY || t.expiresAt() == null) continue;
            List<Slowdown> next = new ArrayList<>();
            for (Slowdown s : out) {
                Instant end = s.end();
                if (end != null && !end.isAfter(t.appliedAt()) || !s.start().isBefore(t.expiresAt())) {
                    next.add(s);
                    continue;
                }
                if (s.start().isBefore(t.appliedAt())) next.add(new Slowdown(s.start(), t.appliedAt(), s.factor()));
                if (end == null || end.isAfter(t.expiresAt())) next.add(new Slowdown(t.expiresAt(), end, s.factor()));
            }
            out = next;
        }
        return out;
    }

    /**
     * The pest part of a harvest under an active spray: at least the spray's score, never above the clean score — a
     * sprayed crop is better than a wilting one and still worse than a crop whose word was really reviewed.
     */
    public int sprayedPestScore(int pestScore, List<Treatment> treatments, Instant harvestAt, int cleanScore) {
        int best = pestScore;
        for (Treatment t : treatments) {
            Item item = farming.item(t.itemCode());
            if (item != null && item.effect() == Effect.PEST_SPRAY && t.activeAt(harvestAt)) {
                best = Math.max(best, (int) Math.round(item.value()));
            }
        }
        return Math.max(0, Math.min(cleanScore, best));
    }

    // ------------------------------------------------------------------ harvest

    /**
     * The care points of a harvest (growth model 2): the full care score needs a crop that was tended (water,
     * fertilizer or any supply) AND soil that stayed healthy; stressed soil scales it down by {@code careShare}.
     * A tonic halves the stressed share once. {@code condition}: the soil when the crop became ripe.
     */
    public Care care(boolean tended, SoilModel.Condition condition, boolean toned) {
        Item tonic = farming.items().values().stream().filter(i -> i.effect() == Effect.TONIC).findFirst().orElse(null);
        double share = condition.stressShare() * (toned && tonic != null ? Math.max(0, Math.min(1, tonic.value())) : 1);
        double factor = soil.careFactor(share);
        int points = tended ? (int) Math.round(rules.quality().cared() * factor) : 0;
        return new Care(points, share, factor, toned, share > farming.soil().severeShare() + 1e-9 ? farming.soil().severeTierCap() : null);
    }

    /** A harvest's quality with the soil's tier cap applied (the score is kept; only the tier can be lowered). */
    public QualityCalculator.Result capped(QualityCalculator.Result result, Care care) {
        if (care.tierCap() == null) return result;
        var cap = rules.quality().tier(care.tierCap());
        if (result.tier().minScore() <= cap.minScore()) return result;
        return new QualityCalculator.Result(result.recall(), result.pest(), result.season(), result.care(), result.fresh(),
                result.total(), cap);
    }

    /** Coins a closed harvest of this crop pays before the daily cap (0 for a crop that sells for nothing). */
    public int harvestBonus(CropDef crop) {
        if (crop.sellPrice() <= 0 || crop.qaOnly()) return 0;
        var b = farming.harvestBonus();
        return Math.max(b.min(), (int) Math.round(crop.sellPrice() * rules.coinScale() * b.share()));
    }

    /** The part of a bonus the day's cap still allows. */
    public int grantedBonus(int bonus, int paidToday) {
        return Math.max(0, Math.min(bonus, farming.harvestBonus().dailyCap() - paidToday));
    }
}
