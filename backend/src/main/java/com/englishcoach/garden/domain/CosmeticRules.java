package com.englishcoach.garden.domain;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Phase 3E rules (cosmetics), loaded from the Flyway-seeded catalogue ({@code garden_collection_def},
 * {@code garden_cosmetic_def}, {@code garden_skin_def.collection_code}) and {@code garden_config.cosmetics} (V86). Pure
 * value object with the checks every cosmetic command runs: who may acquire an item and where a decoration may stand.
 *
 * <p>A cosmetic is art only. Nothing in this class — and nothing that reads it — touches growth, quality, prices of
 * produce, XP, weather, pests, land, buildings or any learning record.</p>
 */
public record CosmeticRules(Map<String, CollectionDef> collections, Map<String, Item> items, Map<String, String> skinCollections,
                            int maxPlaced, double snap, List<Region> regions) {

    /** Appearance slots: one equipped item each (the category of the item is its slot). DECOR is placed, not equipped. */
    public static final List<String> SLOTS = List.of("HOUSE", "TREE", "SHRUB", "FLOWER", "MONUMENT", "FENCE", "PATH", "BED");
    public static final String DECOR = "DECOR";

    public record CollectionDef(String code, String nameVi, String descriptionVi, int sortOrder) {}

    /**
     * {@code unlockKind}: COIN (bought for {@code coinPrice}) or an earned path — LEARNING (verified learning days),
     * HARVESTS (lifetime harvests), GRADUATIONS (graduated memory trees) — with {@code requirement}; an earned item has
     * no price and can never be bought. {@code maxOwned}: units one player may hold (1 for every appearance);
     * {@code footprint}: radius in tiles a placed decoration keeps free around its anchor.
     */
    public record Item(String code, String category, String family, String collection, String nameVi, String descriptionVi,
                       String artKey, String unlockKind, long coinPrice, int requirement, int maxOwned, double footprint,
                       int sortOrder) {

        public boolean placeable() {
            return DECOR.equals(category);
        }

        public boolean coin() {
            return "COIN".equals(unlockKind);
        }
    }

    /** A rectangle of free ground (grid cells); a decoration's anchor must lie inside it. */
    public record Region(String code, String nameVi, double x0, double y0, double x1, double y1) {

        public boolean contains(double gx, double gy) {
            return gx >= x0 - 1e-9 && gx <= x1 + 1e-9 && gy >= y0 - 1e-9 && gy <= y1 + 1e-9;
        }
    }

    /** The stored facts an earned item is checked against (never anything the client reports). */
    public record Facts(int learningDays, int harvests, int graduations) {}

    /** {@code progress}: the player's value of the item's requirement (0 for a coin item). */
    public record Check(boolean requirementOk, int progress, boolean coinsOk, long price) {

        public boolean ok() {
            return requirementOk && coinsOk;
        }
    }

    /** A decoration standing on the island. */
    public record Spot(long id, double gx, double gy, double footprint) {}

    public Item item(String code) {
        return code == null ? null : items.get(code);
    }

    public int progress(Item item, Facts facts) {
        return switch (item.unlockKind()) {
            case "LEARNING" -> facts.learningDays();
            case "HARVESTS" -> facts.harvests();
            case "GRADUATIONS" -> facts.graduations();
            default -> 0;
        };
    }

    public Check check(Item item, Facts facts, long coins) {
        long price = item.coin() ? item.coinPrice() : 0;
        int progress = progress(item, facts);
        return new Check(item.coin() || progress >= item.requirement(), progress, coins >= price, price);
    }

    public Optional<Region> regionAt(double gx, double gy) {
        return regions.stream().filter(r -> r.contains(gx, gy)).findFirst();
    }

    /** A coordinate the placement grid allows (a whole multiple of {@code snap}). */
    public boolean snapped(double v) {
        double k = v / snap;
        return Math.abs(k - Math.rint(k)) < 1e-6;
    }

    /**
     * Why a decoration may not stand at a point, or empty when it may: the point must be on the placement grid, inside
     * a decoration region, and its footprint must not touch another decoration ({@code others} = every other one that
     * stands). The count limit is checked by the caller (a move never adds one).
     */
    public Optional<String> placementError(Item item, double gx, double gy, List<Spot> others) {
        if (!Double.isFinite(gx) || !Double.isFinite(gy) || !snapped(gx) || !snapped(gy)) return Optional.of("DECOR_OFF_GRID");
        if (regionAt(gx, gy).isEmpty()) return Optional.of("DECOR_OUT_OF_BOUNDS");
        for (Spot o : others) {
            double need = item.footprint() + o.footprint();
            if (Math.hypot(o.gx() - gx, o.gy() - gy) < need - 1e-9) return Optional.of("DECOR_OVERLAP");
        }
        return Optional.empty();
    }
}
