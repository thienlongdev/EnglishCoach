package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.FarmEconomyRules.Staple;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GardenRules.Rarity;
import com.englishcoach.garden.domain.GardenRules.Season;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * Market stall rotation (Phase 3A). The day's offers are a pure function of the Vietnam calendar day and the rules:
 * every device of every player sees the same stall at the same moment, and nothing can be rerolled by refreshing.
 * Staples (care items) are on sale every day; {@code featuredSlots} seed packs rotate daily among the purchasable COMMON /
 * RARE crops of that day's theme week (or all-season crops), ordered by a deterministic hash of the day. Water is never
 * an offer (it stays the Flashcard-review resource); Epic seeds keep their essence price at planting and Legendary seeds
 * are never sold.
 */
public final class MarketEngine {

    public enum Kind { STAPLE, PACK }

    /**
     * One offer of the day. {@code unitQty}: items credited per purchase unit; {@code price}: coins per purchase unit;
     * {@code dailyCap}: purchase units per player per day.
     */
    public record Offer(String code, Kind kind, String item, String cropCode, int unitQty, long price, int dailyCap,
                        int unlockLevel, String nameVi) {}

    private final GardenRules rules;
    private final FarmEconomyRules economy;
    private final GardenCalendar calendar;

    public MarketEngine(GardenRules rules, FarmEconomyRules economy) {
        this.rules = rules;
        this.economy = economy;
        this.calendar = new GardenCalendar(rules);
    }

    /** The offers of a Vietnam calendar day (staples first, then the featured packs). */
    public List<Offer> offers(LocalDate day) {
        return offers(day, EstateEngine.Perks.NONE);
    }

    public Optional<Offer> offer(LocalDate day, String code, EstateEngine.Perks perks) {
        return offers(day, perks).stream().filter(o -> o.code().equals(code)).findFirst();
    }

    /**
     * Phase 3C: the stall as one player's market building shows it. A higher stall reveals MORE packs of the same
     * deterministic daily ranking and allows a few more purchases per day; it never changes a price, a pack size or the
     * ranking itself, so every extra coin spent buys exactly what the base stall would sell.
     */
    public List<Offer> offers(LocalDate day, EstateEngine.Perks perks) {
        var m = economy.market();
        List<Offer> out = new ArrayList<>();
        for (Staple s : m.staples()) {
            out.add(new Offer("ITEM:" + s.item(), Kind.STAPLE, s.item(), null, 1,
                    Math.round(s.price() * rules.coinScale()), s.dailyCap() + Math.max(0, perks.stapleCapExtra()), s.unlockLevel(), s.nameVi()));
        }
        Season theme = calendar.theme(calendar.startOfDay(day));
        String dayKey = day.toString();
        rules.crops().values().stream()
                .filter(c -> featuredEligible(c, theme))
                .sorted(Comparator.comparingDouble((CropDef c) -> DeterministicRandom.unit("market:" + dayKey + ":" + c.code()))
                        .thenComparing(CropDef::code))
                .limit(Math.max(0, m.featuredSlots() + Math.max(0, perks.featuredExtra())))
                .forEach(c -> out.add(new Offer("PACK:" + c.code(), Kind.PACK, "SEED:" + c.code(), c.code(), m.packSize(),
                        packPrice(c), m.packDailyCap() + Math.max(0, perks.packCapExtra()), c.unlockLevel(), c.nameVi())));
        return out;
    }

    public Optional<Offer> offer(LocalDate day, String code) {
        return offers(day).stream().filter(o -> o.code().equals(code)).findFirst();
    }

    /** Pack price: floor(size × fixed seed price × coin scale × (1 − discount)), never below one coin per pack. */
    public long packPrice(CropDef crop) {
        var m = economy.market();
        double price = m.packSize() * crop.seedPrice() * rules.coinScale() * (1 - m.packDiscount());
        return Math.max(1, (long) Math.floor(price + 1e-9));
    }

    static boolean featuredEligible(CropDef c, Season theme) {
        return !c.qaOnly() && c.purchasable() && c.seedEssence() == 0
                && (c.rarity() == Rarity.COMMON || c.rarity() == Rarity.RARE)
                && (c.season() == Season.ALL || c.season() == theme);
    }

    /**
     * Total coins of a purchase of {@code units} purchase units, or -1 when the quantity is outside [1, maxPerPurchase]
     * (no overflow: both factors are small and the product is computed in long).
     */
    public long total(Offer offer, int units) {
        if (units < 1 || units > economy.market().maxPerPurchase()) return -1;
        return Math.multiplyExact(offer.price(), (long) units);
    }
}
