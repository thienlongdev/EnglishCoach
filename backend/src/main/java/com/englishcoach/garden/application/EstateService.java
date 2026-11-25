package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.BuildingLevelView;
import com.englishcoach.garden.api.GardenDtos.BuildingReceipt;
import com.englishcoach.garden.api.GardenDtos.BuildingUpgradeRequest;
import com.englishcoach.garden.api.GardenDtos.BuildingView;
import com.englishcoach.garden.api.GardenDtos.CompostLineView;
import com.englishcoach.garden.api.GardenDtos.CompostReceipt;
import com.englishcoach.garden.api.GardenDtos.CompostRequest;
import com.englishcoach.garden.api.GardenDtos.EffectView;
import com.englishcoach.garden.api.GardenDtos.EstateView;
import com.englishcoach.garden.api.GardenDtos.LandBuyRequest;
import com.englishcoach.garden.api.GardenDtos.LandPlotView;
import com.englishcoach.garden.api.GardenDtos.LandReceipt;
import com.englishcoach.garden.api.GardenDtos.LandView;
import com.englishcoach.garden.api.GardenDtos.RecipeView;
import com.englishcoach.garden.api.GardenDtos.RegionView;
import com.englishcoach.garden.api.GardenDtos.RequirementView;
import com.englishcoach.garden.api.GardenDtos.SupplyView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.EstateEngine;
import com.englishcoach.garden.domain.EstateRules;
import com.englishcoach.garden.domain.EstateRules.Building;
import com.englishcoach.garden.domain.EstateRules.BuildingLevel;
import com.englishcoach.garden.domain.EstateRules.LandPlot;
import com.englishcoach.garden.domain.EstateRules.Recipe;
import com.englishcoach.garden.domain.EstateRules.Region;
import com.englishcoach.garden.domain.OrderEngine.Line;
import com.englishcoach.garden.domain.OrderEngine.Supply;
import com.englishcoach.garden.infra.EconomyRepository;
import com.englishcoach.garden.infra.EstateRepository;
import com.englishcoach.garden.infra.GardenRepository.Item;
import com.englishcoach.garden.infra.MonumentRepository;
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
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Phase 3C estate (blueprint §8.1): building upgrades, the storehouse's compost bin and farmland regions.
 *
 * <ul>
 *   <li><b>Buildings</b> (cottage, storehouse, market stall): a level costs farm level + coins + exact produce, is bought
 *   in order and exactly once (conditional row change + idempotency receipt + ledger). A level only changes the bounded
 *   perks of {@link EstateEngine.Perks}; it never touches growth speed, prices, XP or learning rewards, and inventory
 *   is never capped.</li>
 *   <li><b>Compost</b>: surplus produce becomes one fertilizer, at most the storehouse level's batches per Vietnam day
 *   (the same conditional per-day counter the market uses).</li>
 *   <li><b>Land</b>: three regions on reserved future-field cells. A region opens when its gate of recorded farm facts is
 *   met; its beds are bought in order with coins (minus the learning discount) and produce. A bought bed is an ordinary
 *   CROP plot: planting, care, weather, pests, harvest, mastery and skins work on it unchanged.</li>
 * </ul>
 */
@Service
public class EstateService {

    private static final String COMPOST_PREFIX = "COMPOST:";

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final LearningIngestService ingest;
    private final GardenViews views;
    private final EstateRepository repo;
    private final EconomyRepository economyRepo;
    private final MonumentRepository monument;
    private final CollectionService collection;
    private final ContributionService contribution;
    private final FarmEconomyService economy;

    public EstateService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                         LearningIngestService ingest, GardenViews views, EstateRepository repo, EconomyRepository economyRepo,
                         MonumentRepository monument, CollectionService collection, ContributionService contribution,
                         FarmEconomyService economy) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.ingest = ingest;
        this.views = views;
        this.repo = repo;
        this.economyRepo = economyRepo;
        this.monument = monument;
        this.collection = collection;
        this.contribution = contribution;
        this.economy = economy;
    }

    // ------------------------------------------------------------------ view

    public EstateView view(long userId, Instant now) {
        var e = ctx.engine();
        // Phase 5: what the estate panels read, in one exchange
        GardenScope.prefetch(() -> ctx.repo.profile(userId), () -> ctx.repo.inventory(userId), () -> ctx.repo.buildingLevels(userId),
                () -> economyRepo.marketUnits(userId, e.calendar().dayKey(now)), () -> ctx.repo.plots(userId), () -> learningDays(userId),
                () -> economyRepo.filledCount(userId), () -> repo.harvests(userId), () -> contribution.view(userId, now),
                () -> contribution.shop(userId, now));
        var profile = ctx.repo.profile(userId);
        int level = e.levels().level(profile.totalXp());
        Map<String, Map<String, Integer>> stock = stock(ctx.repo.inventory(userId));
        return new EstateView(buildings(userId, level, profile.coins(), stock), compost(userId, now, stock),
                land(userId, level, profile.coins(), stock), contribution.view(userId, now), contribution.shop(userId, now));
    }

    private static List<EffectView> effects(Map<String, Double> effects) {
        return effects.entrySet().stream().sorted(Map.Entry.comparingByKey()).map(x -> new EffectView(x.getKey(), x.getValue())).toList();
    }

    private List<CompostLineView> materials(Map<String, Integer> materials, Map<String, Map<String, Integer>> stock) {
        var e = ctx.engine();
        return materials.entrySet().stream().sorted(Map.Entry.comparingByKey())
                .map(c -> new CompostLineView(c.getKey(), e.rules().crop(c.getKey()).nameVi(), c.getValue(),
                        held(stock, c.getKey(), e.orders().lowestTier()))).toList();
    }

    private BuildingLevelView levelView(BuildingLevel l, Map<String, Map<String, Integer>> stock) {
        return new BuildingLevelView(l.level(), l.minLevel(), l.coins(), materials(l.materials(), stock), effects(l.effects()));
    }

    private List<BuildingView> buildings(long userId, int level, long coins, Map<String, Map<String, Integer>> stock) {
        var engine = ctx.estate();
        Map<String, Integer> levels = ctx.repo.buildingLevels(userId);
        List<BuildingView> out = new ArrayList<>();
        for (Building b : engine.rules().buildings().values()) {
            int current = levels.getOrDefault(b.code(), 0);
            var next = engine.nextLevel(b.code(), current).orElse(null);
            List<SupplyView> preview = next == null ? null
                    : ctx.engine().orders().allocate(lines(next.materials()), stock).map(EstateService::supplyViews).orElse(null);
            out.add(new BuildingView(b.code(), b.nameVi(), current, b.maxLevel(),
                    current == 0 ? List.of() : effects(b.level(current).orElseThrow().effects()),
                    next == null ? null : levelView(next, stock), next != null && level >= next.minLevel(),
                    next != null && coins >= next.coins(), preview != null, preview,
                    b.levels().stream().map(l -> levelView(l, stock)).toList()));
        }
        return out;
    }

    private List<RecipeView> compost(long userId, Instant now, Map<String, Map<String, Integer>> stock) {
        var engine = ctx.estate();
        var perks = ctx.perks(userId);
        LocalDate day = ctx.engine().calendar().dayKey(now);
        Map<String, Integer> used = economyRepo.marketUnits(userId, day);
        List<RecipeView> out = new ArrayList<>();
        out.add(recipeView("STANDARD", engine.rules().compost().standard(), perks.compostDaily(), used, stock));
        out.add(recipeView("PREMIUM", engine.rules().compost().premium(), perks.premiumCompostDaily(), used, stock));
        return out;
    }

    private RecipeView recipeView(String code, Recipe r, int cap, Map<String, Integer> used, Map<String, Map<String, Integer>> stock) {
        int done = used.getOrDefault(COMPOST_PREFIX + code, 0);
        List<Supply> preview = compostPreview(r, stock);
        return new RecipeView(code, r.units(), r.minTier(), r.gives(), cap, done, Math.max(0, cap - done),
                heldAny(stock, r.minTier()), preview == null ? null : supplyViews(preview));
    }

    /**
     * The default compost batch: the cheapest produce first (lowest accepted tier, then lowest sell price), so the
     * player's best crops are never composted by default; null when the stock holds fewer than the recipe's units.
     */
    private List<Supply> compostPreview(Recipe r, Map<String, Map<String, Integer>> stock) {
        var e = ctx.engine();
        int min = e.orders().rank(r.minTier());
        record Unit(String crop, String tier, int qty, int rank, int price) {}
        List<Unit> units = new ArrayList<>();
        stock.forEach((crop, tiers) -> tiers.forEach((tier, qty) -> {
            var def = e.rules().crops().get(crop);
            int rank = e.orders().rank(tier);
            if (def != null && !def.qaOnly() && rank >= min && qty > 0) units.add(new Unit(crop, tier, qty, rank, def.sellPrice()));
        }));
        units.sort(Comparator.comparingInt(Unit::rank).thenComparingInt(Unit::price).thenComparing(Unit::crop));
        int need = r.units();
        List<Supply> out = new ArrayList<>();
        for (Unit u : units) {
            if (need == 0) break;
            int take = Math.min(u.qty(), need);
            out.add(new Supply(u.crop(), u.tier(), take));
            need -= take;
        }
        return need > 0 ? null : out;
    }

    private LandView land(long userId, int level, long coins, Map<String, Map<String, Integer>> stock) {
        var engine = ctx.estate();
        var rules = engine.rules().land();
        Set<Integer> owned = ownedSlots(userId);
        int learningDays = learningDays(userId);
        int orders = economyRepo.filledCount(userId);
        int harvests = repo.harvests(userId);
        List<RegionView> regions = new ArrayList<>();
        for (Region r : rules.regions()) {
            var gate = engine.gate(r, level, owned.size(), orders, harvests);
            var g = r.gate();
            List<RequirementView> reqs = List.of(
                    new RequirementView("LEVEL", level, g.level(), gate.levelOk()),
                    new RequirementView("PLOTS", owned.size(), g.plots(), gate.plotsOk()),
                    new RequirementView("ORDERS", orders, g.ordersFilled(), gate.ordersOk()),
                    new RequirementView("HARVESTS", harvests, g.harvests(), gate.harvestsOk()));
            int next = engine.nextPlot(r, owned).map(LandPlot::slot).orElse(-1);
            List<LandPlotView> plots = new ArrayList<>();
            for (LandPlot p : r.plots()) {
                long price = engine.landPrice(p, learningDays);
                String status = owned.contains(p.slot()) ? "OWNED" : p.slot() == next ? "NEXT" : "LATER";
                var preview = ctx.engine().orders().allocate(lines(p.materials()), stock).map(EstateService::supplyViews).orElse(null);
                plots.add(new LandPlotView(p.slot(), p.gx(), p.gy(), price, p.coins(), materials(p.materials(), stock), status,
                        coins >= price, preview != null, "OWNED".equals(status) ? null : preview));
            }
            int have = (int) r.plots().stream().filter(p -> owned.contains(p.slot())).count();
            regions.add(new RegionView(r.code(), r.nameVi(), r.field(), gate.open(), reqs, plots, have, r.plots().size()));
        }
        double discount = engine.learningDiscount(learningDays);
        double[] nextRow = rules.learningDiscount().stream().filter(row -> row[0] > learningDays)
                .min(Comparator.comparingDouble(row -> row[0])).orElse(null);
        return new LandView(regions, owned.size(), rules.maxPlots(), discount, learningDays,
                nextRow == null ? null : (int) nextRow[0], nextRow == null ? null : nextRow[1]);
    }

    private Set<Integer> ownedSlots(long userId) {
        return ctx.repo.plots(userId).stream().filter(p -> p.unlockedAt() != null).map(p -> p.slot()).collect(Collectors.toSet());
    }

    private int learningDays(long userId) {
        var row = monument.row(userId);
        return row == null ? 0 : row.learningDays();
    }

    // ------------------------------------------------------------------ commands

    /** "Nâng cấp": the next level of a building, bought exactly once. */
    public BuildingReceipt upgrade(long userId, UUID key, String code, BuildingUpgradeRequest request) {
        access.require(userId);
        List<Supply> materials = FarmEconomyService.canonical(request.materials());
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("code", code);
        fingerprint.put("level", request.level());
        fingerprint.put("materials", materials);
        return ctx.command(userId, key, "BUILDING_UPGRADE", fingerprint, BuildingReceipt.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            var engine = ctx.estate();
            Building building = engine.rules().building(code);
            if (building == null) throw new GardenException(404, "BUILDING_NOT_FOUND");
            int current = ctx.repo.buildingLevels(userId).getOrDefault(building.code(), 0);
            if (current >= building.maxLevel()) throw GardenException.conflict("BUILDING_MAX");
            if (request.level() != current + 1) throw GardenException.conflict("BUILDING_ORDER", Map.of("next", current + 1));
            BuildingLevel next = engine.nextLevel(building.code(), current).orElseThrow();
            int level = e.levels().level(ctx.repo.profile(userId).totalXp());
            if (level < next.minLevel()) throw GardenException.conflict("BUILDING_LEVEL", Map.of("level", next.minLevel()));
            var check = e.orders().compostMatches(next.materials(), materials);
            if (!check.ok()) throw GardenException.conflict("MATERIALS_MISMATCH", check.details());
            String ref = building.code() + ":" + next.level();
            if (!ledger.takeCoins(userId, next.coins(), "BUILDING", "BUILDING", ref, op, now)) {
                throw GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", next.coins() - ctx.repo.profile(userId).coins()));
            }
            for (Supply s : materials) {
                if (!ledger.takeItem(userId, "CROP:" + s.cropCode(), s.tier(), s.qty(), "BUILDING", "BUILDING", ref, op, now)) {
                    throw GardenException.conflict("NO_ITEM", Map.of("cropCode", s.cropCode(), "tier", s.tier()));
                }
            }
            if (!repo.raiseBuilding(userId, building.code(), current, next.coins(), op, now)) throw GardenException.conflict("BUILDING_ORDER");
            ctx.repo.log(userId, "BUILDING_UPGRADE", ctx.write(Map.of("building", building.code(), "level", next.level(),
                    "coins", next.coins(), "units", materials.stream().mapToInt(Supply::qty).sum())), now);
            return new BuildingReceipt(building.code(), next.level(), next.coins(), supplyViews(materials),
                    ctx.repo.profile(userId).coins(), view(userId, now), economy.view(userId, now, ingest.blessing(userId, now)));
        });
    }

    /** "Mở luống": the next bed of an open region, bought exactly once. */
    public LandReceipt buyLand(long userId, UUID key, LandBuyRequest request) {
        access.require(userId);
        List<Supply> materials = FarmEconomyService.canonical(request.materials());
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("slot", request.slot());
        fingerprint.put("materials", materials);
        return ctx.command(userId, key, "LAND_BUY", fingerprint, LandReceipt.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            var engine = ctx.estate();
            Region region = engine.rules().land().regionOf(request.slot()).orElseThrow(() -> new GardenException(404, "LAND_NOT_FOUND"));
            LandPlot plot = engine.rules().land().plot(request.slot()).orElseThrow();
            Set<Integer> owned = ownedSlots(userId);
            if (owned.contains(plot.slot())) throw GardenException.conflict("PLOT_ALREADY_OPEN");
            if (owned.size() >= engine.rules().land().maxPlots()) throw GardenException.conflict("LAND_FULL");
            collection.ensureSeeded(userId, now);
            int level = e.levels().level(ctx.repo.profile(userId).totalXp());
            var gate = engine.gate(region, level, owned.size(), economyRepo.filledCount(userId), repo.harvests(userId));
            if (!gate.open()) {
                String reason = !gate.levelOk() ? "LEVEL" : !gate.plotsOk() ? "PLOTS" : !gate.ordersOk() ? "ORDERS" : "HARVESTS";
                throw GardenException.conflict("LAND_REGION_LOCKED", Map.of("reason", reason, "region", region.code()));
            }
            int next = engine.nextPlot(region, owned).map(LandPlot::slot).orElse(-1);
            if (next != plot.slot()) throw GardenException.conflict("EXPANSION_ORDER", Map.of("next", next));
            var check = e.orders().compostMatches(plot.materials(), materials);
            if (!check.ok()) throw GardenException.conflict("MATERIALS_MISMATCH", check.details());
            int learningDays = learningDays(userId);
            long price = engine.landPrice(plot, learningDays);
            String ref = "slot:" + plot.slot();
            if (!ledger.takeCoins(userId, price, "LAND", "PLOT", ref, op, now)) {
                throw GardenException.conflict("INSUFFICIENT_FUNDS", Map.of("missing", price - ctx.repo.profile(userId).coins()));
            }
            for (Supply s : materials) {
                if (!ledger.takeItem(userId, "CROP:" + s.cropCode(), s.tier(), s.qty(), "LAND", "PLOT", ref, op, now)) {
                    throw GardenException.conflict("NO_ITEM", Map.of("cropCode", s.cropCode(), "tier", s.tier()));
                }
            }
            Long plotId = economyRepo.insertPlot(userId, plot.slot(), plot.gx(), plot.gy(), now);
            if (plotId == null) throw GardenException.conflict("PLOT_ALREADY_OPEN");
            ctx.repo.log(userId, "LAND_BUY", ctx.write(Map.of("slot", plot.slot(), "region", region.code(), "plotId", plotId,
                    "coins", price, "listed", plot.coins(), "units", materials.stream().mapToInt(Supply::qty).sum())), now);
            return new LandReceipt(plot.slot(), region.code(), price, engine.learningDiscount(learningDays), supplyViews(materials),
                    views.plot(userId, plotId, now), ctx.repo.profile(userId).coins(), view(userId, now));
        });
    }

    /** "Ủ phân": one batch of surplus produce becomes one fertilizer (the storehouse level caps the batches per day). */
    public CompostReceipt compost(long userId, UUID key, CompostRequest request) {
        access.require(userId);
        List<Supply> lines = FarmEconomyService.canonical(request.lines());
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("recipe", request.recipe());
        fingerprint.put("lines", lines);
        return ctx.command(userId, key, "COMPOST", fingerprint, CompostReceipt.class, setup.ensurer(userId), (now, op) -> {
            var e = ctx.engine();
            var engine = ctx.estate();
            boolean premium = "PREMIUM".equals(request.recipe());
            Recipe recipe = premium ? engine.rules().compost().premium() : engine.rules().compost().standard();
            var perks = ctx.perks(userId);
            int cap = premium ? perks.premiumCompostDaily() : perks.compostDaily();
            if (cap <= 0) throw GardenException.conflict("COMPOST_LOCKED");
            int min = e.orders().rank(recipe.minTier());
            int total = 0;
            for (Supply s : lines) {
                var crop = e.rules().crops().get(s.cropCode());
                int rank = e.orders().rank(s.tier());
                if (crop == null || crop.qaOnly() || rank < 0 || s.qty() <= 0) throw new GardenException(400, "INVALID_COMMAND");
                if (rank < min) throw GardenException.conflict("COMPOST_TIER_TOO_LOW", Map.of("minTier", recipe.minTier()));
                total += s.qty();
            }
            if (total != recipe.units()) throw GardenException.conflict("COMPOST_UNITS", Map.of("units", recipe.units()));
            LocalDate day = e.calendar().dayKey(now);
            String counter = COMPOST_PREFIX + request.recipe();
            int before = economyRepo.marketUnits(userId, day).getOrDefault(counter, 0);
            if (!economyRepo.addMarketUnits(userId, day, counter, 1, cap, now)) {
                throw GardenException.conflict("COMPOST_CAP", Map.of("remaining", Math.max(0, cap - before)));
            }
            String ref = counter + "@" + day;
            for (Supply s : lines) {
                if (!ledger.takeItem(userId, "CROP:" + s.cropCode(), s.tier(), s.qty(), "COMPOST", "COMPOST", ref, op, now)) {
                    throw GardenException.conflict("NO_ITEM", Map.of("cropCode", s.cropCode(), "tier", s.tier()));
                }
            }
            ledger.addItem(userId, recipe.gives(), "NA", 1, "COMPOST", "COMPOST", ref, op, now);
            ctx.repo.log(userId, "COMPOST", ctx.write(Map.of("recipe", request.recipe(), "units", total, "item", recipe.gives())), now);
            return new CompostReceipt(request.recipe(), recipe.gives(), ctx.repo.itemQty(userId, recipe.gives(), "NA"),
                    supplyViews(lines), before + 1, Math.max(0, cap - before - 1), view(userId, now));
        });
    }

    // ------------------------------------------------------------------ helpers

    private List<Line> lines(Map<String, Integer> materials) {
        String lowest = ctx.engine().orders().lowestTier();
        return materials.entrySet().stream().sorted(Map.Entry.comparingByKey()).map(c -> new Line(c.getKey(), c.getValue(), lowest)).toList();
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

    private int heldAny(Map<String, Map<String, Integer>> stock, String minTier) {
        return stock.keySet().stream().filter(c -> {
            var def = ctx.engine().rules().crops().get(c);
            return def != null && !def.qaOnly();
        }).mapToInt(c -> held(stock, c, minTier)).sum();
    }

    private static List<SupplyView> supplyViews(List<Supply> supply) {
        return supply.stream().sorted(Comparator.comparing(Supply::cropCode).thenComparing(Supply::tier))
                .map(s -> new SupplyView(s.cropCode(), s.tier(), s.qty())).toList();
    }
}
