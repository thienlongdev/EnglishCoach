package com.englishcoach.garden.domain;

import java.time.Duration;
import java.util.List;
import java.util.Set;

/**
 * Phase 3G rules of the social islands ({@code garden_config.social}, V88): how much of a ripe crop a visitor may take,
 * the limits that keep it friendly, and the bounds of discovery, visits and the activity record. Numbers only — the
 * decisions are {@link SocialEngine}.
 */
public record SocialRules(int portionsPerUnit, Theft theft, Discovery discovery, int visitHistoryLimit, int activityPageSize,
                          int reactionLimit, List<String> reactions, int reactionCooldownHours) {

    /**
     * {@code fractionBp}: share of a crop's remaining portions one take carries (basis points, rounded down).
     * {@code thiefCap} / {@code pairCap} / {@code victimCap}: successful takes in a rolling {@code windowHours} per taker,
     * per taker and island, per island. {@code shieldHours}: the island is protected after a take. {@code introHours}: a
     * garden new to the social islands is protected and cannot take. {@code reopenHours}: an island that was just
     * re-opened cannot take. {@code ripeGraceMinutes}: the owner's head start on a crop that just ripened.
     */
    public record Theft(int fractionBp, int windowHours, int thiefCap, int pairCap, int victimCap, int shieldHours,
                        int introHours, int reopenHours, int ripeGraceMinutes, Set<String> excludedCrops) {

        public Duration window() {
            return Duration.ofHours(windowHours);
        }
    }

    public record Discovery(int pageSize, int searchLimit, int minQuery) {}

    public SocialRules {
        if (portionsPerUnit < 2) throw new IllegalArgumentException("social.portionsPerUnit must be at least 2");
        if (theft.fractionBp() < 1 || theft.fractionBp() > 1000) {
            throw new IllegalArgumentException("social.theft.fractionBp must be within 1..1000 (never above 10 %)");
        }
    }
}
