package com.englishcoach.garden.application;

import com.englishcoach.garden.api.GardenDtos.SellLine;
import com.englishcoach.garden.api.GardenDtos.ShareSellLine;
import com.englishcoach.garden.api.GardenDtos.ShareSellRequest;
import com.englishcoach.garden.api.GardenDtos.ShareSellResult;
import com.englishcoach.garden.domain.AnimalEngine;
import com.englishcoach.garden.api.GardenDtos.SellLineResult;
import com.englishcoach.garden.api.GardenDtos.SellRequest;
import com.englishcoach.garden.api.GardenDtos.SellResult;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GardenRules.QualityTier;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Selling produce (02 §5): the server prices every unit (sell price × tier × blessing at the moment of sale × coin
 * scale, rounded down); the client never supplies a price. Learning is ingested first so a goal reached a minute ago
 * already blesses this sale. Inventory decrements are conditional, so a double submit cannot sell twice.
 */
@Service
public class SellService {

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final LearningIngestService ingest;

    public SellService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                       LearningIngestService ingest) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.ingest = ingest;
    }

    public SellResult sell(long userId, UUID key, SellRequest request) {
        access.require(userId);
        // merge duplicate lines so the fingerprint and the decrements are canonical
        Map<String, Integer> merged = new LinkedHashMap<>();
        for (SellLine l : request.lines()) merged.merge(l.cropCode() + "|" + l.tier(), l.qty(), Integer::sum);
        return ctx.command(userId, key, "SELL", merged, SellResult.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            ingest.ingest(userId, ctx.repo.profile(userId), now);
            boolean blessing = ingest.blessing(userId, now);
            List<SellLineResult> lines = new ArrayList<>();
            long total = 0;
            for (var entry : merged.entrySet()) {
                String[] parts = entry.getKey().split("\\|", 2);
                CropDef crop = e.rules().crops().get(parts[0]);
                QualityTier tier = e.rules().quality().tiers().stream().filter(t -> t.code().equals(parts[1])).findFirst().orElse(null);
                if (crop == null || tier == null) throw new GardenException(400, "INVALID_COMMAND");
                int qty = entry.getValue();
                if (!ledger.takeItem(userId, "CROP:" + crop.code(), tier.code(), qty, "SELL", "SALE", op.toString(), op, now)) {
                    throw GardenException.conflict("NO_ITEM", Map.of("cropCode", crop.code(), "tier", tier.code()));
                }
                long unit = e.quality().unitSellPrice(crop, tier, blessing);
                lines.add(new SellLineResult(crop.code(), tier.code(), qty, unit, unit * qty));
                total += unit * qty;
            }
            ledger.addCoins(userId, total, "SELL", "SALE", op.toString(), op, now);
            ctx.repo.log(userId, "SELL", ctx.write(Map.of("coins", total, "blessing", blessing, "lines", lines.size())), now);
            return new SellResult(total, ctx.repo.profile(userId).coins(), blessing, lines);
        });
    }

    /**
     * Phase 3H: harvest portions (the fragments of a unit a "take a little" leaves with its owner and its taker) are sold
     * at their proportional value: {@code floor(unit price × portions / portions per unit)} per line, the unit price being
     * exactly what a whole unit of that crop and quality sells for at this moment. A floor never exceeds its part, so
     * however the portions of one unit are split between two players and several sales, together they pay at most what
     * the unit pays — no Đồng Echo is created by splitting. Fragments are still exchanged for whole units automatically
     * when ten of one crop and quality meet; selling is never required.
     */
    public ShareSellResult sellShares(long userId, UUID key, ShareSellRequest request) {
        access.require(userId);
        Map<String, Integer> merged = new LinkedHashMap<>();
        for (ShareSellLine l : request.lines()) merged.merge(l.cropCode() + "|" + l.tier(), l.portions(), Integer::sum);
        return ctx.command(userId, key, "SELL_SHARES", merged, ShareSellResult.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            if (ctx.social() == null) throw GardenException.conflict("SOCIAL_CLOSED");
            int unitPortions = ctx.social().rules().portionsPerUnit();
            ingest.ingest(userId, ctx.repo.profile(userId), now);
            boolean blessing = ingest.blessing(userId, now);
            List<SellLineResult> lines = new ArrayList<>();
            long total = 0;
            for (var entry : merged.entrySet()) {
                String[] parts = entry.getKey().split("\\|", 2);
                CropDef crop = e.rules().crops().get(parts[0]);
                QualityTier tier = e.rules().quality().tiers().stream().filter(t -> t.code().equals(parts[1])).findFirst().orElse(null);
                if (crop == null || tier == null) throw new GardenException(400, "INVALID_COMMAND");
                int portions = entry.getValue();
                if (!ledger.takeItem(userId, HarvestShares.item(crop.code()), tier.code(), portions, "SELL", "SHARE_SALE", op.toString(), op, now)) {
                    throw GardenException.conflict("NO_ITEM", Map.of("cropCode", crop.code(), "tier", tier.code()));
                }
                long unit = e.quality().unitSellPrice(crop, tier, blessing);
                long value = AnimalEngine.portionValue(unit, portions, unitPortions);
                lines.add(new SellLineResult(crop.code(), tier.code(), portions, unit, value));
                total += value;
            }
            ledger.addCoins(userId, total, "SELL", "SHARE_SALE", op.toString(), op, now);
            ctx.repo.log(userId, "SELL_SHARES", ctx.write(Map.of("coins", total, "blessing", blessing, "lines", lines.size())), now);
            return new ShareSellResult(total, ctx.repo.profile(userId).coins(), blessing, lines);
        });
    }
}
