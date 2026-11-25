package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.BoostRequest;
import com.englishcoach.garden.api.GardenDtos.BoostResult;
import com.englishcoach.garden.api.GardenDtos.PlantRequest;
import com.englishcoach.garden.api.GardenDtos.PlantResult;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Planting and care (roadmap 1.6). Every rule is re-checked on the server: plot ownership and emptiness, crop unlock
 * level, seed or coin availability (R1: a missing seed is bought at the fixed price inside the same transaction; Epic
 * seeds also cost essence, Legendary seeds are never sold),
 * boost limits and the boost cap. The partial unique index on active plantings and the CHECK constraints are the
 * last line of defence against double planting or negative balances.
 */
@Service
public class PlantingService {

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final GardenViews views;
    private final CollectionService collection;

    public PlantingService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                           GardenViews views, CollectionService collection) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.views = views;
        this.collection = collection;
    }

    public PlantResult plant(long userId, UUID key, long plotId, PlantRequest request) {
        access.require(userId);
        boolean qa = access.qa(userId);
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("plotId", plotId);
        fingerprint.put("cropCode", request.cropCode());
        return ctx.command(userId, key, "PLANT", fingerprint, PlantResult.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            var repo = ctx.repo;
            CropDef crop = e.rules().crops().get(request.cropCode());
            if (crop == null || (crop.qaOnly() && !qa)) throw new GardenException(404, "CROP_NOT_FOUND");
            // Phase 5: what planting checks before it writes, in one exchange
            GardenScope.prefetch(() -> repo.plot(userId, plotId), () -> repo.plotOccupied(userId, plotId), () -> repo.countPlantings(userId),
                    () -> collection.skinForPlanting(userId, crop.code()), () -> repo.essence(userId));
            var plot = repo.plot(userId, plotId);
            if (plot.unlockedAt() == null) throw GardenException.conflict("PLOT_LOCKED");
            var profile = repo.profile(userId);
            int level = e.levels().level(profile.totalXp());
            if (!crop.qaOnly() && crop.unlockLevel() > level) {
                throw GardenException.conflict("CROP_LOCKED", Map.of("level", crop.unlockLevel()));
            }
            if (repo.plotOccupied(userId, plotId)) throw GardenException.conflict("PLOT_OCCUPIED");

            String seed = "SEED:" + crop.code();
            long paid = 0;
            if (!ledger.takeItem(userId, seed, "NA", 1, "PLANT", "PLOT", String.valueOf(plotId), op, now)) {
                if (!crop.purchasable()) throw GardenException.conflict("NO_SEED");
                long price = GardenViews.seedCoinPrice(e, crop);
                // Epic seeds also cost Memory Essence (Phase 2): both are taken in this transaction or neither
                int essence = ctx.repo.essence(userId);
                if (crop.seedEssence() > essence) {
                    throw GardenException.conflict("INSUFFICIENT_ESSENCE", Map.of("missing", crop.seedEssence() - essence));
                }
                if (!ledger.takeCoins(userId, price, "SEED_BUY", "CROP", crop.code(), op, now)) {
                    throw GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", price - profile.coins()));
                }
                if (!ledger.takeEssence(userId, crop.seedEssence(), "SEED_BUY", "CROP", crop.code(), op, now)) {
                    throw GardenException.conflict("INSUFFICIENT_ESSENCE", Map.of("missing", crop.seedEssence()));
                }
                paid = price;
            }
            boolean tutorial = repo.countPlantings(userId) == 0 && crop.code().equals(e.rules().growth().tutorialCrop());
            int base = tutorial ? e.rules().growth().tutorialSeconds() : crop.baseSeconds();
            // Phase 3B: the planting keeps the skin equipped NOW (art only; never read by growth, quality or rewards)
            // Phase 3D: a planting made under the farming rules gets growth model 2 (soil moisture) for its whole life;
            // the tutorial crop keeps the simple model (its minute is too short for weather to matter)
            long id = repo.insertPlanting(userId, plotId, crop.code(), now, base, tutorial,
                    collection.skinForPlanting(userId, crop.code()), ctx.farming() != null && !tutorial ? 2 : 1);
            repo.log(userId, "PLANT", ctx.write(Map.of("plantingId", id, "plotId", plotId, "crop", crop.code(),
                    "paidCoins", paid, "tutorial", tutorial)), now);
            // Phase 5: what the answer shows, in one exchange (the bed with its new crop, the balance, the seeds left)
            GardenScope.prefetch(() -> views.plot(userId, plotId, now), () -> repo.profile(userId), () -> repo.itemQty(userId, seed, "NA"));
            return new PlantResult(views.plot(userId, plotId, now), repo.profile(userId).coins(),
                    repo.itemQty(userId, seed, "NA"), paid, tutorial);
        });
    }

    public BoostResult boost(long userId, UUID key, long plantingId, BoostRequest request) {
        access.require(userId);
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("plantingId", plantingId);
        fingerprint.put("itemCode", request.itemCode());
        return ctx.command(userId, key, "BOOST", fingerprint, BoostResult.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            var repo = ctx.repo;
            var item = e.rules().boosts().get(request.itemCode());
            if (item == null) throw new GardenException(404, "ITEM_NOT_FOUND");
            GardenScope.prefetch(() -> repo.activePlanting(userId, plantingId), () -> repo.activePlantings(userId));
            var p = repo.activePlanting(userId, plantingId);
            var snap = e.growth().evaluate(views.facts(userId, p, now), now);
            if (snap.ready()) throw GardenException.conflict("ALREADY_READY");
            boolean water = "WATER".equals(item.group());
            double cap = e.rules().growth().maxBoost();
            boolean limit = water ? p.waterCount() >= item.perPlantingLimit() : p.fertilizerCode() != null;
            if (limit || p.boostFraction() + item.fraction() > cap + 1e-9) throw GardenException.conflict("BOOST_LIMIT");
            if (!ledger.takeItem(userId, item.code(), "NA", 1, "BOOST", "PLANTING", String.valueOf(plantingId), op, now)) {
                throw GardenException.conflict("NO_ITEM");
            }
            if (!repo.applyBoost(userId, plantingId, item.fraction(), water, item.code(), item.perPlantingLimit(), cap)) {
                throw GardenException.conflict("BOOST_LIMIT");
            }
            repo.recordBoostUse(userId, plantingId, item.code(), now, op);
            repo.log(userId, "BOOST", ctx.write(Map.of("plantingId", plantingId, "item", item.code())), now);
            GardenScope.prefetch(() -> views.plot(userId, p.plotId(), now), () -> repo.itemQty(userId, item.code(), "NA"));
            return new BoostResult(views.plot(userId, p.plotId(), now), item.code(), repo.itemQty(userId, item.code(), "NA"));
        });
    }

}
