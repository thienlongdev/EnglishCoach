package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.SocialRepository;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.UUID;

/**
 * Phase 3G harvest portions. One produce unit is {@code portionsPerUnit} portions (V88). Portions exist only for a crop
 * a visitor took a little from: the taker receives the taken portions and the owner's harvest receives the rest, both
 * as inventory fragments {@code SHARE:<crop>} of a quality tier, through the ledger like every other balance. Whenever
 * a player holds a whole unit of fragments of one crop and tier they are exchanged for that produce unit. So for every
 * planting {@code taker + owner = one unit}: nothing is created and nothing is lost.
 *
 * <p>On a database without the social islands ({@code ctx.social() == null}) nothing here is used and a harvest pays
 * its whole unit exactly as before.
 */
@Component
public class HarvestShares {

    private final GardenContext ctx;
    private final LedgerService ledger;
    private final SocialRepository repo;

    public HarvestShares(GardenContext ctx, LedgerService ledger, SocialRepository repo) {
        this.ctx = ctx;
        this.ledger = ledger;
        this.repo = repo;
    }

    public static String item(String cropCode) {
        return "SHARE:" + cropCode;
    }

    /** Portions a visitor took from this planting (0 = untouched, or no social islands on this database). */
    public int taken(long plantingId) {
        return ctx.social() == null ? 0 : repo.takenPortions(plantingId);
    }

    public int unit() {
        return ctx.social() == null ? 0 : ctx.social().rules().portionsPerUnit();
    }

    /**
     * The owner's harvest of a crop a visitor took from: credits exactly what is left of the unit as fragments of the
     * graded tier and exchanges whole units. Called once per planting, by the transaction that closed it.
     *
     * @return the portions credited
     */
    public int creditRemainder(long ownerId, String cropCode, String tier, int taken, long plantingId, UUID opKey, Instant now) {
        int portions = ctx.social().ownerPortions(taken);
        ledger.addItem(ownerId, item(cropCode), tier, portions, "HARVEST", "PLANTING", String.valueOf(plantingId), opKey, now);
        merge(ownerId, cropCode, tier, opKey, now);
        return portions;
    }

    /** Exchanges every whole unit of fragments of one crop and tier for produce. @return the units completed */
    public int merge(long userId, String cropCode, String tier, UUID opKey, Instant now) {
        int unit = ctx.social().rules().portionsPerUnit();
        int units = ctx.repo.itemQty(userId, item(cropCode), tier) / unit;
        if (units <= 0) return 0;
        if (!ledger.takeItem(userId, item(cropCode), tier, units * unit, "SHARE_MERGE", "SHARE", cropCode, opKey, now)) {
            throw new IllegalStateException("garden fragments changed inside their own transaction");
        }
        ledger.addItem(userId, "CROP:" + cropCode, tier, units, "SHARE_MERGE", "SHARE", cropCode, opKey, now);
        return units;
    }
}
