package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.AnimalHouseView;
import com.englishcoach.garden.api.GardenDtos.AnimalReceipt;
import com.englishcoach.garden.api.GardenDtos.AnimalView;
import com.englishcoach.garden.api.GardenDtos.AnimalsView;
import com.englishcoach.garden.api.GardenDtos.FeedMillRequest;
import com.englishcoach.garden.api.GardenDtos.GuardianView;
import com.englishcoach.garden.api.GardenDtos.IslandAnimalView;
import com.englishcoach.garden.api.GardenDtos.IslandAnimalsView;
import com.englishcoach.garden.api.GardenDtos.ManureCompostView;
import com.englishcoach.garden.api.GardenDtos.MillOptionView;
import com.englishcoach.garden.api.GardenDtos.ProductSellRequest;
import com.englishcoach.garden.api.GardenDtos.ProductStockView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.AnimalEngine;
import com.englishcoach.garden.domain.AnimalEngine.Progress;
import com.englishcoach.garden.domain.AnimalEngine.Stage;
import com.englishcoach.garden.domain.AnimalRules;
import com.englishcoach.garden.domain.AnimalRules.Guardian;
import com.englishcoach.garden.domain.AnimalRules.House;
import com.englishcoach.garden.domain.AnimalRules.Livestock;
import com.englishcoach.garden.domain.AnimalRules.Product;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.infra.AnimalRepository;
import com.englishcoach.garden.infra.AnimalRepository.Animal;
import com.englishcoach.garden.infra.EconomyRepository;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;

/**
 * Phase 3H livestock and guardian pets.
 *
 * <ul>
 *   <li><b>Server time only.</b> Growth and production are counted lazily by {@link AnimalEngine#advance} from the
 *   stored instant to the server's {@code now}: every command first brings all of the owner's animals up to date and
 *   stores them, then acts. A read projects the same numbers without writing. There is no scheduler and no per-animal
 *   timer.</li>
 *   <li><b>One ledger.</b> Feed, trough water, products, fertilizer and Đồng Echo move only through
 *   {@link LedgerService}, in the owner's advisory-lock transaction with an idempotency receipt: a retried or
 *   concurrent command can neither charge nor grant twice.</li>
 *   <li><b>Bounded.</b> A house has a small capacity, an adult holds a small store and then rests, food never reaches
 *   further ahead than the feed horizon: an absent player accumulates a couple of days at most, and nothing ever dies.</li>
 *   <li><b>Own garden only.</b> The user id always comes from the principal and every row is looked up by
 *   {@code (user_id, …)}; a visitor only ever receives {@link #island}.</li>
 * </ul>
 */
@Service
public class AnimalService {

    static final String COMPOST_COUNTER = "COMPOST:MANURE";
    private static final String PRODUCT_PREFIX = "PRODUCT:";

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final LedgerService ledger;
    private final LearningIngestService ingest;
    private final AnimalRepository repo;
    private final EconomyRepository economyRepo;

    public AnimalService(GardenContext ctx, GardenAccessService access, GardenSetup setup, LedgerService ledger,
                         LearningIngestService ingest, AnimalRepository repo, EconomyRepository economyRepo) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.ledger = ledger;
        this.ingest = ingest;
        this.repo = repo;
        this.economyRepo = economyRepo;
    }

    public static String productItem(String code) {
        return PRODUCT_PREFIX + code;
    }

    private AnimalEngine engine() {
        AnimalEngine e = ctx.animals();
        if (e == null) throw GardenException.conflict("ANIMALS_CLOSED");
        return e;
    }

    private long price(long base) {
        return Math.round(base * ctx.engine().rules().coinScale());
    }

    // ------------------------------------------------------------------ view

    /** The animals part of {@code GET /state} (inside its transaction, read only); null without the animals rules. */
    public AnimalsView view(long userId, Instant now, boolean learnedToday) {
        AnimalEngine e = ctx.animals();
        if (e == null) return null;
        AnimalRules r = e.rules();
        var g = ctx.engine();
        GardenScope.prefetch(() -> ctx.repo.profile(userId), () -> repo.houses(userId), () -> repo.animals(userId),
                () -> ctx.repo.inventory(userId));
        var profile = ctx.repo.profile(userId);
        int level = g.levels().level(profile.totalXp());
        long coins = profile.coins();
        Map<String, AnimalRepository.House> built = new HashMap<>();
        repo.houses(userId).forEach(h -> built.put(h.code(), h));
        List<Animal> all = repo.animals(userId);
        var inventory = ctx.repo.inventory(userId);
        Map<String, Integer> stock = new HashMap<>();
        inventory.forEach(i -> stock.merge(i.code(), i.qty(), Integer::sum));

        List<AnimalHouseView> houses = new ArrayList<>();
        int livestock = 0, capacity = 0;
        for (House h : r.houses().values()) {
            Livestock def = r.livestock().get(h.species());
            Product product = r.products().get(def.product());
            var row = built.get(h.code());
            List<AnimalView> animals = new ArrayList<>();
            int feedNeeded = 0, ready = 0;
            if (row != null) {
                for (Animal a : all) {
                    if (!h.code().equals(a.houseCode())) continue;
                    Progress p = e.advance(def, progress(a), a.fedUntil(), row.wateredUntil(), now);
                    boolean canFeed = e.fedAfterRation(a.fedUntil(), def.rationHours(), learnedToday, now) != null;
                    int units = e.ready(def, p.productSeconds());
                    animals.add(new AnimalView(a.id(), a.species(), def.nameVi(), e.stage(def, p.growthSeconds()).name(), a.place(),
                            Math.min(1.0, (double) p.growthSeconds() / def.growSeconds()),
                            e.adultAt(def, p, a.fedUntil(), row.wateredUntil()),
                            AnimalEngine.careUntil(a.fedUntil(), row.wateredUntil()).isAfter(now), a.fedUntil(), canFeed, units,
                            def.storeCap(), e.nextProductAt(def, p, a.fedUntil(), row.wateredUntil())));
                    if (canFeed) feedNeeded += def.rationFeed();
                    ready += units;
                }
                animals.sort(Comparator.comparingInt(AnimalView::place));
                livestock += animals.size();
                capacity += h.capacity();
            }
            houses.add(new AnimalHouseView(h.code(), h.nameVi(), h.species(), def.nameVi(), def.babyVi(), row != null, h.minLevel(),
                    price(h.coins()), level >= h.minLevel(), coins >= price(h.coins()), h.capacity(), price(def.coins()),
                    coins >= price(def.coins()), row == null ? null : row.wateredUntil(), row != null && row.wateredUntil().isAfter(now),
                    row != null && e.troughRefillable(row.wateredUntil(), now), feedNeeded, def.rationFeed(), def.rationHours(),
                    def.growHours(), product.code(), product.nameVi(), def.productHours(), ready, animals));
        }

        List<GuardianView> guardians = new ArrayList<>();
        for (Guardian d : r.guardians().values()) {
            Animal a = all.stream().filter(x -> x.guardian() && x.species().equals(d.species())).findFirst().orElse(null);
            String status;
            Instant until = null;
            if (a == null) {
                status = level >= d.minLevel() ? "AVAILABLE" : "LOCKED";
            } else if (!AnimalEngine.onDuty(a.fedUntil(), now)) {
                status = "HUNGRY";
            } else if (AnimalRules.DOG.equals(d.species())) {
                Instant shield = e.dogShieldUntil(a.guardAt(), now);
                if (shield != null) {
                    status = "GUARDING";
                    until = shield;
                } else if (e.dogReady(a.fedUntil(), a.guardAt(), now)) {
                    status = "READY";
                } else {
                    status = "COOLDOWN";
                    until = e.dogReadyAt(a.guardAt());
                }
            } else {
                status = "ON_DUTY";
            }
            guardians.add(new GuardianView(d.species(), d.nameVi(), a != null, d.minLevel(), price(d.coins()), level >= d.minLevel(),
                    coins >= price(d.coins()), status, a == null ? null : a.fedUntil(),
                    a != null && e.fedAfterRation(a.fedUntil(), d.rationHours(), learnedToday, now) != null, d.rationFeed(),
                    d.rationHours(), until, d.cooldownHours(), d.shieldHours(), d.graceMinutes(), d.pestCapReduction()));
        }

        List<ProductStockView> products = r.products().values().stream()
                .map(p -> new ProductStockView(p.code(), p.nameVi(), stock.getOrDefault(productItem(p.code()), 0), price(p.sell()))).toList();
        var crops = g.rules().crops();
        List<MillOptionView> mill = inventory.stream()
                .filter(i -> i.code().startsWith("CROP:") && i.qty() > 0 && r.feed().mill().containsKey(i.code().substring(5)))
                .map(i -> {
                    String code = i.code().substring(5);
                    CropDef crop = crops.get(code);
                    return new MillOptionView(code, crop == null ? code : crop.nameVi(), i.tier(), i.qty(), r.feed().mill().get(code));
                })
                .sorted(Comparator.comparingInt(MillOptionView::feedPerUnit).thenComparing(MillOptionView::cropCode)
                        .thenComparing(MillOptionView::tier)).toList();
        LocalDate day = g.calendar().dayKey(now);
        var c = r.compost();
        var compost = new ManureCompostView(c.product(), c.manure(), c.gives(), c.dailyCap(),
                economyRepo.marketUnits(userId, day).getOrDefault(COMPOST_COUNTER, 0), stock.getOrDefault(productItem(c.product()), 0));
        return new AnimalsView(houses, guardians, stock.getOrDefault(r.feed().item(), 0), stock.getOrDefault(r.water().item(), 0),
                r.water().item(), r.water().hours(), r.feed().maxHours(), learnedToday, r.feed().learningBonusBp() / 100, products,
                mill, compost, livestock, capacity);
    }

    /** What a visitor sees of this garden's animals: which houses stand and which animals live there — nothing else. */
    public IslandAnimalsView island(long hostId, Instant now) {
        AnimalEngine e = ctx.animals();
        if (e == null) return null;
        Map<String, AnimalRepository.House> built = new HashMap<>();
        repo.houses(hostId).forEach(h -> built.put(h.code(), h));
        List<IslandAnimalView> out = new ArrayList<>();
        for (Animal a : repo.animals(hostId)) {
            if (a.guardian()) {
                out.add(new IslandAnimalView(a.species(), a.kind(), Stage.ADULT.name(), null, false));
                continue;
            }
            Livestock def = e.rules().livestock().get(a.species());
            var house = built.get(a.houseCode());
            if (def == null || house == null) continue;
            Progress p = e.advance(def, progress(a), a.fedUntil(), house.wateredUntil(), now);
            out.add(new IslandAnimalView(a.species(), a.kind(), e.stage(def, p.growthSeconds()).name(), a.place(),
                    e.ready(def, p.productSeconds()) > 0));
        }
        return new IslandAnimalsView(e.rules().houses().keySet().stream().filter(built::containsKey).toList(), out);
    }

    private static Progress progress(Animal a) {
        return new Progress(a.progressAt(), a.growthSeconds(), a.productSeconds());
    }

    // ------------------------------------------------------------------ commands

    /** One command: fold today's learning, bring every animal of the garden up to {@code now}, then act. */
    private AnimalReceipt command(long userId, UUID key, String op, Object fingerprint, Function<Turn, Outcome> work) {
        access.require(userId);
        engine();
        return ctx.command(userId, key, op, fingerprint, AnimalReceipt.class, setup.ensurer(userId), (now, opKey) -> {
            AnimalEngine e = engine();
            // Phase 5: what every animal command reads first, in two exchanges
            GardenScope.prefetch(2, () -> ingest.ingest(userId, ctx.repo.profile(userId), now), () -> ingest.blessing(userId, now),
                    () -> repo.houses(userId), () -> repo.animals(userId), () -> ctx.repo.inventory(userId));
            ingest.ingest(userId, ctx.repo.profile(userId), now);
            boolean learned = ingest.blessing(userId, now);
            Map<String, AnimalRepository.House> houses = new LinkedHashMap<>();
            repo.houses(userId).forEach(h -> houses.put(h.code(), h));
            List<Animal> animals = new ArrayList<>();
            for (Animal a : repo.animals(userId)) {
                Livestock def = a.guardian() ? null : e.rules().livestock().get(a.species());
                var house = a.houseCode() == null ? null : houses.get(a.houseCode());
                if (def == null || house == null) {
                    animals.add(a);
                    continue;
                }
                Progress p = e.advance(def, progress(a), a.fedUntil(), house.wateredUntil(), now);
                if (!p.equals(progress(a))) repo.saveProgress(userId, a.id(), p.progressAt(), p.growthSeconds(), p.productSeconds());
                animals.add(new Animal(a.id(), a.species(), a.kind(), a.houseCode(), a.place(), a.acquiredAt(), p.progressAt(),
                        p.growthSeconds(), p.productSeconds(), a.fedUntil(), a.guardAt()));
            }
            long before = ctx.repo.profile(userId).coins();
            Outcome out = work.apply(new Turn(userId, e, now, opKey, learned, houses, animals));
            long after = ctx.repo.profile(userId).coins();
            ctx.repo.log(userId, op, ctx.write(out.log()), now);
            return new AnimalReceipt(op, after - before, after, out.gained(), view(userId, now, learned));
        });
    }

    private record Turn(long userId, AnimalEngine e, Instant now, UUID op, boolean learned,
                        Map<String, AnimalRepository.House> houses, List<Animal> animals) {

        List<Animal> in(String house) {
            return animals.stream().filter(a -> house.equals(a.houseCode())).toList();
        }
    }

    private record Outcome(Map<String, Integer> gained, Map<String, Object> log) {

        static Outcome of(Map<String, Object> log) {
            return new Outcome(Map.of(), log);
        }
    }

    private static House house(AnimalRules r, String code) {
        House h = r.houses().get(code);
        if (h == null) throw new GardenException(404, "HOUSE_NOT_FOUND");
        return h;
    }

    private static AnimalRepository.House built(Turn t, String code) {
        var row = t.houses().get(code);
        if (row == null) throw GardenException.conflict("HOUSE_NOT_BUILT");
        return row;
    }

    private int level(long userId) {
        return ctx.engine().levels().level(ctx.repo.profile(userId).totalXp());
    }

    private void pay(Turn t, long coins, String reason, String refType, String refId) {
        if (!ledger.takeCoins(t.userId(), coins, reason, refType, refId, t.op(), t.now())) {
            throw GardenException.conflict("INSUFFICIENT_FUNDS",
                    Map.of("missing", Math.max(0, coins - ctx.repo.profile(t.userId()).coins())));
        }
    }

    public AnimalReceipt buildHouse(long userId, UUID key, String code) {
        return command(userId, key, "ANIMAL_HOUSE", Map.of("house", code), t -> {
            House h = house(t.e().rules(), code);
            if (t.houses().containsKey(code)) throw GardenException.conflict("HOUSE_BUILT");
            if (level(userId) < h.minLevel()) throw GardenException.conflict("HOUSE_LEVEL", Map.of("minLevel", h.minLevel()));
            pay(t, price(h.coins()), "ANIMAL_HOUSE", "ANIMAL_HOUSE", code);
            if (!repo.buildHouse(userId, code, t.now())) throw GardenException.conflict("HOUSE_BUILT");
            return Outcome.of(Map.of("house", code, "coins", price(h.coins())));
        });
    }

    /** Livestock: a young animal into its species' house. A guardian: adopted once per garden. */
    public AnimalReceipt buy(long userId, UUID key, String species) {
        return command(userId, key, "ANIMAL_BUY", Map.of("species", species), t -> {
            AnimalRules r = t.e().rules();
            Livestock def = r.livestock().get(species);
            if (def != null) {
                House h = r.houseOf(species);
                built(t, h.code());
                List<Animal> there = t.in(h.code());
                if (there.size() >= h.capacity()) throw GardenException.conflict("HOUSE_FULL", Map.of("capacity", h.capacity()));
                int place = 1;
                while (hasPlace(there, place)) place++;
                pay(t, price(def.coins()), "ANIMAL_BUY", "ANIMAL", species);
                Long id = repo.insertLivestock(userId, species, h.code(), place, t.now(), t.op());
                if (id == null) throw GardenException.conflict("HOUSE_FULL", Map.of("capacity", h.capacity()));
                return Outcome.of(Map.of("species", species, "animalId", id, "coins", price(def.coins())));
            }
            Guardian guardian = r.guardians().get(species);
            if (guardian == null) throw new GardenException(404, "ANIMAL_NOT_FOUND");
            if (t.animals().stream().anyMatch(a -> a.guardian() && a.species().equals(species))) throw GardenException.conflict("GUARDIAN_OWNED");
            if (level(userId) < guardian.minLevel()) throw GardenException.conflict("ANIMAL_LEVEL", Map.of("minLevel", guardian.minLevel()));
            pay(t, price(guardian.coins()), "ANIMAL_BUY", "ANIMAL", species);
            Long id = repo.insertGuardian(userId, species, t.now(), t.op());
            if (id == null) throw GardenException.conflict("GUARDIAN_OWNED");
            return Outcome.of(Map.of("species", species, "animalId", id, "coins", price(guardian.coins())));
        });
    }

    private static boolean hasPlace(List<Animal> animals, int place) {
        return animals.stream().anyMatch(a -> a.place() != null && a.place() == place);
    }

    private void takeFeed(Turn t, int feed, String refType, String refId) {
        String item = t.e().rules().feed().item();
        if (!ledger.takeItem(t.userId(), item, "NA", feed, "ANIMAL_FEED", refType, refId, t.op(), t.now())) {
            throw GardenException.conflict("NO_FEED", Map.of("needed", feed, "held", ctx.repo.itemQty(t.userId(), item, "NA")));
        }
    }

    /** One ration for every animal of the house that can eat now (all of them or nothing). */
    public AnimalReceipt feedHouse(long userId, UUID key, String code) {
        return command(userId, key, "ANIMAL_FEED", Map.of("house", code), t -> {
            House h = house(t.e().rules(), code);
            built(t, code);
            Livestock def = t.e().rules().livestock().get(h.species());
            List<Animal> there = t.in(code);
            if (there.isEmpty()) throw GardenException.conflict("NO_ANIMALS");
            Map<Long, Instant> fed = new LinkedHashMap<>();
            for (Animal a : there) {
                Instant after = t.e().fedAfterRation(a.fedUntil(), def.rationHours(), t.learned(), t.now());
                if (after != null) fed.put(a.id(), after);
            }
            if (fed.isEmpty()) throw GardenException.conflict("ANIMALS_FULL");
            takeFeed(t, fed.size() * def.rationFeed(), "ANIMAL_HOUSE", code);
            fed.forEach((id, until) -> repo.setFed(userId, id, until));
            return Outcome.of(Map.of("house", code, "animals", fed.size(), "feed", fed.size() * def.rationFeed(), "learned", t.learned()));
        });
    }

    public AnimalReceipt feedGuardian(long userId, UUID key, String species) {
        return command(userId, key, "GUARDIAN_FEED", Map.of("species", species), t -> {
            Guardian d = t.e().rules().guardians().get(species);
            Animal a = d == null ? null : t.animals().stream().filter(x -> x.guardian() && x.species().equals(species)).findFirst().orElse(null);
            if (a == null) throw new GardenException(404, "ANIMAL_NOT_FOUND");
            Instant after = t.e().fedAfterRation(a.fedUntil(), d.rationHours(), t.learned(), t.now());
            if (after == null) throw GardenException.conflict("ANIMALS_FULL");
            takeFeed(t, d.rationFeed(), "ANIMAL", species);
            repo.setFed(userId, a.id(), after);
            return Outcome.of(Map.of("species", species, "feed", d.rationFeed(), "learned", t.learned()));
        });
    }

    /** Refill a house's shared trough with one unit of the trough-water item. */
    public AnimalReceipt water(long userId, UUID key, String code) {
        return command(userId, key, "ANIMAL_WATER", Map.of("house", code), t -> {
            house(t.e().rules(), code);
            var row = built(t, code);
            if (!t.e().troughRefillable(row.wateredUntil(), t.now())) {
                throw GardenException.conflict("TROUGH_FULL", Map.of("wateredUntil", row.wateredUntil().toString()));
            }
            String item = t.e().rules().water().item();
            if (!ledger.takeItem(userId, item, "NA", 1, "ANIMAL_WATER", "ANIMAL_HOUSE", code, t.op(), t.now())) {
                throw GardenException.conflict("NO_WATER", Map.of("itemCode", item));
            }
            repo.setWatered(userId, code, t.e().wateredAfterRefill(t.now()));
            return Outcome.of(Map.of("house", code, "item", item));
        });
    }

    /** Collect every product waiting in a house; what an animal already produced toward its next one is kept. */
    public AnimalReceipt collect(long userId, UUID key, String code) {
        return command(userId, key, "ANIMAL_COLLECT", Map.of("house", code), t -> {
            House h = house(t.e().rules(), code);
            built(t, code);
            Livestock def = t.e().rules().livestock().get(h.species());
            int total = 0;
            for (Animal a : t.in(code)) {
                int units = t.e().ready(def, a.productSeconds());
                if (units <= 0) continue;
                repo.saveProgress(userId, a.id(), a.progressAt(), a.growthSeconds(), t.e().afterCollect(def, a.productSeconds(), units));
                total += units;
            }
            if (total == 0) throw GardenException.conflict("NOTHING_READY");
            ledger.addItem(userId, productItem(def.product()), "NA", total, "ANIMAL_COLLECT", "ANIMAL_HOUSE", code, t.op(), t.now());
            return new Outcome(Map.of(def.product(), total), Map.of("house", code, "product", def.product(), "units", total));
        });
    }

    /** Mill produce into feed: the storehouse gives up the produce, the feed bin gains the configured units. */
    public AnimalReceipt mill(long userId, UUID key, FeedMillRequest request) {
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("crop", request.cropCode());
        fingerprint.put("tier", request.tier());
        fingerprint.put("qty", request.qty());
        return command(userId, key, "FEED_MILL", fingerprint, t -> {
            Integer per = t.e().rules().feed().mill().get(request.cropCode());
            if (per == null || ctx.engine().rules().crops().get(request.cropCode()) == null) throw GardenException.conflict("NOT_MILLABLE");
            if (!ledger.takeItem(userId, "CROP:" + request.cropCode(), request.tier(), request.qty(), "FEED_MILL", "FEED",
                    request.cropCode(), t.op(), t.now())) {
                throw GardenException.conflict("NO_ITEM", Map.of("cropCode", request.cropCode(), "tier", request.tier()));
            }
            int feed = per * request.qty();
            String item = t.e().rules().feed().item();
            ledger.addItem(userId, item, "NA", feed, "FEED_MILL", "FEED", request.cropCode(), t.op(), t.now());
            return new Outcome(Map.of(item, feed), Map.of("crop", request.cropCode(), "qty", request.qty(), "feed", feed));
        });
    }

    /** Sell animal products at their fixed server price (conditional decrement: a double submit cannot sell twice). */
    public AnimalReceipt sell(long userId, UUID key, ProductSellRequest request) {
        Map<String, Object> fingerprint = new LinkedHashMap<>();
        fingerprint.put("code", request.code());
        fingerprint.put("qty", request.qty());
        return command(userId, key, "PRODUCT_SELL", fingerprint, t -> {
            Product p = t.e().rules().products().get(request.code());
            if (p == null) throw new GardenException(404, "PRODUCT_NOT_FOUND");
            long unit = price(p.sell());
            if (unit <= 0) throw GardenException.conflict("NOT_SELLABLE");
            if (!ledger.takeItem(userId, productItem(p.code()), "NA", request.qty(), "PRODUCT_SELL", "SALE", t.op().toString(), t.op(), t.now())) {
                throw GardenException.conflict("NO_ITEM", Map.of("code", p.code()));
            }
            ledger.addCoins(userId, unit * request.qty(), "PRODUCT_SELL", "SALE", t.op().toString(), t.op(), t.now());
            return Outcome.of(Map.of("product", p.code(), "qty", request.qty(), "coins", unit * request.qty()));
        });
    }

    /** Manure becomes fertilizer, at most the configured batches per Vietnam day (the market's own per-day counter). */
    public AnimalReceipt compost(long userId, UUID key, int batches) {
        return command(userId, key, "MANURE_COMPOST", Map.of("batches", batches), t -> {
            var c = t.e().rules().compost();
            LocalDate day = ctx.engine().calendar().dayKey(t.now());
            if (!economyRepo.addMarketUnits(userId, day, COMPOST_COUNTER, batches, c.dailyCap(), t.now())) {
                throw GardenException.conflict("COMPOST_CAP", Map.of("dailyCap", c.dailyCap()));
            }
            if (!ledger.takeItem(userId, productItem(c.product()), "NA", batches * c.manure(), "MANURE_COMPOST", "COMPOST",
                    t.op().toString(), t.op(), t.now())) {
                throw GardenException.conflict("NO_ITEM", Map.of("code", c.product(), "needed", batches * c.manure()));
            }
            ledger.addItem(userId, c.gives(), "NA", batches, "MANURE_COMPOST", "COMPOST", t.op().toString(), t.op(), t.now());
            return new Outcome(Map.of(c.gives(), batches), Map.of("batches", batches, "manure", batches * c.manure()));
        });
    }
}
