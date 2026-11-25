package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.GardenRules.CropDef;

import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * Island level from total XP (02 §10): {@code xpToNext(L) = round(a · L^p + b)}. Only {@code total_xp} is stored; the
 * level is always derived, so it can never drift from the XP ledger.
 */
public final class LevelCurve {

    public record Progress(int level, long xpIntoLevel, long xpToNext) {}

    private final GardenRules rules;

    public LevelCurve(GardenRules rules) {
        this.rules = rules;
    }

    public long xpToNext(int level) {
        var l = rules.level();
        return Math.round(l.a() * Math.pow(level, l.p()) + l.b());
    }

    public Progress progress(long totalXp) {
        int level = 1;
        long remaining = Math.max(0, totalXp);
        while (remaining >= xpToNext(level)) {
            remaining -= xpToNext(level);
            level++;
        }
        return new Progress(level, remaining, xpToNext(level));
    }

    public int level(long totalXp) {
        return progress(totalXp).level();
    }

    public long totalXpForLevel(int level) {
        long sum = 0;
        for (int l = 1; l < level; l++) sum += xpToNext(l);
        return sum;
    }

    /** Crops (non-QA) that unlock exactly at {@code level}: the level-up card lists them. */
    public List<CropDef> unlocksAt(int level) {
        return rules.crops().values().stream().filter(c -> !c.qaOnly() && c.unlockLevel() == level)
                .sorted(Comparator.comparingInt(CropDef::sortOrder)).toList();
    }

    /** The next level that unlocks a crop (HUD: "Cấp 3: mở Dâu tây"). */
    public Optional<CropDef> nextUnlock(int currentLevel) {
        return rules.crops().values().stream().filter(c -> !c.qaOnly() && c.unlockLevel() > currentLevel)
                .min(Comparator.comparingInt(CropDef::unlockLevel).thenComparingInt(CropDef::sortOrder));
    }
}
