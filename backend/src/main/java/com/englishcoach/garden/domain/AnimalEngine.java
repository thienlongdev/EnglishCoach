package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.AnimalRules.Guardian;
import com.englishcoach.garden.domain.AnimalRules.Livestock;

import java.time.Duration;
import java.time.Instant;

/**
 * Phase 3H decisions of livestock and guardian pets, pure (no Spring, no database, explicit instants).
 *
 * <p><b>Time.</b> An animal is evaluated lazily: its row stores the instant up to which growth and production are
 * counted ({@code progressAt}) and {@link #advance} moves it to {@code now}. Food and water only ever change inside a
 * command that advances first, so between two commands the cared-for time is always the prefix
 * {@code [progressAt, min(fedUntil, wateredUntil))} of the elapsed time.
 *
 * <p><b>Care, never punishment.</b> A cared-for young animal grows at full speed and keeps growing at a reduced speed
 * without care; an adult produces only while cared for and only until its small store is full. Nothing ever dies, is
 * lost or goes backwards.
 */
public final class AnimalEngine {

    public enum Stage { BABY, YOUNG, ADULT }

    /** The counters of one animal. */
    public record Progress(Instant progressAt, long growthSeconds, long productSeconds) {}

    private final AnimalRules rules;

    public AnimalEngine(AnimalRules rules) {
        this.rules = rules;
    }

    public AnimalRules rules() {
        return rules;
    }

    // ------------------------------------------------------------------ livestock

    /** End of the care (food AND water) an animal has now. */
    public static Instant careUntil(Instant fedUntil, Instant wateredUntil) {
        return fedUntil.isBefore(wateredUntil) ? fedUntil : wateredUntil;
    }

    /** Growth and production of one animal from its stored instant up to {@code now}. */
    public Progress advance(Livestock def, Progress p, Instant fedUntil, Instant wateredUntil, Instant now) {
        if (!now.isAfter(p.progressAt())) return p;
        long elapsed = Duration.between(p.progressAt(), now).getSeconds();
        Instant careEnd = careUntil(fedUntil, wateredUntil);
        long cared = careEnd.isAfter(p.progressAt())
                ? Math.min(elapsed, Duration.between(p.progressAt(), careEnd).getSeconds()) : 0;
        long idle = elapsed - cared;

        long growth = p.growthSeconds();
        long product = p.productSeconds();
        long need = Math.max(0, def.growSeconds() - growth);
        long grown = Math.min(cared, need);
        growth += grown;
        long adultCared = cared - grown;
        long consumed = elapsed;
        if (growth >= def.growSeconds()) {
            product = Math.min(def.storeSeconds(), product + adultCared);
        } else {
            // without care a young animal still grows, slowly: it can never be stuck
            int bp = rules.restGrowthBp();
            long gain = idle * bp / 10_000L;
            if (gain >= def.growSeconds() - growth) {
                growth = def.growSeconds();
            } else {
                growth += gain;
                // only the resting seconds that were turned into growth are consumed, so frequent evaluation loses nothing
                if (bp > 0) consumed = cared + Math.ceilDiv(gain * 10_000L, bp);
            }
        }
        // whole seconds only: the fraction of a second of `now` is not consumed
        return new Progress(p.progressAt().plusSeconds(consumed), growth, product);
    }

    public Stage stage(Livestock def, long growthSeconds) {
        if (growthSeconds >= def.growSeconds()) return Stage.ADULT;
        return growthSeconds * 2 >= def.growSeconds() ? Stage.YOUNG : Stage.BABY;
    }

    /** Whole products an animal holds for collection. */
    public int ready(Livestock def, long productSeconds) {
        return (int) Math.min(def.storeCap(), productSeconds / def.productSeconds());
    }

    /** The counter after collecting {@code units} (what was already produced toward the next one is kept). */
    public long afterCollect(Livestock def, long productSeconds, int units) {
        return Math.max(0, productSeconds - units * def.productSeconds());
    }

    /**
     * When the next product is ready, given the care the animal has now; null when it is not an adult, its store is
     * full, or its care ends first.
     */
    public Instant nextProductAt(Livestock def, Progress p, Instant fedUntil, Instant wateredUntil) {
        if (p.growthSeconds() < def.growSeconds() || p.productSeconds() >= def.storeSeconds()) return null;
        long toNext = def.productSeconds() - p.productSeconds() % def.productSeconds();
        Instant at = p.progressAt().plusSeconds(toNext);
        return at.isAfter(careUntil(fedUntil, wateredUntil)) ? null : at;
    }

    /** When a young animal becomes an adult under its current care (null for an adult). */
    public Instant adultAt(Livestock def, Progress p, Instant fedUntil, Instant wateredUntil) {
        long need = def.growSeconds() - p.growthSeconds();
        if (need <= 0) return null;
        Instant careEnd = careUntil(fedUntil, wateredUntil);
        long cared = careEnd.isAfter(p.progressAt()) ? Duration.between(p.progressAt(), careEnd).getSeconds() : 0;
        if (cared >= need) return p.progressAt().plusSeconds(need);
        if (rules.restGrowthBp() <= 0) return null;
        long rest = (need - cared) * 10_000L / rules.restGrowthBp();
        return p.progressAt().plusSeconds(cared + rest);
    }

    // ------------------------------------------------------------------ food and water

    /** How long one ration lasts; a little longer on a day the learning goal is met. */
    public Duration ration(int rationHours, boolean learnedToday) {
        long seconds = rationHours * 3600L;
        if (learnedToday) seconds += seconds * rules.feed().learningBonusBp() / 10_000L;
        return Duration.ofSeconds(seconds);
    }

    /**
     * The food end after one more ration, or null when the trough cannot take it (food would reach further ahead than
     * the horizon). A ration never shortens food and is never partly wasted.
     */
    public Instant fedAfterRation(Instant fedUntil, int rationHours, boolean learnedToday, Instant now) {
        Instant base = fedUntil.isAfter(now) ? fedUntil : now;
        Instant after = base.plus(ration(rationHours, learnedToday));
        return after.isAfter(now.plus(rules.feedHorizon())) ? null : after;
    }

    /** Whether a house's trough may be refilled now. */
    public boolean troughRefillable(Instant wateredUntil, Instant now) {
        return !wateredUntil.isAfter(now.plus(Duration.ofHours(rules.water().refillBelowHours())));
    }

    public Instant wateredAfterRefill(Instant now) {
        return now.plus(Duration.ofHours(rules.water().hours()));
    }

    // ------------------------------------------------------------------ guardians

    /** A guardian is on duty only while it has food. */
    public static boolean onDuty(Instant fedUntil, Instant now) {
        return fedUntil != null && fedUntil.isAfter(now);
    }

    /** Until when the island is guarded after the dog turned a visitor away (null = not guarding). */
    public Instant dogShieldUntil(Instant guardAt, Instant now) {
        Guardian dog = rules.guardians().get(AnimalRules.DOG);
        if (dog == null || guardAt == null) return null;
        Instant until = guardAt.plus(Duration.ofHours(dog.shieldHours()));
        return until.isAfter(now) ? until : null;
    }

    /** Whether a fed dog may turn the next visitor away now (its cooldown since the last time has passed). */
    public boolean dogReady(Instant fedUntil, Instant guardAt, Instant now) {
        Guardian dog = rules.guardians().get(AnimalRules.DOG);
        if (dog == null || !onDuty(fedUntil, now)) return false;
        return guardAt == null || !guardAt.plus(Duration.ofHours(dog.cooldownHours())).isAfter(now);
    }

    public Instant dogReadyAt(Instant guardAt) {
        Guardian dog = rules.guardians().get(AnimalRules.DOG);
        return dog == null || guardAt == null ? null : guardAt.plus(Duration.ofHours(dog.cooldownHours()));
    }

    /** Minutes a fed goose adds to the owner's head start on a freshly ripe crop. */
    public int gooseGraceMinutes(Instant fedUntil, Instant now) {
        Guardian goose = rules.guardians().get(AnimalRules.GOOSE);
        return goose != null && onDuty(fedUntil, now) ? goose.graceMinutes() : 0;
    }

    /**
     * Crop-pest places a fed cat keeps free: counted as already taken when new Forgotten Pests are planned, and never so
     * many that no pest could appear at all.
     */
    public int catPestRelief(Instant fedUntil, Instant now, int maxCropPests) {
        Guardian cat = rules.guardians().get(AnimalRules.CAT);
        if (cat == null || !onDuty(fedUntil, now)) return 0;
        return Math.max(0, Math.min(cat.pestCapReduction(), maxCropPests - 1));
    }

    // ------------------------------------------------------------------ portions

    /**
     * Sale value of harvest portions: the proportional share of one unit's price, rounded DOWN. Because the floor of a
     * part never exceeds the part, the portions of one unit can never sell for more than the unit, however they are
     * split between players and sales.
     */
    public static long portionValue(long unitPrice, int portions, int portionsPerUnit) {
        if (portions <= 0 || portionsPerUnit <= 0) return 0;
        return Math.floorDiv(unitPrice * portions, (long) portionsPerUnit);
    }
}
