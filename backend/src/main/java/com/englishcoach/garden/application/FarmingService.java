package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.CropRecordView;
import com.englishcoach.garden.api.GardenDtos.FarmingView;
import com.englishcoach.garden.api.GardenDtos.RecordsView;
import com.englishcoach.garden.api.GardenDtos.SoilRulesView;
import com.englishcoach.garden.api.GardenDtos.SupplyItemView;
import com.englishcoach.garden.api.GardenDtos.TreatRequest;
import com.englishcoach.garden.api.GardenDtos.TreatResult;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.FarmingRules.Effect;
import com.englishcoach.garden.domain.FarmingRules.Item;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.SoilModel;
import com.englishcoach.garden.infra.CollectionRepository;
import com.englishcoach.garden.infra.FarmingRepository;
import com.englishcoach.garden.infra.PestRepository;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Phase 3D farming supplies and records.
 *
 * <ul>
 *   <li><b>Treat</b>: one supply from the owner's storehouse is applied to one of the owner's growing crops. The server
 *   decides whether the item fits (soil supplies need a crop of growth model 2 that is still growing; a pest spray needs
 *   an unresolved Forgotten Pest on that crop; a timed effect cannot be stacked while it is working; mulch and the
 *   tonic once per planting), takes exactly one item with a ledger entry and stores the treatment — all in the owner's
 *   advisory-lock transaction with an idempotency receipt. An expired effect can never be extended: a new effect always
 *   costs a new item.</li>
 *   <li><b>Learning integrity</b>: nothing here reads or writes a Flashcard. A spray suspends a pest's damage; the pest,
 *   its overdue word and the genuine-review cure of {@link PestService} are untouched and no reward is granted.</li>
 *   <li><b>Records</b>: lifetime harvests come from the Phase 3B mastery counters (never lowered by a sale); what left
 *   the storehouse and the coin totals are read from the append-only ledger.</li>
 * </ul>
 */
@Service
public class FarmingService {

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final GardenViews views;
    private final FarmingRepository repo;
    private final PestRepository pests;
    private final CollectionRepository collection;

    public FarmingService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                          GardenViews views, FarmingRepository repo, PestRepository pests, CollectionRepository collection) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.views = views;
        this.repo = repo;
        this.pests = pests;
        this.collection = collection;
    }

    // ------------------------------------------------------------------ view

    /** The supply catalogue with this owner's stock and today's harvest-bonus counter; null without the farming rules. */
    public FarmingView view(long userId, Instant now) {
        var farming = ctx.farming();
        if (farming == null) return null;
        var e = ctx.engine();
        GardenScope.prefetch(() -> ctx.repo.profile(userId), () -> ctx.repo.inventory(userId),
                () -> repo.harvestBonusPaid(userId, e.calendar().dayKey(now)));
        int level = e.levels().level(ctx.repo.profile(userId).totalXp());
        Map<String, Integer> owned = new HashMap<>();
        ctx.repo.inventory(userId).forEach(i -> owned.merge(i.code(), i.qty(), Integer::sum));
        List<SupplyItemView> items = new ArrayList<>();
        for (Item item : farming.rules().items().values()) {
            var staple = e.economy().staple(item.code());
            var boost = e.rules().boosts().get(item.code());
            String name = staple != null ? staple.nameVi() : boost != null ? boost.nameVi() : item.code();
            int unlock = staple == null ? 1 : staple.unlockLevel();
            items.add(new SupplyItemView(item.code(), name, item.category().name(), item.effect().name(), item.hours(),
                    item.value(), staple == null ? null : Math.round(staple.price() * e.rules().coinScale()), unlock,
                    level < unlock, owned.getOrDefault(item.code(), 0)));
        }
        var s = farming.rules().soil();
        return new FarmingView(items, new SoilRulesView(s.dryBelow(), s.wetAbove(), s.waterGain(), s.dryFactor(), s.wetFactor(),
                s.maxStressHours(), s.severeShare(), s.severeTierCap()), repo.harvestBonusPaid(userId, e.calendar().dayKey(now)), farming.rules().harvestBonus().dailyCap());
    }

    // ------------------------------------------------------------------ command

    public TreatResult treat(long userId, UUID key, long plantingId, TreatRequest request) {
        access.require(userId);
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("plantingId", plantingId);
        fingerprint.put("itemCode", request.itemCode());
        return ctx.command(userId, key, "TREAT", fingerprint, TreatResult.class, setup.ensurer(userId), (now, op) -> {
            var farming = ctx.farming();
            if (farming == null) throw GardenException.conflict("FARMING_CLOSED");
            Item item = farming.rules().item(request.itemCode());
            // fertilizers and water keep their own command (they change the required growth work)
            if (item == null || item.effect() == Effect.BOOST) throw new GardenException(404, "ITEM_NOT_FOUND");
            var p = ctx.repo.activePlanting(userId, plantingId);
            var growing = views.growing(userId, p, now);
            var snap = ctx.engine().growth().evaluate(growing.facts(), now);
            var applied = growing.treatments();
            boolean pestItem = item.effect() == Effect.PEST_SPRAY || item.effect() == Effect.PEST_NET;
            if (!pestItem) {
                // soil supplies: only a growing crop planted under the Phase 3D rules has soil to care for
                if (!p.soil() || growing.soil() == null) throw GardenException.conflict("TREATMENT_NOT_NEEDED");
                if (snap.ready()) throw GardenException.conflict("ALREADY_READY");
            }
            switch (item.effect()) {
                case MOISTURE -> {
                    SoilModel.Condition c = growing.soil().at(now);
                    if (c.moisture() >= farming.rules().soil().wetAbove() - 1e-9) throw GardenException.conflict("SOIL_TOO_WET");
                }
                case TONIC, MULCH -> {
                    if (farming.everApplied(applied, item.effect(), now)) throw GardenException.conflict("TREATMENT_USED");
                }
                case PEST_SPRAY -> {
                    boolean unresolved = pests.active(userId).stream()
                            .anyMatch(x -> x.plantingId() != null && x.plantingId() == plantingId && x.reviewedAt() == null);
                    if (!unresolved) throw GardenException.conflict("NO_PEST");
                    requireIdle(farming.active(applied, item.effect(), now), applied, item, now, farming);
                }
                default -> requireIdle(farming.active(applied, item.effect(), now), applied, item, now, farming);
            }
            if (!ledger.takeItem(userId, item.code(), "NA", 1, "TREAT", "PLANTING", String.valueOf(plantingId), op, now)) {
                throw GardenException.conflict("NO_ITEM", Map.of("itemCode", item.code()));
            }
            Instant expires = farming.expiresAt(item, now);
            repo.insertTreatment(userId, plantingId, item.code(), now, expires, op);
            ctx.repo.log(userId, "TREAT", ctx.write(Map.of("plantingId", plantingId, "item", item.code())), now);
            return new TreatResult(views.plot(userId, p.plotId(), now), item.code(), ctx.repo.itemQty(userId, item.code(), "NA"), expires);
        });
    }

    /** A timed effect cannot be stacked while it is still working (the answer says when it ends). */
    private static void requireIdle(boolean active, List<com.englishcoach.garden.domain.FarmingEngine.Treatment> applied, Item item,
                                    Instant now, com.englishcoach.garden.domain.FarmingEngine farming) {
        if (!active) return;
        Instant until = applied.stream().filter(t -> t.itemCode().equals(item.code()) && t.activeAt(now) && t.expiresAt() != null)
                .map(com.englishcoach.garden.domain.FarmingEngine.Treatment::expiresAt).max(Comparator.naturalOrder()).orElse(null);
        throw GardenException.conflict("TREATMENT_ACTIVE", until == null ? Map.of() : Map.of("expiresAt", until.toString()));
    }

    // ------------------------------------------------------------------ records

    /** Lifetime farm records of the owner (GET, read only). */
    public RecordsView records(long userId) {
        access.require(userId);
        return ctx.read(userId, now -> {
            var e = ctx.engine();
            Map<String, long[]> flows = new HashMap<>(); // crop -> sold, delivered, composted, used
            long saleCoins = 0, orderCoins = 0, bonusCoins = 0;
            for (var f : repo.produceAndCoinFlows(userId)) {
                if (f.asset().equals("COIN")) {
                    switch (f.reason()) {
                        case "SELL" -> saleCoins += f.total();
                        case "ORDER" -> orderCoins += f.total();
                        case "HARVEST_BONUS" -> bonusCoins += f.total();
                        default -> { }
                    }
                    continue;
                }
                long[] row = flows.computeIfAbsent(f.asset().substring(5), k -> new long[4]);
                switch (f.reason()) {
                    case "SELL" -> row[0] -= f.total();
                    case "ORDER" -> row[1] -= f.total();
                    case "COMPOST" -> row[2] -= f.total();
                    case "EXPANSION", "BUILDING", "LAND" -> row[3] -= f.total();
                    default -> { }
                }
            }
            Map<String, Integer> stock = new HashMap<>();
            ctx.repo.inventory(userId).stream().filter(i -> i.code().startsWith("CROP:"))
                    .forEach(i -> stock.merge(i.code().substring(5), i.qty(), Integer::sum));
            var mastery = collection.mastery(userId);
            List<CropRecordView> crops = new ArrayList<>();
            long harvested = 0, sold = 0, delivered = 0, composted = 0, used = 0;
            for (CropDef c : e.rules().crops().values().stream().sorted(Comparator.comparingInt(CropDef::sortOrder)).toList()) {
                if (c.qaOnly()) continue;
                var m = mastery.get(c.code());
                long[] row = flows.getOrDefault(c.code(), new long[4]);
                int h = m == null ? 0 : m.harvests();
                if (h == 0 && stock.getOrDefault(c.code(), 0) == 0 && row[0] + row[1] + row[2] + row[3] == 0) continue;
                crops.add(new CropRecordView(c.code(), c.nameVi(), h, m == null ? 0 : m.tier(), stock.getOrDefault(c.code(), 0),
                        row[0], row[1], row[2], row[3]));
                harvested += h;
                sold += row[0];
                delivered += row[1];
                composted += row[2];
                used += row[3];
            }
            return new RecordsView(crops, harvested, sold, delivered, composted, used, saleCoins, orderCoins, bonusCoins);
        });
    }
}
