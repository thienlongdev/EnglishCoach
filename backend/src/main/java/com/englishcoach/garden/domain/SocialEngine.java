package com.englishcoach.garden.domain;

import java.text.Normalizer;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;

/**
 * Phase 3G decisions of the social islands, pure (no Spring, no database, explicit instants).
 *
 * <p>A ripe crop holds one produce unit = {@code portionsPerUnit} harvest portions. A visitor may take a small share of
 * the portions that are still on the plant; the owner's harvest later pays exactly the rest, so
 * {@code taken + owner = portionsPerUnit} for every planting. Nothing else ever leaves an island.
 */
public final class SocialEngine {

    /** Why a take is refused. The order of {@link #verdict} is the order a player is told about them. */
    public enum Reason {
        OK,
        /** The taker's own standing. */
        THIEF_PRIVATE, THIEF_NEW, THIEF_REOPENED, THIEF_LIMIT, PAIR_LIMIT,
        /** The island's protection. */
        ISLAND_NEW, ISLAND_SHIELD, VICTIM_LIMIT,
        /** Phase 3H: a guardian dog turned a visitor away a moment ago and watches the island. */
        ISLAND_GUARDED,
        /** The crop itself. */
        CROP_EXCLUDED, NOT_READY, CROP_FRESH, CROP_TAKEN, NOT_ENOUGH_YIELD
    }

    /**
     * The taker as the server knows them now. {@code joinedAt}: when the garden joined the social islands;
     * {@code visibilityChangedAt}: the last time the island was opened or closed; {@code takesInWindow} /
     * {@code oldestTakeInWindow}: successful takes of the rolling window over all islands.
     */
    public record Taker(boolean open, Instant joinedAt, Instant visibilityChangedAt, int takesInWindow, Instant oldestTakeInWindow) {}

    /**
     * The visited island now. {@code takenFromInWindow} / {@code oldestTakenFromInWindow} / {@code lastTakenFromAt}:
     * successful takes it suffered in the window; {@code pairTakesInWindow} / {@code oldestPairTake}: by this taker.
     */
    public record Island(Instant joinedAt, int takenFromInWindow, Instant oldestTakenFromInWindow, Instant lastTakenFromAt,
                         int pairTakesInWindow, Instant oldestPairTake) {}

    /** One crop of the island. {@code readyAt} null = still growing; {@code takenPortions}: already taken from it. */
    public record Crop(String cropCode, boolean tutorial, boolean ready, Instant readyAt, int takenPortions) {}

    /**
     * Phase 3H: what the island's guardian pets add right now. {@code extraGraceMinutes}: a fed goose lengthens the
     * owner's head start on a freshly ripe crop; {@code shieldUntil}: the dog guards the island until then (null = not).
     */
    public record Guard(int extraGraceMinutes, Instant shieldUntil) {

        public static final Guard NONE = new Guard(0, null);
    }

    /** {@code portions}: what a take would carry now (0 unless OK); {@code availableAt}: when the reason ends, if it does. */
    public record Verdict(Reason reason, int portions, Instant availableAt) {

        public boolean ok() {
            return reason == Reason.OK;
        }
    }

    private final SocialRules rules;

    public SocialEngine(SocialRules rules) {
        this.rules = rules;
    }

    public SocialRules rules() {
        return rules;
    }

    /** Portions still on the plant for its owner. */
    public int remaining(int takenPortions) {
        return Math.max(0, rules.portionsPerUnit() - takenPortions);
    }

    /** What one take carries: a rounded-down share of what is left (0 = nothing small enough can be taken). */
    public int takeSize(int takenPortions) {
        return (int) ((long) remaining(takenPortions) * rules.theft().fractionBp() / 10_000L);
    }

    /** What the owner's harvest of a crop pays in portions (the whole unit when nothing was taken). */
    public int ownerPortions(int takenPortions) {
        return remaining(takenPortions);
    }

    /** End of a garden's introductory protection (during it the island is protected and cannot take). */
    public Instant introEnds(Instant joinedAt) {
        return joinedAt.plus(Duration.ofHours(rules.theft().introHours()));
    }

    /** Why this island is protected as a whole right now (OK = it is not), ignoring the taker. */
    public Verdict protection(Island island, Instant now) {
        return protection(island, now, Guard.NONE);
    }

    /** {@link #protection(Island, Instant)} plus the guardian dog's watch (told last: the free protections come first). */
    public Verdict protection(Island island, Instant now, Guard guard) {
        var t = rules.theft();
        Instant intro = introEnds(island.joinedAt());
        if (now.isBefore(intro)) return new Verdict(Reason.ISLAND_NEW, 0, intro);
        if (island.lastTakenFromAt() != null) {
            Instant shield = island.lastTakenFromAt().plus(Duration.ofHours(t.shieldHours()));
            if (now.isBefore(shield)) return new Verdict(Reason.ISLAND_SHIELD, 0, shield);
        }
        if (island.takenFromInWindow() >= t.victimCap()) {
            return new Verdict(Reason.VICTIM_LIMIT, 0, windowEnd(island.oldestTakenFromInWindow()));
        }
        if (guard.shieldUntil() != null && now.isBefore(guard.shieldUntil())) {
            return new Verdict(Reason.ISLAND_GUARDED, 0, guard.shieldUntil());
        }
        return new Verdict(Reason.OK, 0, null);
    }

    /** Whether this taker may take at all right now (OK = yes), ignoring the island and the crop. */
    public Verdict standing(Taker taker, Instant now) {
        var t = rules.theft();
        if (!taker.open()) return new Verdict(Reason.THIEF_PRIVATE, 0, null);
        Instant intro = introEnds(taker.joinedAt());
        if (now.isBefore(intro)) return new Verdict(Reason.THIEF_NEW, 0, intro);
        // an island opened again after being closed waits before it may take (closing to dodge and reopening to take)
        if (taker.visibilityChangedAt().isAfter(taker.joinedAt())) {
            Instant reopen = taker.visibilityChangedAt().plus(Duration.ofHours(t.reopenHours()));
            if (now.isBefore(reopen)) return new Verdict(Reason.THIEF_REOPENED, 0, reopen);
        }
        if (taker.takesInWindow() >= t.thiefCap()) return new Verdict(Reason.THIEF_LIMIT, 0, windowEnd(taker.oldestTakeInWindow()));
        return new Verdict(Reason.OK, 0, null);
    }

    /** The full decision for one crop: the taker's standing, then the island's protection, then the crop. */
    public Verdict verdict(Taker taker, Island island, Crop crop, Instant now) {
        return verdict(taker, island, crop, now, Guard.NONE);
    }

    /** The decision with the island's guardian pets: the dog's watch protects the island, the goose lengthens the head start. */
    public Verdict verdict(Taker taker, Island island, Crop crop, Instant now, Guard guard) {
        var t = rules.theft();
        Verdict standing = standing(taker, now);
        if (!standing.ok()) return standing;
        if (island.pairTakesInWindow() >= t.pairCap()) return new Verdict(Reason.PAIR_LIMIT, 0, windowEnd(island.oldestPairTake()));
        Verdict protection = protection(island, now, guard);
        if (!protection.ok()) return protection;
        if (crop.tutorial() || t.excludedCrops().contains(crop.cropCode())) return new Verdict(Reason.CROP_EXCLUDED, 0, null);
        if (!crop.ready() || crop.readyAt() == null) return new Verdict(Reason.NOT_READY, 0, crop.readyAt());
        Instant grace = crop.readyAt().plus(Duration.ofMinutes(t.ripeGraceMinutes() + Math.max(0, guard.extraGraceMinutes())));
        if (now.isBefore(grace)) return new Verdict(Reason.CROP_FRESH, 0, grace);
        if (crop.takenPortions() > 0) return new Verdict(Reason.CROP_TAKEN, 0, null);
        int size = takeSize(crop.takenPortions());
        if (size < 1) return new Verdict(Reason.NOT_ENOUGH_YIELD, 0, null);
        return new Verdict(Reason.OK, size, null);
    }

    private Instant windowEnd(Instant oldest) {
        return oldest == null ? null : oldest.plus(rules.theft().window());
    }

    // ------------------------------------------------------------------ public names

    /** The folded form a public name is searched by: lower case, Vietnamese marks removed, single spaces. */
    public static String nameKey(String name) {
        if (name == null) return "";
        String s = Normalizer.normalize(name, Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
        s = s.replace('đ', 'd').replace('Đ', 'D').toLowerCase(Locale.ROOT);
        s = s.replaceAll("[^\\p{L}\\p{Nd}]+", " ").trim();
        return s.length() > 80 ? s.substring(0, 80) : s;
    }

    /** A public name as stored: trimmed, single spaces, at most 80 characters; null when nothing printable is left. */
    public static String cleanName(String name) {
        if (name == null) return null;
        String s = name.replaceAll("\\S+@\\S+", " ").replaceAll("[\\p{Cntrl}]+", " ").replaceAll("\\s+", " ").trim();
        s = s.replaceAll("^[\\s\\-–|:,;()<>\\[\\]]+|[\\s\\-–|:,;()<>\\[\\]]+$", "").trim();
        if (s.isEmpty() || s.contains("@")) return null;
        return s.length() > 80 ? s.substring(0, 80).trim() : s;
    }
}
