package com.englishcoach.garden.domain;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Phase 3A farm-economy rules (market stall, delivery board, bed expansion), loaded from the Flyway-seeded
 * configuration ({@code garden_config} keys {@code market}, {@code orders}, {@code expansion} and the fixed-shop columns
 * of {@code garden_item_def}, V80). Pure value object kept apart from {@link GardenRules} so the Phase 1–2 rule set and
 * its equivalence checks stay byte-for-byte unchanged.
 */
public record FarmEconomyRules(Market market, Orders orders, Expansion expansion) {

    /** A care item always on sale at the market: fixed coin price, capped per Vietnam day, unlocked by level. */
    public record Staple(String item, String nameVi, int price, int dailyCap, int unlockLevel) {}

    /**
     * Featured seed packs: {@code featuredSlots} packs per day drawn from purchasable COMMON / RARE crops of today's
     * theme (or ALL); a pack holds {@code packSize} seeds at {@code (1 − packDiscount)} of the fixed seed price and can be
     * bought {@code packDailyCap} times per day. {@code maxPerPurchase}: the largest quantity one request may buy.
     */
    public record Market(List<Staple> staples, int featuredSlots, int packSize, double packDiscount, int packDailyCap,
                         int maxPerPurchase) {}

    /**
     * One order kind. Lines: {@code minLines}, or {@code maxLines} from level {@code multiLineLevel}; quantity per line in
     * [{@code minQty}, {@code maxQty}] bounded by what the beds can grow before expiry. {@code bonus}: items granted on
     * delivery; {@code seedBonus}: seeds of an in-season unlocked RARE crop (0 = none); from level {@code goodTierLevel}
     * the first line asks GOOD or better (0 = never).
     */
    public record OrderKind(int minLevel, int minLines, int maxLines, int multiLineLevel, int minQty, int maxQty,
                            Map<String, Integer> bonus, int seedBonus, int goodTierLevel) {}

    /**
     * {@code coinMultiplier}: order coins = sell price × quantity × multiplier (no blessing, independent of the tiers
     * delivered). {@code growShare}: a crop qualifies only if it grows in at most this share of the remaining window.
     */
    public record Orders(int dailySlots, int weeklySlots, double coinMultiplier, double growShare, OrderKind daily,
                         OrderKind weekly, int historyLimit) {

        public int slots() {
            return dailySlots + weeklySlots;
        }

        /** Slots 1..dailySlots are daily; the following {@code weeklySlots} are weekly. */
        public boolean weeklySlot(int slot) {
            return slot > dailySlots && slot <= slots();
        }
    }

    /** A purchasable bed: owner-approved cell, required level, coins and produce composted into the new soil. */
    public record ExpansionPlot(int slot, int gx, int gy, String field, int level, long coins, Map<String, Integer> compost) {}

    public record Expansion(List<ExpansionPlot> plots) {

        public Optional<ExpansionPlot> plot(int slot) {
            return plots.stream().filter(p -> p.slot() == slot).findFirst();
        }

        /** The next bed that may be bought (sequential), given the slots already owned; empty when all are owned. */
        public Optional<ExpansionPlot> next(java.util.Set<Integer> ownedSlots) {
            return plots.stream().filter(p -> !ownedSlots.contains(p.slot())).findFirst();
        }
    }

    public Staple staple(String item) {
        return market.staples().stream().filter(s -> s.item().equals(item)).findFirst().orElse(null);
    }
}
