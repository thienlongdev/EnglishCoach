package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.BoardSlotView;
import com.englishcoach.garden.api.GardenDtos.BoardView;
import com.englishcoach.garden.api.GardenDtos.CompostLineView;
import com.englishcoach.garden.api.GardenDtos.EconomyView;
import com.englishcoach.garden.api.GardenDtos.ExpandRequest;
import com.englishcoach.garden.api.GardenDtos.ExpansionPlotView;
import com.englishcoach.garden.api.GardenDtos.ExpansionReceipt;
import com.englishcoach.garden.api.GardenDtos.ExpansionView;
import com.englishcoach.garden.api.GardenDtos.MarketBuyRequest;
import com.englishcoach.garden.api.GardenDtos.MarketReceipt;
import com.englishcoach.garden.api.GardenDtos.MarketView;
import com.englishcoach.garden.api.GardenDtos.OfferView;
import com.englishcoach.garden.api.GardenDtos.OrderFillRequest;
import com.englishcoach.garden.api.GardenDtos.OrderLineView;
import com.englishcoach.garden.api.GardenDtos.OrderReceipt;
import com.englishcoach.garden.api.GardenDtos.OrderView;
import com.englishcoach.garden.api.GardenDtos.SupplyLine;
import com.englishcoach.garden.api.GardenDtos.SupplyView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.FarmEconomyRules.ExpansionPlot;
import com.englishcoach.garden.domain.GardenEngine;
import com.englishcoach.garden.domain.OrderEngine;
import com.englishcoach.garden.domain.OrderEngine.Line;
import com.englishcoach.garden.domain.OrderEngine.Supply;
import com.englishcoach.garden.infra.EconomyRepository;
import com.englishcoach.garden.infra.EconomyRepository.OrderRow;
import com.englishcoach.garden.infra.GardenRepository.Item;
import com.fasterxml.jackson.core.type.TypeReference;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Phase 3A farm economy (blueprint §6): the market stall, the delivery board and the four expansion beds.
 *
 * <ul>
 *   <li><b>Market</b>: today's offers are a pure function of the Vietnam day ({@code MarketEngine}); a purchase checks the
 *   offer is in today's rotation, the level, the per-day cap (conditional counter upsert) and the coins, then credits
 *   the items — all in the owner's advisory-lock transaction with an idempotency receipt.</li>
 *   <li><b>Board</b>: on {@code GET /state} each empty slot of the current period gets ONE frozen order
 *   ({@code ON CONFLICT DO NOTHING}); a delivery must match the frozen lines exactly, consumes each line once,
 *   pays base coins × the blessing multiplier when the blessing is active plus the bonus items, and closes the order
 *   conditionally (before expiry). Expired orders consume and pay nothing. Orders grant no XP.</li>
 *   <li><b>Expansion</b>: sequential beds 7–10 at the owner-approved cells; level + coins + exact compost, then an
 *   ordinary CROP plot that the existing plant / care / harvest pipeline uses unchanged.</li>
 * </ul>
 */
@Service
public class FarmEconomyService {

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final LearningIngestService ingest;
    private final GardenViews views;
    private final EconomyRepository repo;

    public FarmEconomyService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                              LearningIngestService ingest, GardenViews views, EconomyRepository repo) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.ingest = ingest;
        this.views = views;
        this.repo = repo;
    }

    // ------------------------------------------------------------------ materialization (GET /state)

    /** Creates the missing orders of the current periods (at most one per slot and period; never inside a command). */
    public void materialize(long userId, Instant now) {
        var e = ctx.engine();
        GardenScope.prefetch(() -> ctx.repo.profile(userId), () -> ctx.repo.plots(userId), () -> repo.board(userId, periods(e, now)));
        int level = e.levels().level(ctx.repo.profile(userId).totalXp());
        int plots = (int) ctx.repo.plots(userId).stream().filter(p -> p.unlockedAt() != null).count();
        Map<Integer, String> periods = periods(e, now);
        Map<Integer, OrderRow> existing = repo.board(userId, periods);
        for (var entry : periods.entrySet()) {
            int slot = entry.getKey();
            if (existing.containsKey(slot)) continue;
            var spec = e.orders().generate(userId, slot, now, level, plots);
            if (spec.isEmpty()) continue;
            var s = spec.get();
            repo.insertOrder(userId, slot, s.kind().name(), entry.getValue(), ctx.write(s.lines()), s.coins(),
                    ctx.write(new TreeMap<>(s.bonus())), now, e.orders().expiresAt(s.kind(), now));
        }
    }

    private static Map<Integer, String> periods(GardenEngine e, Instant now) {
        Map<Integer, String> out = new LinkedHashMap<>();
        for (int slot = 1; slot <= e.economy().orders().slots(); slot++) {
            out.put(slot, e.orders().periodKey(e.orders().kindOf(slot), now));
        }
        return out;
    }

    // ------------------------------------------------------------------ view

    public EconomyView view(long userId, Instant now, boolean blessing) {
        var e = ctx.engine();
        GardenScope.prefetch(() -> ctx.repo.profile(userId), () -> ctx.repo.inventory(userId), () -> ctx.repo.plots(userId),
                () -> repo.marketUnits(userId, e.calendar().dayKey(now)), () -> ctx.perks(userId), () -> repo.board(userId, periods(e, now)),
                () -> repo.deliveryRecord(userId), () -> repo.filledCount(userId));
        long coins = ctx.repo.profile(userId).coins();
        int level = e.levels().level(ctx.repo.profile(userId).totalXp());
        Map<String, Map<String, Integer>> stock = stock(ctx.repo.inventory(userId));
        return new EconomyView(market(userId, now, level), board(userId, now, level, blessing, stock),
                expansion(userId, level, coins, stock));
    }

    private MarketView market(long userId, Instant now, int level) {
        var e = ctx.engine();
        LocalDate day = e.calendar().dayKey(now);
        Map<String, Integer> bought = repo.marketUnits(userId, day);
        // Phase 3C: the market building shows more packs of the day's ranking and allows a few more purchases
        List<OfferView> offers = e.market().offers(day, ctx.perks(userId)).stream().map(o -> {
            int b = bought.getOrDefault(o.code(), 0);
            return new OfferView(o.code(), o.kind().name(), o.item(), o.cropCode(), o.nameVi(), o.unitQty(), o.price(),
                    o.dailyCap(), b, Math.max(0, o.dailyCap() - b), o.unlockLevel(), level < o.unlockLevel(), category(o));
        }).toList();
        return new MarketView(day, e.calendar().startOfDay(day.plusDays(1)), e.economy().market().maxPerPurchase(), offers);
    }

    /** Shop category of an offer (Phase 3D): seed packs are SEEDS; a supply has the category of the farming catalogue. */
    private String category(com.englishcoach.garden.domain.MarketEngine.Offer o) {
        if (o.kind() == com.englishcoach.garden.domain.MarketEngine.Kind.PACK) return "SEEDS";
        var farming = ctx.farming();
        var item = farming == null ? null : farming.rules().item(o.item());
        return item == null ? "CARE" : item.category().name();
    }

    private BoardView board(long userId, Instant now, int level, boolean blessing, Map<String, Map<String, Integer>> stock) {
        var e = ctx.engine();
        var o = e.economy().orders();
        Map<Integer, OrderRow> rows = repo.board(userId, periods(e, now));
        List<BoardSlotView> slots = new ArrayList<>();
        for (int slot = 1; slot <= o.slots(); slot++) {
            var kind = e.orders().kindOf(slot);
            var k = e.orders().rulesOf(kind);
            OrderRow row = rows.get(slot);
            Instant next = e.orders().expiresAt(kind, now);
            slots.add(new BoardSlotView(slot, kind.name(), k.minLevel(), level < k.minLevel(),
                    row == null ? null : order(row, now, blessing, stock), next));
        }
        return new BoardView(slots, repo.deliveryRecord(userId), repo.filledCount(userId), o.coinMultiplier(),
                e.rules().blessingSellMultiplier(), blessing);
    }

    private OrderView order(OrderRow row, Instant now, boolean blessing, Map<String, Map<String, Integer>> stock) {
        var e = ctx.engine();
        List<Line> lines = lines(row.lines());
        String status = "FILLED".equals(row.status()) ? "FILLED" : now.isBefore(row.expiresAt()) ? "OPEN" : "EXPIRED";
        List<OrderLineView> lineViews = lines.stream().map(l -> new OrderLineView(l.cropCode(), e.rules().crop(l.cropCode()).nameVi(),
                l.qty(), l.minTier(), held(stock, l.cropCode(), l.minTier()))).toList();
        List<SupplyView> preview = null;
        if ("OPEN".equals(status)) {
            preview = e.orders().allocate(lines, stock).map(FarmEconomyService::views).orElse(null);
        }
        return new OrderView(row.id(), row.slot(), row.kind(), status, lineViews, row.baseCoins(),
                e.orders().payout(row.baseCoins(), blessing), bonus(row.bonus()), row.createdAt(), row.expiresAt(),
                row.filledAt(), row.paidCoins(), row.blessing(), row.delivered() == null ? null : supplyViews(row.delivered()),
                preview, preview != null);
    }

    private ExpansionView expansion(long userId, int level, long coins, Map<String, Map<String, Integer>> stock) {
        var e = ctx.engine();
        Set<Integer> owned = ownedSlots(userId);
        var next = e.economy().expansion().next(owned).map(ExpansionPlot::slot).orElse(-1);
        List<ExpansionPlotView> plots = new ArrayList<>();
        for (ExpansionPlot p : e.economy().expansion().plots()) {
            List<CompostLineView> compost = p.compost().entrySet().stream()
                    .sorted(Map.Entry.comparingByKey())
                    .map(c -> new CompostLineView(c.getKey(), e.rules().crop(c.getKey()).nameVi(), c.getValue(),
                            held(stock, c.getKey(), e.orders().lowestTier()))).toList();
            String status = owned.contains(p.slot()) ? "OWNED" : p.slot() == next ? "NEXT" : "LATER";
            var preview = e.orders().allocate(compostLines(p), stock).map(FarmEconomyService::views).orElse(null);
            plots.add(new ExpansionPlotView(p.slot(), p.gx(), p.gy(), p.field(), p.level(), p.coins(), compost, status,
                    level >= p.level(), coins >= p.coins(), preview != null, "OWNED".equals(status) ? null : preview));
        }
        long count = e.economy().expansion().plots().stream().filter(p -> owned.contains(p.slot())).count();
        return new ExpansionView(plots, (int) count, plots.size());
    }

    /** Expansion slots this user owns (rows of garden_plot beyond the starter beds that the expansion config lists). */
    private Set<Integer> ownedSlots(long userId) {
        Set<Integer> expansion = ctx.engine().economy().expansion().plots().stream().map(ExpansionPlot::slot).collect(Collectors.toSet());
        return ctx.repo.plots(userId).stream().map(p -> p.slot()).filter(expansion::contains).collect(Collectors.toSet());
    }

    // ------------------------------------------------------------------ commands

    public MarketReceipt buy(long userId, UUID key, MarketBuyRequest request) {
        access.require(userId);
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("offerCode", request.offerCode());
        fingerprint.put("units", request.units());
        return ctx.command(userId, key, "MARKET_BUY", fingerprint, MarketReceipt.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            LocalDate day = e.calendar().dayKey(now);
            var offer = e.market().offer(day, request.offerCode(), ctx.perks(userId))
                    .orElseThrow(() -> GardenException.conflict("OFFER_UNAVAILABLE", Map.of("dayKey", day.toString())));
            int level = e.levels().level(ctx.repo.profile(userId).totalXp());
            if (level < offer.unlockLevel()) throw GardenException.conflict("OFFER_LOCKED", Map.of("level", offer.unlockLevel()));
            long total = e.market().total(offer, request.units());
            if (total < 0) throw new GardenException(400, "INVALID_COMMAND");
            int before = repo.marketUnits(userId, day).getOrDefault(offer.code(), 0);
            if (!repo.addMarketUnits(userId, day, offer.code(), request.units(), offer.dailyCap(), now)) {
                throw GardenException.conflict("MARKET_CAP", Map.of("remaining", Math.max(0, offer.dailyCap() - before)));
            }
            String ref = offer.code() + "@" + day;
            if (!ledger.takeCoins(userId, total, "MARKET_BUY", "OFFER", ref, op, now)) {
                throw GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", total - ctx.repo.profile(userId).coins()));
            }
            int items = offer.unitQty() * request.units();
            ledger.addItem(userId, offer.item(), "NA", items, "MARKET_BUY", "OFFER", ref, op, now);
            ctx.repo.log(userId, "MARKET_BUY", ctx.write(Map.of("offer", offer.code(), "units", request.units(), "coins", total,
                    "day", day.toString())), now);
            int bought = before + request.units();
            return new MarketReceipt(offer.code(), offer.item(), request.units(), items, total, ctx.repo.profile(userId).coins(),
                    bought, Math.max(0, offer.dailyCap() - bought), ctx.repo.itemQty(userId, offer.item(), "NA"),
                    view(userId, now, ingest.blessing(userId, now)));
        });
    }

    public OrderReceipt fill(long userId, UUID key, long orderId, OrderFillRequest request) {
        access.require(userId);
        List<Supply> supply = canonical(request.lines());
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("orderId", orderId);
        fingerprint.put("lines", supply);
        return ctx.command(userId, key, "ORDER_FILL", fingerprint, OrderReceipt.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            // a goal reached a minute ago already blesses this delivery (same rule as selling)
            ingest.ingest(userId, ctx.repo.profile(userId), now);
            boolean blessing = ingest.blessing(userId, now);
            OrderRow row = repo.order(userId, orderId);
            if ("FILLED".equals(row.status())) throw GardenException.conflict("ORDER_DONE");
            if (!now.isBefore(row.expiresAt())) throw GardenException.conflict("ORDER_EXPIRED");
            var check = e.orders().matches(lines(row.lines()), supply);
            if (!check.ok()) throw GardenException.conflict(check.code(), check.details());
            String ref = String.valueOf(orderId);
            for (Supply s : supply) {
                if (!ledger.takeItem(userId, "CROP:" + s.cropCode(), s.tier(), s.qty(), "ORDER", "ORDER", ref, op, now)) {
                    throw GardenException.conflict("NO_ITEM", Map.of("cropCode", s.cropCode(), "tier", s.tier()));
                }
            }
            long paid = e.orders().payout(row.baseCoins(), blessing);
            ledger.addCoins(userId, paid, "ORDER", "ORDER", ref, op, now);
            Map<String, Integer> bonus = bonus(row.bonus());
            for (var b : bonus.entrySet()) ledger.addItem(userId, b.getKey(), "NA", b.getValue(), "ORDER_BONUS", "ORDER", ref, op, now);
            if (!repo.fill(userId, orderId, now, paid, blessing, ctx.write(supply), op)) {
                throw GardenException.conflict("ORDER_EXPIRED");
            }
            ctx.repo.log(userId, "ORDER_FILL", ctx.write(Map.of("orderId", orderId, "coins", paid, "blessing", blessing,
                    "units", supply.stream().mapToInt(Supply::qty).sum())), now);
            return new OrderReceipt(orderId, paid, blessing, bonus, views(supply), ctx.repo.profile(userId).coins(),
                    view(userId, now, blessing));
        });
    }

    public ExpansionReceipt expand(long userId, UUID key, ExpandRequest request) {
        access.require(userId);
        List<Supply> compost = canonical(request.compost());
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("slot", request.slot());
        fingerprint.put("compost", compost);
        return ctx.command(userId, key, "PLOT_EXPAND", fingerprint, ExpansionReceipt.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            ExpansionPlot plot = e.economy().expansion().plot(request.slot())
                    .orElseThrow(() -> new GardenException(404, "EXPANSION_NOT_FOUND"));
            Set<Integer> owned = ownedSlots(userId);
            if (owned.contains(plot.slot())) throw GardenException.conflict("PLOT_ALREADY_OPEN");
            int next = e.economy().expansion().next(owned).map(ExpansionPlot::slot).orElse(-1);
            if (next != plot.slot()) throw GardenException.conflict("EXPANSION_ORDER", Map.of("next", next));
            int level = e.levels().level(ctx.repo.profile(userId).totalXp());
            if (level < plot.level()) throw GardenException.conflict("EXPANSION_LEVEL", Map.of("level", plot.level()));
            var check = e.orders().compostMatches(plot.compost(), compost);
            if (!check.ok()) throw GardenException.conflict(check.code(), check.details());
            String ref = "slot:" + plot.slot();
            if (!ledger.takeCoins(userId, plot.coins(), "EXPANSION", "PLOT", ref, op, now)) {
                throw GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", plot.coins() - ctx.repo.profile(userId).coins()));
            }
            for (Supply s : compost) {
                if (!ledger.takeItem(userId, "CROP:" + s.cropCode(), s.tier(), s.qty(), "EXPANSION", "PLOT", ref, op, now)) {
                    throw GardenException.conflict("NO_ITEM", Map.of("cropCode", s.cropCode(), "tier", s.tier()));
                }
            }
            Long plotId = repo.insertPlot(userId, plot.slot(), plot.gx(), plot.gy(), now);
            if (plotId == null) throw GardenException.conflict("PLOT_ALREADY_OPEN");
            ctx.repo.log(userId, "PLOT_EXPAND", ctx.write(Map.of("slot", plot.slot(), "plotId", plotId, "coins", plot.coins(),
                    "compost", compost.stream().mapToInt(Supply::qty).sum())), now);
            return new ExpansionReceipt(plot.slot(), plot.coins(), views(compost), views.plot(userId, plotId, now),
                    ctx.repo.profile(userId).coins(), view(userId, now, ingest.blessing(userId, now)));
        });
    }

    // ------------------------------------------------------------------ helpers

    /** Merged and sorted lines, so the idempotency fingerprint and the decrements are canonical. */
    static List<Supply> canonical(List<SupplyLine> lines) {
        Map<String, Integer> merged = new TreeMap<>();
        for (SupplyLine l : lines) merged.merge(l.cropCode() + "|" + l.tier(), l.qty(), Integer::sum);
        return merged.entrySet().stream().map(en -> {
            String[] p = en.getKey().split("\\|", 2);
            return new Supply(p[0], p[1], en.getValue());
        }).toList();
    }

    private static Map<String, Map<String, Integer>> stock(List<Item> inventory) {
        Map<String, Map<String, Integer>> out = new HashMap<>();
        for (Item it : inventory) {
            if (it.code().startsWith("CROP:") && it.qty() > 0) {
                out.computeIfAbsent(it.code().substring(5), c -> new HashMap<>()).merge(it.tier(), it.qty(), Integer::sum);
            }
        }
        return out;
    }

    private int held(Map<String, Map<String, Integer>> stock, String crop, String minTier) {
        var orders = ctx.engine().orders();
        int min = orders.rank(minTier);
        return stock.getOrDefault(crop, Map.of()).entrySet().stream()
                .filter(t -> orders.rank(t.getKey()) >= min).mapToInt(Map.Entry::getValue).sum();
    }

    private List<Line> compostLines(ExpansionPlot p) {
        String lowest = ctx.engine().orders().lowestTier();
        return p.compost().entrySet().stream().sorted(Map.Entry.comparingByKey())
                .map(c -> new Line(c.getKey(), c.getValue(), lowest)).toList();
    }

    private List<Line> lines(String json) {
        try {
            return ctx.json.readValue(json, new TypeReference<List<Line>>() {});
        } catch (Exception ex) {
            throw new IllegalStateException("stored order unreadable", ex);
        }
    }

    private Map<String, Integer> bonus(String json) {
        try {
            return new TreeMap<>(ctx.json.readValue(json, new TypeReference<Map<String, Integer>>() {}));
        } catch (Exception ex) {
            throw new IllegalStateException("stored order bonus unreadable", ex);
        }
    }

    private List<SupplyView> supplyViews(String json) {
        try {
            return views(ctx.json.readValue(json, new TypeReference<List<Supply>>() {}));
        } catch (Exception ex) {
            throw new IllegalStateException("stored delivery unreadable", ex);
        }
    }

    private static List<SupplyView> views(List<Supply> supply) {
        return supply.stream().sorted(Comparator.comparing(Supply::cropCode).thenComparing(Supply::tier))
                .map(s -> new SupplyView(s.cropCode(), s.tier(), s.qty())).toList();
    }
}
