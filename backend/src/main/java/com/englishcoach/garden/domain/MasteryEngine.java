package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.GardenRules.Rarity;
import com.englishcoach.garden.domain.LivingRules.MasteryTier;
import com.englishcoach.garden.domain.MonumentEngine.Requirement;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Crop mastery (Phase 3B, blueprint §7.2): a crop's tier from its recorded harvest history only — harvests closed by the
 * server, the best quality tier reached, the seasons it was harvested in and the codex forms discovered. Mastery is a
 * record of farming; it never changes growth, quality, price, XP or chance.
 */
public final class MasteryEngine {

    /** {@code bestTier}: rank of the best quality tier (0 = the lowest); {@code seasons}: distinct seasons harvested in. */
    public record Facts(int harvests, int bestTier, int seasons, int forms) {}

    public record Next(int tier, List<Requirement> requirements) {}

    private final LivingRules.Mastery rules;

    public MasteryEngine(LivingRules rules) {
        this.rules = rules.mastery();
    }

    /** Harvests a tier needs for a crop of this rarity (slow crops need fewer; never below one). */
    public int harvestsNeeded(Rarity rarity, MasteryTier tier) {
        double scale = rules.rarityScale().getOrDefault(rarity, 1.0);
        return Math.max(1, (int) Math.ceil(tier.harvests() * scale - 1e-9));
    }

    private boolean reached(Rarity rarity, MasteryTier t, Facts f) {
        return f.harvests() >= harvestsNeeded(rarity, t) && f.bestTier() >= t.bestTier() && f.seasons() >= t.seasons()
                && f.forms() >= t.forms();
    }

    /** The highest tier whose requirements, and those of every tier before it, are met. */
    public int tier(Rarity rarity, Facts f) {
        int tier = 0;
        for (MasteryTier t : rules.tiers()) {
            if (!reached(rarity, t, f)) break;
            tier = t.tier();
        }
        return tier;
    }

    /** Requirements of the tier after {@code tier}; empty at the top tier. */
    public Optional<Next> next(Rarity rarity, int tier, Facts f) {
        return rules.tiers().stream().filter(t -> t.tier() > tier).findFirst().map(t -> {
            List<Requirement> reqs = new ArrayList<>();
            reqs.add(new Requirement("HARVESTS", f.harvests(), harvestsNeeded(rarity, t)));
            if (t.bestTier() > 0) reqs.add(new Requirement("QUALITY", f.bestTier(), t.bestTier()));
            if (t.seasons() > 0) reqs.add(new Requirement("SEASONS", f.seasons(), t.seasons()));
            if (t.forms() > 0) reqs.add(new Requirement("FORMS", f.forms(), t.forms()));
            return new Next(t.tier(), List.copyOf(reqs));
        });
    }
}
