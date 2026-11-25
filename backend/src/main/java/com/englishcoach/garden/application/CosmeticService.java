package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.CosmeticBuyRequest;
import com.englishcoach.garden.api.GardenDtos.CosmeticCollectionView;
import com.englishcoach.garden.api.GardenDtos.CosmeticEquipRequest;
import com.englishcoach.garden.api.GardenDtos.CosmeticEquipResult;
import com.englishcoach.garden.api.GardenDtos.CosmeticItemView;
import com.englishcoach.garden.api.GardenDtos.CosmeticReceipt;
import com.englishcoach.garden.api.GardenDtos.CosmeticShopView;
import com.englishcoach.garden.api.GardenDtos.CosmeticSkinView;
import com.englishcoach.garden.api.GardenDtos.CosmeticStateView;
import com.englishcoach.garden.api.GardenDtos.DecorMoveRequest;
import com.englishcoach.garden.api.GardenDtos.DecorPlaceRequest;
import com.englishcoach.garden.api.GardenDtos.DecorRegionView;
import com.englishcoach.garden.api.GardenDtos.DecorResult;
import com.englishcoach.garden.api.GardenDtos.DecorView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.config.GardenProperties;
import com.englishcoach.garden.domain.CosmeticRules;
import com.englishcoach.garden.domain.CosmeticRules.Facts;
import com.englishcoach.garden.domain.CosmeticRules.Item;
import com.englishcoach.garden.domain.CosmeticRules.Spot;
import com.englishcoach.garden.infra.CommerceRepository;
import com.englishcoach.garden.infra.CosmeticRepository;
import com.englishcoach.garden.infra.CosmeticRepository.Placement;
import com.englishcoach.garden.infra.EstateRepository;
import com.englishcoach.garden.infra.KnowledgeRepository;
import com.englishcoach.garden.infra.MonumentRepository;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * The cosmetic shop, ownership, equipment and island decoration (Phase 3E).
 *
 * <ul>
 *   <li><b>Catalogue</b> comes from the Flyway seed (V86); the client only names an item code. Price, eligibility,
 *   ownership, the equipped appearance and every decoration position are decided here.</li>
 *   <li><b>Acquire</b>: a coin item takes its price once (guarded balance + ledger {@code COSMETIC_BUY}) and grants
 *   one unit; an earned item is granted for free when its stored fact reaches the requirement (verified learning days,
 *   lifetime harvests, graduated memory trees) and can never be bought. Each unit has its own idempotency key; a
 *   replayed or concurrent request cannot charge or grant twice.</li>
 *   <li><b>Equip</b>: one owned appearance per slot (house, the three vegetation families, the monument set, fence,
 *   path, bed frame); {@code null} restores the island's own look. Nothing is consumed.</li>
 *   <li><b>Decorations</b> stand on snapped points inside the configured regions, never closer to another decoration
 *   than their footprints allow, at most {@code maxPlaced} at once. Storing one never destroys it.</li>
 * </ul>
 * Nothing here changes growth, quality, produce prices, XP, weather, pests, land, building levels or learning records,
 * and nothing here reads or writes Premium, AI quota, avatar frames or the payment module.
 */
@Service
public class CosmeticService {

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final CosmeticRepository repo;
    private final CollectionService collection;
    private final MonumentRepository monument;
    private final EstateRepository estate;
    private final KnowledgeRepository knowledge;
    private final GardenProperties properties;
    private final CosmeticCheckoutService checkout;
    private final CommerceRepository commerce;

    public CosmeticService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                           CosmeticRepository repo, CollectionService collection, MonumentRepository monument,
                           EstateRepository estate, KnowledgeRepository knowledge, GardenProperties properties,
                           CosmeticCheckoutService checkout, CommerceRepository commerce) {
        this.checkout = checkout;
        this.commerce = commerce;
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.repo = repo;
        this.collection = collection;
        this.monument = monument;
        this.estate = estate;
        this.knowledge = knowledge;
        this.properties = properties;
    }

    private CosmeticRules rules() {
        CosmeticRules r = ctx.cosmetics();
        if (r == null) throw GardenException.conflict("COSMETICS_CLOSED");
        return r;
    }

    /** The stored facts earned items are checked against. */
    Facts facts(long userId) {
        var m = monument.row(userId);
        return new Facts(m == null ? 0 : m.learningDays(), estate.harvests(userId), knowledge.forestCount(userId));
    }

    // ------------------------------------------------------------------ views

    /** What the island wears (part of {@code GET /state}); null on a database without the V86 catalogue. */
    public CosmeticStateView stateView(long userId) {
        CosmeticRules r = ctx.cosmetics();
        return r == null ? null : stateView(userId, r);
    }

    private CosmeticStateView stateView(long userId, CosmeticRules r) {
        GardenScope.prefetch(() -> repo.equipped(userId), () -> repo.placements(userId));
        Map<String, String> codes = repo.equipped(userId);
        Map<String, String> art = new LinkedHashMap<>();
        codes.forEach((slot, code) -> {
            Item item = r.item(code);
            if (item != null) art.put(slot, item.artKey());
        });
        List<DecorView> decor = new ArrayList<>();
        for (Placement p : repo.placements(userId)) {
            Item item = r.item(p.code());
            if (item != null) decor.add(decorView(p, item));
        }
        return new CosmeticStateView(art, codes, decor, r.regions().stream()
                .map(g -> new DecorRegionView(g.code(), g.nameVi(), g.x0(), g.y0(), g.x1(), g.y1())).toList(), r.maxPlaced(), r.snap());
    }

    private static DecorView decorView(Placement p, Item item) {
        return new DecorView(p.id(), p.code(), item.artKey(), p.region(), p.gx(), p.gy(), item.footprint());
    }

    public CosmeticShopView shop(long userId) {
        access.require(userId);
        boolean qa = access.qa(userId);
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            collection.ensureSeeded(userId, now);
            return shopView(userId, now, qa);
        });
    }

    CosmeticShopView shopView(long userId, Instant now, boolean qa) {
        CosmeticRules r = rules();
        // Phase 5: what the shop reads, in a few exchanges instead of one per statement
        GardenScope.prefetch(3, () -> ctx.repo.profile(userId), () -> facts(userId), () -> repo.owned(userId), () -> repo.equipped(userId),
                () -> repo.placements(userId), () -> { if (checkout.open()) commerce.prices("COSMETIC"); },
                () -> { if (checkout.open()) commerce.prices("SKIN"); }, () -> { if (commerce.present()) commerce.pendingOrders(userId); },
                () -> collection.view(userId, now, qa));
        long coins = ctx.repo.profile(userId).coins();
        Facts facts = facts(userId);
        var owned = repo.owned(userId);
        Map<String, String> equipped = repo.equipped(userId);
        Map<String, Integer> placed = new LinkedHashMap<>();
        repo.placements(userId).forEach(p -> placed.merge(p.code(), 1, Integer::sum));
        Map<String, int[]> perCollection = new LinkedHashMap<>();
        r.collections().keySet().forEach(c -> perCollection.put(c, new int[2]));
        List<CosmeticItemView> items = new ArrayList<>();
        int itemsOwned = 0;
        // Phase 3F: the fixed VND price of an item that can be bought by bank transfer, and this player's open order for it
        boolean vnd = checkout.open();
        Map<String, Long> itemPrices = vnd ? commerce.prices("COSMETIC") : Map.of();
        Map<String, Long> skinPrices = vnd ? commerce.prices("SKIN") : Map.of();
        Map<String, Long> pending = commerce.present() ? commerce.pendingOrders(userId) : Map.of();
        for (Item item : r.items().values()) {
            var have = owned.get(item.code());
            int qty = have == null ? 0 : have.quantity();
            var check = r.check(item, facts, coins);
            String status = qty >= item.maxOwned() ? "OWNED" : check.requirementOk() ? "AVAILABLE" : "LOCKED";
            items.add(new CosmeticItemView(item.code(), item.category(), item.family(), item.collection(), item.nameVi(),
                    item.descriptionVi(), item.artKey(), item.unlockKind(), item.coinPrice(), item.requirement(), check.progress(),
                    check.requirementOk(), check.coinsOk(), item.maxOwned(), qty, placed.getOrDefault(item.code(), 0),
                    item.code().equals(equipped.get(item.category())), status, item.footprint(),
                    item.coin() && qty == 0 ? itemPrices.get(item.code()) : null, pending.get("COSMETIC:" + item.code())));
            int[] n = perCollection.get(item.collection());
            n[0]++;
            if (qty > 0) {
                n[1]++;
                itemsOwned++;
            }
        }
        // cultivars of a collection: eligibility comes from the codex (one source of truth for mastery / learning gates)
        List<CosmeticSkinView> skins = new ArrayList<>();
        int total = items.size();
        for (var crop : collection.view(userId, now, qa).crops()) {
            for (var s : crop.skins()) {
                String col = r.skinCollections().get(s.code());
                if (col == null) continue;
                skins.add(new CosmeticSkinView(s.code(), s.cropCode(), crop.nameVi(), col, s.nameVi(), s.descriptionVi(), s.artKey(),
                        s.unlockKind(), s.coinPrice(), s.masteryTier(), s.learningDays(), s.masteryOk(), s.learningOk(), s.coinsOk(),
                        s.status(), s.equipped(),
                        "COIN".equals(s.unlockKind()) && !"OWNED".equals(s.status()) && s.masteryOk() && s.learningOk() ? skinPrices.get(s.code()) : null,
                        pending.get("SKIN:" + s.code())));
                int[] n = perCollection.get(col);
                n[0]++;
                total++;
                if ("OWNED".equals(s.status())) {
                    n[1]++;
                    itemsOwned++;
                }
            }
        }
        List<CosmeticCollectionView> collections = r.collections().values().stream()
                .map(c -> new CosmeticCollectionView(c.code(), c.nameVi(), c.descriptionVi(), perCollection.get(c.code())[0],
                        perCollection.get(c.code())[1])).toList();
        // direct purchase is reported open only when the switch is on AND the payment gateway can take and verify payments
        return new CosmeticShopView(coins, collections, items, skins, stateView(userId, r), itemsOwned, total, vnd);
    }

    // ------------------------------------------------------------------ acquire

    /** "Mua" (coin item) or "Nhận" (earned item): the catalogue decides which; the client only names the item. */
    public CosmeticReceipt buy(long userId, UUID key, CosmeticBuyRequest request) {
        access.require(userId);
        boolean qa = access.qa(userId);
        return ctx.command(userId, key, "COSMETIC_BUY", Map.of("code", request.code()), CosmeticReceipt.class,
                setup.ensurer(userId), (now, op) -> {
                    CosmeticRules r = rules();
                    Item item = r.item(request.code());
                    if (item == null) throw new GardenException(404, "COSMETIC_NOT_FOUND");
                    int qty = repo.quantity(userId, item.code());
                    if (qty >= item.maxOwned()) throw GardenException.conflict("COSMETIC_OWNED");
                    long coins = ctx.repo.profile(userId).coins();
                    var check = r.check(item, facts(userId), coins);
                    if (!check.requirementOk()) {
                        throw GardenException.conflict("COSMETIC_LOCKED", Map.of("reason", item.unlockKind(), "need", item.requirement(),
                                "have", check.progress()));
                    }
                    if (check.price() > 0 && !ledger.takeCoins(userId, check.price(), "COSMETIC_BUY", "COSMETIC", item.code(), op, now)) {
                        throw GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", check.price() - coins));
                    }
                    if (!repo.grantUnit(userId, item.code(), qty + 1, item.unlockKind(), check.price(), null, op, now)) {
                        throw GardenException.conflict("COSMETIC_OWNED");
                    }
                    ctx.repo.log(userId, "COSMETIC_ACQUIRE", ctx.write(Map.of("code", item.code(), "unit", qty + 1,
                            "kind", item.unlockKind(), "coins", check.price())), now);
                    return new CosmeticReceipt(item.code(), qty + 1, item.unlockKind(), check.price(), ctx.repo.profile(userId).coins(),
                            shopView(userId, now, qa));
                });
    }

    // ------------------------------------------------------------------ equip

    /** Chooses the appearance a slot shows ({@code code} null = the island's own look). */
    public CosmeticEquipResult equip(long userId, UUID key, CosmeticEquipRequest request) {
        access.require(userId);
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("slot", request.slot());
        fingerprint.put("code", request.code());
        return ctx.command(userId, key, "COSMETIC_EQUIP", fingerprint, CosmeticEquipResult.class, setup.ensurer(userId), (now, op) -> {
            CosmeticRules r = rules();
            if (!CosmeticRules.SLOTS.contains(request.slot())) throw new GardenException(404, "COSMETIC_SLOT_NOT_FOUND");
            if (request.code() == null) {
                repo.unequip(userId, request.slot());
            } else {
                Item item = r.item(request.code());
                // an unknown item and an item the player does not own are indistinguishable: 404
                if (item == null || repo.quantity(userId, item.code()) < 1) throw new GardenException(404, "COSMETIC_NOT_FOUND");
                if (!item.category().equals(request.slot())) throw GardenException.conflict("COSMETIC_SLOT_MISMATCH");
                repo.equip(userId, request.slot(), item.code(), now);
            }
            ctx.repo.log(userId, "COSMETIC_EQUIP", ctx.write(Map.of("slot", request.slot(), "code", request.code() == null ? "" : request.code())), now);
            return new CosmeticEquipResult(request.slot(), request.code(), stateView(userId, r));
        });
    }

    // ------------------------------------------------------------------ decorations

    private List<Spot> spots(CosmeticRules r, List<Placement> placements, Long except) {
        List<Spot> out = new ArrayList<>();
        for (Placement p : placements) {
            if (except != null && p.id() == except) continue;
            Item item = r.item(p.code());
            out.add(new Spot(p.id(), p.gx(), p.gy(), item == null ? 0.5 : item.footprint()));
        }
        return out;
    }

    private static double grid(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    /** Stands one stored unit of a decoration at a point of a decoration region. */
    public DecorResult place(long userId, UUID key, DecorPlaceRequest request) {
        access.require(userId);
        double gx = grid(request.gx());
        double gy = grid(request.gy());
        return ctx.command(userId, key, "DECOR_PLACE", Map.of("code", request.code(), "gx", gx, "gy", gy), DecorResult.class,
                setup.ensurer(userId), (now, op) -> {
                    CosmeticRules r = rules();
                    Item item = r.item(request.code());
                    int qty = item == null ? 0 : repo.quantity(userId, item.code());
                    if (item == null || qty < 1) throw new GardenException(404, "COSMETIC_NOT_FOUND");
                    if (!item.placeable()) throw GardenException.conflict("COSMETIC_NOT_PLACEABLE");
                    List<Placement> all = repo.placements(userId);
                    if (all.size() >= r.maxPlaced()) throw GardenException.conflict("DECOR_LIMIT", Map.of("max", r.maxPlaced()));
                    boolean[] used = new boolean[qty + 2];
                    all.stream().filter(p -> p.code().equals(item.code()) && p.unitNo() <= qty).forEach(p -> used[p.unitNo()] = true);
                    int unit = 0;
                    for (int u = 1; u <= qty && unit == 0; u++) if (!used[u]) unit = u;
                    if (unit == 0) throw GardenException.conflict("DECOR_NONE_STORED");
                    var error = r.placementError(item, gx, gy, spots(r, all, null));
                    if (error.isPresent()) throw GardenException.conflict(error.get());
                    String region = r.regionAt(gx, gy).orElseThrow().code();
                    long id = repo.place(userId, item.code(), unit, region, gx, gy, now);
                    ctx.repo.log(userId, "DECOR_PLACE", ctx.write(Map.of("code", item.code(), "unit", unit, "region", region, "gx", gx, "gy", gy)), now);
                    return new DecorResult(new DecorView(id, item.code(), item.artKey(), region, gx, gy, item.footprint()), stateView(userId, r));
                });
    }

    /** Moves a decoration that stands; the same rules as placing it (it never counts against itself). */
    public DecorResult move(long userId, UUID key, long id, DecorMoveRequest request) {
        access.require(userId);
        double gx = grid(request.gx());
        double gy = grid(request.gy());
        return ctx.command(userId, key, "DECOR_MOVE", Map.of("id", id, "gx", gx, "gy", gy), DecorResult.class, setup.ensurer(userId), (now, op) -> {
            CosmeticRules r = rules();
            List<Placement> all = repo.placements(userId);
            // another player's decoration and an unknown one are indistinguishable: 404
            Placement p = all.stream().filter(x -> x.id() == id).findFirst().orElseThrow(() -> new GardenException(404, "DECOR_NOT_FOUND"));
            Item item = r.item(p.code());
            if (item == null) throw new GardenException(404, "DECOR_NOT_FOUND");
            var error = r.placementError(item, gx, gy, spots(r, all, id));
            if (error.isPresent()) throw GardenException.conflict(error.get());
            String region = r.regionAt(gx, gy).orElseThrow().code();
            if (!repo.move(userId, id, region, gx, gy, now)) throw new GardenException(404, "DECOR_NOT_FOUND");
            ctx.repo.log(userId, "DECOR_MOVE", ctx.write(Map.of("id", id, "region", region, "gx", gx, "gy", gy)), now);
            return new DecorResult(new DecorView(id, item.code(), item.artKey(), region, gx, gy, item.footprint()), stateView(userId, r));
        });
    }

    /** Puts a decoration back into storage: the unit stays owned and can be placed again. */
    public DecorResult store(long userId, UUID key, long id) {
        access.require(userId);
        return ctx.command(userId, key, "DECOR_STORE", Map.of("id", id), DecorResult.class, setup.ensurer(userId), (now, op) -> {
            CosmeticRules r = rules();
            if (!repo.store(userId, id)) throw new GardenException(404, "DECOR_NOT_FOUND");
            ctx.repo.log(userId, "DECOR_STORE", ctx.write(Map.of("id", id)), now);
            return new DecorResult(null, stateView(userId, r));
        });
    }
}
