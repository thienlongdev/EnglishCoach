package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos.AnimalHouseView;
import com.englishcoach.garden.api.GardenDtos.AnimalReceipt;
import com.englishcoach.garden.api.GardenDtos.AnimalView;
import com.englishcoach.garden.api.GardenDtos.FeedMillRequest;
import com.englishcoach.garden.api.GardenDtos.GuardianView;
import com.englishcoach.garden.api.GardenDtos.HarvestCompleteRequest;
import com.englishcoach.garden.api.GardenDtos.HarvestResult;
import com.englishcoach.garden.api.GardenDtos.HarvestStartRequest;
import com.englishcoach.garden.api.GardenDtos.PlantRequest;
import com.englishcoach.garden.api.GardenDtos.PlantingView;
import com.englishcoach.garden.api.GardenDtos.ProductSellRequest;
import com.englishcoach.garden.api.GardenDtos.ShareSellLine;
import com.englishcoach.garden.api.GardenDtos.ShareSellRequest;
import com.englishcoach.garden.api.GardenDtos.TakeReceipt;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.GardenAccessService;
import com.englishcoach.garden.application.LedgerService;
import com.englishcoach.garden.config.GardenProperties;
import com.englishcoach.garden.domain.AnimalEngine;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3H on real PostgreSQL 17 + the real migrations through V89: animal houses, the four livestock species (growth
 * by server time and care, bounded production, collection once), feed and trough water through the ledger, product
 * sale and manure compost, the three guardian pets at their authoritative boundaries (take, head start, pest planning),
 * the proportional sale of harvest portions, the island-visibility choice, the open garden audience, account isolation,
 * idempotent retries and races, and a garden from before V89 that keeps everything. Each test uses its own user ids.
 */
class GardenPhase3HPersistenceTest {

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static LedgerService ledger;
    static final AtomicLong USERS = new AtomicLong(120_000);
    static final AtomicLong WORDS = new AtomicLong();
    static final Instant START = Instant.parse("2026-10-09T03:00:00Z"); // 10:00 Vietnam

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(START, "89");
        jdbc = env.jdbc;
        ledger = new LedgerService(env.ctx);
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    // ------------------------------------------------------------------ helpers

    static UUID key() {
        return UUID.randomUUID();
    }

    static String code(Runnable r) {
        return assertThrows(GardenException.class, r::run).code;
    }

    /** A real account with a garden at {@code level}, past the tutorial, holding {@code coins} more Đồng Echo. */
    static long farmer(GardenTestEnv e, String name, int level, long coins) {
        long id = USERS.incrementAndGet();
        e.jdbc.update("INSERT INTO public.users(id, name, email) VALUES (?, ?, ?)", id, name, "private-" + id + "@example.com");
        e.props.getAllowlistUserIds().add(id);
        e.state.state(id);
        e.jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", id);
        LedgerService l = new LedgerService(e.ctx);
        long xp = e.ctx.engine().levels().totalXpForLevel(level);
        if (xp > 0) l.addXp(id, xp, "TEST_FIXTURE", "TEST", "fixture", null, e.clock.now);
        if (coins > 0) l.addCoins(id, coins, "TEST_FIXTURE", "TEST", "fixture", null, e.clock.now);
        return id;
    }

    static long farmer(String name, int level, long coins) {
        return farmer(env, name, level, coins);
    }

    /** A farmer whose island has been open on the social islands for a month (past the introductory protection). */
    static long islander(String name, int level, long coins) {
        long id = farmer(name, level, coins);
        Timestamp joined = Timestamp.from(env.clock.now.minus(Duration.ofDays(30)));
        jdbc.update("""
                UPDATE public.garden_social_profile SET created_at = ?, visibility_changed_at = ?, visibility = 'PUBLIC',
                    visibility_chosen_at = ? WHERE user_id = ?""", joined, joined, joined, id);
        return id;
    }

    static void give(long user, String item, String tier, int qty) {
        ledger.addItem(user, item, tier, qty, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
    }

    /** Wheat to mill, milled, plus well water: enough care supplies for a test. */
    static void supplies(long user, int feed, int water) {
        give(user, "CROP:WHEAT", "NORMAL", feed);
        env.animals.mill(user, key(), new FeedMillRequest("WHEAT", "NORMAL", feed));
        give(user, "WELL_WATER", "NA", water);
    }

    static int qty(long user, String item) {
        return jdbc.queryForObject("SELECT COALESCE(sum(qty), 0) FROM public.garden_inventory WHERE user_id = ? AND item_code = ?",
                Integer.class, user, item);
    }

    static long coins(long user) {
        return jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static AnimalHouseView house(long user, String code) {
        return env.state.state(user).animals().houses().stream().filter(h -> h.code().equals(code)).findFirst().orElseThrow();
    }

    static GuardianView guardian(long user, String species) {
        return env.state.state(user).animals().guardians().stream().filter(g -> g.species().equals(species)).findFirst().orElseThrow();
    }

    static String handle(long user) {
        return jdbc.queryForObject("SELECT handle FROM public.garden_social_profile WHERE user_id = ?", String.class, user);
    }

    static long plotId(long user, int slot) {
        return env.state.state(user).plots().stream().filter(p -> p.slot() == slot).findFirst().orElseThrow().id();
    }

    static PlantingView planting(long user, int slot) {
        return env.state.state(user).plots().stream().filter(p -> p.slot() == slot).findFirst().orElseThrow().planting();
    }

    static long plant(long user, int slot, String crop) {
        return env.planting.plant(user, key(), plotId(user, slot), new PlantRequest(crop)).plot().planting().id();
    }

    /** Ripens every crop on the given beds; the clock stops within {@code step} after the last one ripened. */
    static void ripen(long user, Duration step, int... slots) {
        for (int i = 0; i < 2000; i++) {
            boolean all = true;
            for (int slot : slots) all &= planting(user, slot).ready();
            if (all) return;
            env.clock.advance(step);
        }
        fail("crops did not ripen");
    }

    static HarvestResult harvest(long user, long plantingId) {
        var ch = env.harvest.start(user, key(), new HarvestStartRequest(List.of(plantingId)));
        return env.harvest.complete(user, key(), new HarvestCompleteRequest(ch.challengeId(), List.of(0, 0, 0), false));
    }

    static TakeReceipt take(long taker, long owner, long plantingId) {
        return env.social.take(taker, key(), handle(owner), plantingId);
    }

    static int takes(long owner) {
        return jdbc.queryForObject("SELECT count(*) FROM public.garden_theft WHERE victim_id = ?", Integer.class, owner);
    }

    static void assertLedgerReconciles(long user) {
        assertEquals(coins(user), jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND asset = 'COIN'",
                Long.class, user), "coins reconcile");
        Integer orphan = jdbc.queryForObject("""
                SELECT count(*) FROM (SELECT asset, tier, sum(delta) s FROM public.garden_ledger WHERE user_id = ? AND asset NOT IN ('COIN','XP','ESSENCE')
                GROUP BY asset, tier) l LEFT JOIN public.garden_inventory i ON i.user_id = ? AND i.item_code = l.asset AND i.tier = l.tier
                WHERE COALESCE(i.qty, 0) <> l.s""", Integer.class, user, user);
        assertEquals(0, orphan, "inventory reconciles with the ledger");
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_inventory WHERE user_id = ? AND qty < 0", Integer.class, user));
    }

    static <T> List<Object> race(List<Callable<T>> calls) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(calls.size());
        CountDownLatch go = new CountDownLatch(1);
        List<Future<T>> futures = new ArrayList<>();
        for (Callable<T> call : calls) futures.add(pool.submit(() -> {
            go.await();
            return call.call();
        }));
        go.countDown();
        List<Object> out = new ArrayList<>();
        for (var f : futures) {
            try {
                out.add(f.get());
            } catch (java.util.concurrent.ExecutionException ex) {
                out.add(ex.getCause());
            }
        }
        pool.shutdown();
        return out;
    }

    static long failures(List<Object> results, String code) {
        return results.stream().filter(r -> r instanceof GardenException g && g.code.equals(code)).count();
    }

    /** A coop with three chickens, fed and watered at the returned instant. */
    static Instant coopWithThreeChicks(long user) {
        env.animals.buildHouse(user, key(), "COOP");
        for (int i = 0; i < 3; i++) env.animals.buy(user, key(), "CHICKEN");
        supplies(user, 60, 6);
        env.animals.water(user, key(), "COOP");
        env.animals.feedHouse(user, key(), "COOP");
        return env.clock.now;
    }

    /** Three adult chickens with a full store of eggs (nine), their food used up. */
    static void coopWithNineEggs(long user) {
        coopWithThreeChicks(user);
        env.clock.advance(Duration.ofHours(24));
        env.animals.feedHouse(user, key(), "COOP");
        env.clock.advance(Duration.ofHours(24));
        assertEquals(9, house(user, "COOP").ready());
    }

    // ------------------------------------------------------------------ rules and schema

    @Test
    void v89SeedsTheDocumentedRulesAndTheDatabaseRefusesWhatTheServiceNeverDoes() {
        var r = env.ctx.animals().rules();
        assertEquals(List.of("COOP", "DUCK_POND", "PIG_PEN", "SHEEP_BARN"), List.copyOf(r.houses().keySet()));
        assertEquals(List.of("CHICKEN", "DUCK", "PIG", "SHEEP"), List.copyOf(r.livestock().keySet()));
        assertEquals(List.of("CAT", "GOOSE", "DOG"), List.copyOf(r.guardians().keySet()));
        assertTrue(r.houses().values().stream().allMatch(h -> h.capacity() == 3));
        var chicken = r.livestock().get("CHICKEN");
        assertEquals(List.of(1200L, 24L, 2L, 24L, 8L, 3L), List.of(chicken.coins(), (long) chicken.growHours(), (long) chicken.rationFeed(),
                (long) chicken.rationHours(), (long) chicken.productHours(), (long) chicken.storeCap()));
        assertEquals("WOOL", r.livestock().get("SHEEP").product());
        assertEquals("MANURE", r.livestock().get("PIG").product());
        assertEquals(48, r.feed().maxHours());
        assertEquals(5000, r.restGrowthBp());
        assertEquals(List.of(24, 3), List.of(r.guardians().get("DOG").cooldownHours(), r.guardians().get("DOG").shieldHours()));
        assertEquals(40, r.guardians().get("GOOSE").graceMinutes());
        assertEquals(1, r.guardians().get("CAT").pestCapReduction());
        assertEquals("PRIVATE", env.ctx.socialDefaultVisibility());

        // a bounded, positive economy: each animal pays for its feed, a full farm adds a modest daily income
        long wheat = env.ctx.engine().rules().crop("WHEAT").sellPrice();
        double farm = 0;
        for (var l : r.livestock().values()) {
            double gross = 24.0 / l.productHours() * r.products().get(l.product()).sell();
            double feed = 24.0 / l.rationHours() * l.rationFeed() * wheat;
            assertTrue(gross > feed, l.species() + " pays for its feed");
            assertTrue(l.coins() / (gross - feed) >= 10, l.species() + " is an investment of days, not minutes");
            farm += (gross - feed) * r.houseOf(l.species()).capacity();
        }
        assertTrue(farm > 500 && farm < 1100, "a full farm adds a bounded daily income: " + farm);

        long u = farmer("Chủ Trại Schema", 8, 100_000);
        env.animals.buildHouse(u, key(), "COOP");
        env.animals.buy(u, key(), "CHICKEN");
        env.animals.buy(u, key(), "DOG");
        String live = "INSERT INTO public.garden_animal(user_id, species, kind, house_code, place, acquired_at, progress_at, fed_until, op_key) VALUES (?, 'CHICKEN', 'LIVESTOCK', ?, ?, now(), now(), now(), ?)";
        assertThrows(DataAccessException.class, () -> jdbc.update(live, u, "COOP", 1, key()), "one animal per place");
        assertThrows(DataAccessException.class, () -> jdbc.update(live, u, "COOP", 5, key()), "never more than four places");
        assertThrows(DataAccessException.class, () -> jdbc.update(live, u, "DUCK_POND", 1, key()), "only in a house this garden built");
        assertThrows(DataAccessException.class, () -> jdbc.update(live, u, null, null, key()), "livestock needs a house");
        assertThrows(DataAccessException.class, () -> jdbc.update(
                "INSERT INTO public.garden_animal(user_id, species, kind, acquired_at, progress_at, fed_until, op_key) VALUES (?, 'DOG', 'GUARDIAN', now(), now(), now(), ?)",
                u, key()), "one guardian of a species");
        assertThrows(DataAccessException.class, () -> jdbc.update("DELETE FROM public.garden_animal WHERE user_id = ?", u), "an animal is never deleted");
        assertThrows(DataAccessException.class, () -> jdbc.update("UPDATE public.garden_animal SET product_seconds = -1 WHERE user_id = ?", u));
    }

    // ------------------------------------------------------------------ houses

    @Test
    void aHouseIsBuiltOnceForItsLevelAndPrice() throws Exception {
        long low = farmer("Nông Dân Cấp Ba", 3, 50_000);
        assertEquals("HOUSE_LEVEL", code(() -> env.animals.buildHouse(low, key(), "COOP")));
        long poor = farmer("Nông Dân Nghèo", 4, 0);
        long had = coins(poor);
        assertEquals("INSUFFICIENT_FUNDS", code(() -> env.animals.buildHouse(poor, key(), "COOP")));
        assertEquals(had, coins(poor));
        assertEquals("HOUSE_NOT_FOUND", code(() -> env.animals.buildHouse(poor, key(), "DRAGON_LAIR")));

        long u = farmer("Chủ Chuồng Gà", 6, 40_000);
        long before = coins(u);
        assertFalse(house(u, "COOP").built());
        assertTrue(house(u, "COOP").levelOk() && house(u, "COOP").coinsOk());
        UUID k = key();
        AnimalReceipt r = env.animals.buildHouse(u, k, "COOP");
        assertEquals(-6000, r.coinsDelta());
        assertEquals(before - 6000, coins(u));
        assertEquals(r.coins(), env.animals.buildHouse(u, k, "COOP").coins(), "a retry returns the same receipt");
        assertEquals(before - 6000, coins(u), "and charges nothing");
        assertEquals("HOUSE_BUILT", code(() -> env.animals.buildHouse(u, key(), "COOP")));
        assertTrue(house(u, "COOP").built());
        assertFalse(house(u, "COOP").watered(), "a new trough is empty");
        assertEquals("HOUSE_NOT_BUILT", code(() -> env.animals.buy(u, key(), "SHEEP")));

        // two tabs build the same house at once: one house, one payment
        var results = race(List.<Callable<AnimalReceipt>>of(() -> env.animals.buildHouse(u, key(), "DUCK_POND"),
                () -> env.animals.buildHouse(u, key(), "DUCK_POND")));
        assertEquals(1, failures(results, "HOUSE_BUILT"));
        assertEquals(before - 6000 - 10_000, coins(u));
        assertLedgerReconciles(u);
    }

    // ------------------------------------------------------------------ livestock

    @Test
    void chicksGrowByServerTimeAndCareLayIntoASmallStoreAndAreCollectedOnce() {
        long u = farmer("Người Nuôi Gà", 4, 30_000);
        env.animals.buildHouse(u, key(), "COOP");
        long before = coins(u);
        for (int i = 0; i < 3; i++) assertEquals(-1200, env.animals.buy(u, key(), "CHICKEN").coinsDelta());
        assertEquals(before - 3600, coins(u));
        assertEquals("HOUSE_FULL", code(() -> env.animals.buy(u, key(), "CHICKEN")));
        assertEquals(before - 3600, coins(u), "a full house takes no money");
        assertEquals(List.of(1, 2, 3), house(u, "COOP").animals().stream().map(AnimalView::place).toList());
        assertTrue(house(u, "COOP").animals().stream().allMatch(a -> a.stage().equals("BABY") && !a.cared() && a.ready() == 0));

        supplies(u, 60, 6);
        env.animals.water(u, key(), "COOP");
        AnimalReceipt fed = env.animals.feedHouse(u, key(), "COOP");
        assertEquals(60 - 6, fed.animals().feed(), "three rations of two");
        Instant t0 = env.clock.now;
        assertEquals(t0.plus(Duration.ofHours(24)), house(u, "COOP").animals().getFirst().adultAt());
        env.clock.advance(Duration.ofHours(12));
        assertTrue(house(u, "COOP").animals().stream().allMatch(a -> a.stage().equals("YOUNG") && a.cared()));
        env.clock.advance(Duration.ofHours(12));
        assertTrue(house(u, "COOP").animals().stream().allMatch(a -> a.stage().equals("ADULT") && a.ready() == 0));
        assertEquals("NOTHING_READY", code(() -> env.animals.collect(u, key(), "COOP")));

        env.animals.feedHouse(u, key(), "COOP");
        env.clock.advance(Duration.ofHours(8));
        assertEquals(3, house(u, "COOP").ready(), "one egg each after eight cared-for hours");
        env.clock.advance(Duration.ofHours(16));
        assertEquals(9, house(u, "COOP").ready());

        // a month away: the store stays at its cap, nobody dies, nothing is lost
        env.clock.advance(Duration.ofDays(30));
        var away = house(u, "COOP");
        assertEquals(9, away.ready(), "an absent player never accumulates beyond the small store");
        assertEquals(3, away.animals().size());
        assertTrue(away.animals().stream().allMatch(a -> a.stage().equals("ADULT") && !a.cared() && a.nextProductAt() == null));
        assertEquals(3, jdbc.queryForObject("SELECT count(*) FROM public.garden_animal WHERE user_id = ?", Integer.class, u));

        UUID k = key();
        AnimalReceipt collected = env.animals.collect(u, k, "COOP");
        assertEquals(9, collected.gained().get("EGG"));
        assertEquals(9, qty(u, "PRODUCT:EGG"));
        assertEquals(9, env.animals.collect(u, k, "COOP").gained().get("EGG"), "a retry returns the same receipt");
        assertEquals(9, qty(u, "PRODUCT:EGG"), "and grants nothing more");
        assertEquals("NOTHING_READY", code(() -> env.animals.collect(u, key(), "COOP")));

        // ordinary care brings them back
        env.animals.water(u, key(), "COOP");
        env.animals.feedHouse(u, key(), "COOP");
        assertTrue(house(u, "COOP").animals().stream().allMatch(AnimalView::cared));
        env.clock.advance(Duration.ofHours(8));
        assertEquals(3, house(u, "COOP").ready());
        assertLedgerReconciles(u);

        // without any care a chick still grows up (slowly) but lays nothing
        long idle = farmer("Người Bận Rộn", 4, 30_000);
        env.animals.buildHouse(idle, key(), "COOP");
        env.animals.buy(idle, key(), "CHICKEN");
        env.clock.advance(Duration.ofHours(24));
        assertEquals("YOUNG", house(idle, "COOP").animals().getFirst().stage());
        env.clock.advance(Duration.ofHours(24));
        assertEquals("ADULT", house(idle, "COOP").animals().getFirst().stage());
        env.clock.advance(Duration.ofDays(5));
        assertEquals(0, house(idle, "COOP").ready());
    }

    @Test
    void feedAndTroughWaterComeFromTheStorehouseAndAreBounded() {
        long u = farmer("Người Xay Cám", 4, 30_000);
        env.animals.buildHouse(u, key(), "COOP");
        env.animals.buy(u, key(), "CHICKEN");
        assertEquals("NO_FEED", code(() -> env.animals.feedHouse(u, key(), "COOP")));
        assertEquals("NO_WATER", code(() -> env.animals.water(u, key(), "COOP")));

        give(u, "CROP:WHEAT", "NORMAL", 5);
        give(u, "CROP:CORN", "GOOD", 1);
        give(u, "CROP:ROSE", "NORMAL", 1);
        assertEquals("NOT_MILLABLE", code(() -> env.animals.mill(u, key(), new FeedMillRequest("ROSE", "NORMAL", 1))));
        assertEquals("NO_ITEM", code(() -> env.animals.mill(u, key(), new FeedMillRequest("WHEAT", "NORMAL", 6))));
        assertEquals("NO_ITEM", code(() -> env.animals.mill(u, key(), new FeedMillRequest("WHEAT", "GOLDEN", 1))));
        UUID k = key();
        assertEquals(5, env.animals.mill(u, k, new FeedMillRequest("WHEAT", "NORMAL", 5)).gained().get("FEED"));
        env.animals.mill(u, k, new FeedMillRequest("WHEAT", "NORMAL", 5));
        assertEquals(5, qty(u, "FEED"), "a retried milling makes feed once");
        assertEquals(0, qty(u, "CROP:WHEAT"));
        assertEquals(List.of("CORN"), env.state.state(u).animals().mill().stream().map(m -> m.cropCode()).toList(),
                "only what can be milled is offered");
        assertEquals(4, env.animals.mill(u, key(), new FeedMillRequest("CORN", "GOOD", 1)).gained().get("FEED"));

        give(u, "WELL_WATER", "NA", 2);
        env.animals.water(u, key(), "COOP");
        Instant t0 = env.clock.now;
        assertEquals(t0.plus(Duration.ofHours(48)), house(u, "COOP").wateredUntil());
        assertEquals("TROUGH_FULL", code(() -> env.animals.water(u, key(), "COOP")));
        assertEquals(1, qty(u, "WELL_WATER"), "a full trough takes no water");

        env.animals.feedHouse(u, key(), "COOP");
        assertEquals(t0.plus(Duration.ofHours(24)), house(u, "COOP").animals().getFirst().fedUntil());
        env.animals.feedHouse(u, key(), "COOP");
        assertEquals(t0.plus(Duration.ofHours(48)), house(u, "COOP").animals().getFirst().fedUntil(), "food reaches two days ahead at most");
        assertEquals("ANIMALS_FULL", code(() -> env.animals.feedHouse(u, key(), "COOP")));
        assertEquals(9 - 4, qty(u, "FEED"), "a refused feeding costs nothing");
        env.clock.advance(Duration.ofHours(25));
        env.animals.water(u, key(), "COOP");
        assertEquals(0, qty(u, "WELL_WATER"));

        // a day whose learning goal is met stretches a ration by a quarter
        long learner = farmer("Người Học Chăm", 4, 30_000);
        env.animals.buildHouse(learner, key(), "COOP");
        env.animals.buy(learner, key(), "CHICKEN");
        supplies(learner, 10, 1);
        env.ctx.repo.markGoal(learner, env.ctx.engine().calendar().dayKey(env.clock.now), env.clock.now);
        assertTrue(env.state.state(learner).animals().learnedToday());
        env.animals.feedHouse(learner, key(), "COOP");
        assertEquals(env.clock.now.plus(Duration.ofHours(30)), house(learner, "COOP").animals().getFirst().fedUntil());
        assertEquals("ANIMALS_FULL", code(() -> env.animals.feedHouse(learner, key(), "COOP")));
        assertLedgerReconciles(u);
        assertLedgerReconciles(learner);
    }

    @Test
    void everySpeciesGivesItsOwnProductWhichIsSoldOrComposted() {
        long u = farmer("Chủ Trang Trại Lớn", 10, 200_000);
        for (String h : List.of("COOP", "DUCK_POND", "PIG_PEN", "SHEEP_BARN")) env.animals.buildHouse(u, key(), h);
        for (String s : List.of("CHICKEN", "DUCK", "PIG", "PIG", "SHEEP")) env.animals.buy(u, key(), s);
        supplies(u, 400, 25);
        // five days of ordinary care: refill a trough when it runs low, feed whoever can eat
        for (int day = 0; day < 5; day++) {
            for (var h : env.state.state(u).animals().houses()) {
                if (h.canRefill()) env.animals.water(u, key(), h.code());
                if (h.feedNeeded() > 0) env.animals.feedHouse(u, key(), h.code());
            }
            env.clock.advance(Duration.ofHours(24));
        }
        var houses = env.state.state(u).animals().houses();
        assertTrue(houses.stream().allMatch(h -> h.animals().stream().allMatch(a -> a.stage().equals("ADULT"))), "all grown up");
        assertTrue(houses.stream().allMatch(h -> h.ready() > 0), "every species produced");
        assertEquals(List.of("EGG", "DUCK_EGG", "MANURE", "WOOL"), houses.stream().map(AnimalHouseView::product).toList());
        for (var h : houses) {
            int ready = h.ready();
            assertEquals(ready, env.animals.collect(u, key(), h.code()).gained().get(h.product()));
            assertEquals(ready, qty(u, "PRODUCT:" + h.product()));
        }
        assertEquals(5, jdbc.queryForObject("SELECT count(*) FROM public.garden_animal WHERE user_id = ?", Integer.class, u),
                "collecting wool, eggs or manure never removes or harms an animal");

        long before = coins(u);
        int eggs = qty(u, "PRODUCT:EGG");
        AnimalReceipt sold = env.animals.sell(u, key(), new ProductSellRequest("EGG", eggs));
        assertEquals(eggs * 36L, sold.coinsDelta());
        assertEquals(before + eggs * 36L, coins(u));
        assertEquals("NO_ITEM", code(() -> env.animals.sell(u, key(), new ProductSellRequest("EGG", 1))));
        assertEquals("PRODUCT_NOT_FOUND", code(() -> env.animals.sell(u, key(), new ProductSellRequest("GOLD", 1))));
        int wool = qty(u, "PRODUCT:WOOL");
        assertEquals(wool * 190L, env.animals.sell(u, key(), new ProductSellRequest("WOOL", wool)).coinsDelta());

        // manure → fertilizer, capped per day
        int manure = qty(u, "PRODUCT:MANURE");
        assertTrue(manure >= 6, "two pigs for some days: " + manure);
        int fertilizer = qty(u, "FERTILIZER");
        assertEquals(2, env.animals.compost(u, key(), 2).gained().get("FERTILIZER"));
        assertEquals(manure - 6, qty(u, "PRODUCT:MANURE"));
        assertEquals(fertilizer + 2, qty(u, "FERTILIZER"));
        assertEquals("COMPOST_CAP", code(() -> env.animals.compost(u, key(), 1)));
        assertEquals(manure - 6, qty(u, "PRODUCT:MANURE"), "a refused batch takes nothing");
        assertEquals(2, env.state.state(u).animals().compost().usedToday());

        // the sheep grows wool again
        env.animals.water(u, key(), "SHEEP_BARN");
        if (house(u, "SHEEP_BARN").feedNeeded() > 0) env.animals.feedHouse(u, key(), "SHEEP_BARN");
        env.clock.advance(Duration.ofHours(24));
        assertTrue(house(u, "SHEEP_BARN").ready() >= 1);
        assertLedgerReconciles(u);
    }

    @Test
    void racingTabsNeverGrantChargeOrSellTwice() throws Exception {
        long u = farmer("Người Nhiều Tab", 4, 30_000);
        coopWithNineEggs(u);

        var collected = race(List.<Callable<AnimalReceipt>>of(() -> env.animals.collect(u, key(), "COOP"),
                () -> env.animals.collect(u, key(), "COOP"), () -> env.animals.collect(u, key(), "COOP")));
        assertEquals(2, failures(collected, "NOTHING_READY"));
        assertEquals(9, qty(u, "PRODUCT:EGG"), "nine eggs were laid, nine are collected");

        long before = coins(u);
        var sold = race(List.<Callable<AnimalReceipt>>of(() -> env.animals.sell(u, key(), new ProductSellRequest("EGG", 9)),
                () -> env.animals.sell(u, key(), new ProductSellRequest("EGG", 9))));
        assertEquals(1, failures(sold, "NO_ITEM"));
        assertEquals(before + 9 * 36, coins(u), "the same eggs are sold once");

        // feed for exactly one feeding, two tabs feeding and one collecting at once
        int feed = qty(u, "FEED");
        ledger.takeItem(u, "FEED", "NA", feed - 6, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        env.animals.water(u, key(), "COOP");
        var fedTwice = race(List.<Callable<AnimalReceipt>>of(() -> env.animals.feedHouse(u, key(), "COOP"),
                () -> env.animals.feedHouse(u, key(), "COOP"), () -> env.animals.collect(u, key(), "COOP")));
        assertEquals(1, failures(fedTwice, "NO_FEED"));
        assertEquals(0, qty(u, "FEED"));
        assertEquals(env.clock.now.plus(Duration.ofHours(24)), house(u, "COOP").animals().getFirst().fedUntil(), "one ration each, not two");

        long buyer = farmer("Người Mua Vội", 4, 1200 + 6000);
        env.animals.buildHouse(buyer, key(), "COOP");
        var bought = race(List.<Callable<AnimalReceipt>>of(() -> env.animals.buy(buyer, key(), "CHICKEN"),
                () -> env.animals.buy(buyer, key(), "CHICKEN")));
        assertEquals(1, failures(bought, "INSUFFICIENT_FUNDS"));
        assertEquals(1, house(buyer, "COOP").animals().size());
        assertTrue(coins(buyer) >= 0);
        assertLedgerReconciles(u);
        assertLedgerReconciles(buyer);
    }

    @Test
    void anotherPlayerCanNeitherTouchNorReadTheFarm() throws Exception {
        long owner = islander("Chủ Trại Kín Cổng", 8, 80_000);
        coopWithNineEggs(owner);
        env.animals.buy(owner, key(), "CAT");
        long other = islander("Hàng Xóm Tò Mò", 8, 80_000);

        // every command acts on the caller's own garden: the neighbour has no coop, so there is nothing to act on
        assertEquals("HOUSE_NOT_BUILT", code(() -> env.animals.collect(other, key(), "COOP")));
        assertEquals("HOUSE_NOT_BUILT", code(() -> env.animals.feedHouse(other, key(), "COOP")));
        assertEquals("HOUSE_NOT_BUILT", code(() -> env.animals.water(other, key(), "COOP")));
        assertEquals("ANIMAL_NOT_FOUND", code(() -> env.animals.feedGuardian(other, key(), "CAT")));
        assertEquals("NO_ITEM", code(() -> env.animals.sell(other, key(), new ProductSellRequest("EGG", 1))));
        assertEquals(9, house(owner, "COOP").ready(), "the owner's eggs are untouched");
        assertFalse(house(other, "COOP").built());
        assertEquals(0, env.state.state(other).animals().livestock());

        // a visitor sees which animals live there — and nothing of their food, timers or products
        var island = env.social.visit(other, handle(owner));
        assertEquals(List.of("COOP"), island.animals().houses());
        assertEquals(4, island.animals().animals().size());
        assertTrue(island.animals().animals().stream().anyMatch(a -> a.species().equals("CAT") && a.kind().equals("GUARDIAN")));
        String json = env.json.writeValueAsString(island.animals());
        for (String secret : List.of("fedUntil", "ready", "feed", "wateredUntil", "nextProductAt", "coins", "id\"")) {
            assertFalse(json.contains(secret), "a visitor is not told " + secret);
        }
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason LIKE 'ANIMAL%'", Integer.class, other));
    }

    // ------------------------------------------------------------------ guardians

    @Test
    void guardiansAreAdoptedOncePerGardenAtTheirLevel() {
        long low = farmer("Người Mới Nuôi", 4, 100_000);
        assertEquals("ANIMAL_LEVEL", code(() -> env.animals.buy(low, key(), "CAT")));
        assertEquals("LOCKED", guardian(low, "CAT").status());
        assertEquals("ANIMAL_NOT_FOUND", code(() -> env.animals.buy(low, key(), "DRAGON")));

        long u = farmer("Chủ Ba Bạn Nhỏ", 8, 100_000);
        long before = coins(u);
        assertEquals("AVAILABLE", guardian(u, "DOG").status());
        UUID k = key();
        env.animals.buy(u, k, "DOG");
        env.animals.buy(u, k, "DOG");
        env.animals.buy(u, key(), "GOOSE");
        env.animals.buy(u, key(), "CAT");
        assertEquals(before - 20_000 - 12_000 - 8_000, coins(u), "each guardian is paid for once");
        assertEquals("GUARDIAN_OWNED", code(() -> env.animals.buy(u, key(), "DOG")));
        assertEquals(3, jdbc.queryForObject("SELECT count(*) FROM public.garden_animal WHERE user_id = ? AND kind = 'GUARDIAN'", Integer.class, u));
        assertEquals("HUNGRY", guardian(u, "DOG").status(), "a guardian works only while it is fed");
        assertEquals("NO_FEED", code(() -> env.animals.feedGuardian(u, key(), "DOG")));
        supplies(u, 20, 0);
        env.animals.feedGuardian(u, key(), "DOG");
        env.animals.feedGuardian(u, key(), "GOOSE");
        env.animals.feedGuardian(u, key(), "CAT");
        assertEquals(20 - 2 - 2 - 1, qty(u, "FEED"));
        assertEquals("READY", guardian(u, "DOG").status());
        assertEquals("ON_DUTY", guardian(u, "GOOSE").status());
        assertEquals("ON_DUTY", guardian(u, "CAT").status());
        env.clock.advance(Duration.ofHours(25));
        assertEquals("HUNGRY", guardian(u, "CAT").status(), "food runs out; the pet stays");
        assertLedgerReconciles(u);
    }

    @Test
    void aFedDogTurnsOneVisitorAwayThenWatchesAndCannotSealTheIsland() throws Exception {
        long owner = islander("Chủ Vườn Có Chó", 8, 60_000);
        long a = islander("Khách Thứ Nhất", 6, 0);
        long b = islander("Khách Thứ Hai", 6, 0);
        long c = islander("Khách Thứ Ba", 6, 0);
        env.animals.buy(owner, key(), "DOG");
        supplies(owner, 20, 0);
        long crop1 = plant(owner, 1, "TOMATO");
        long crop2 = plant(owner, 2, "TOMATO");
        long crop3 = plant(owner, 3, "TOMATO");
        ripen(owner, Duration.ofMinutes(30), 1, 2, 3);
        env.clock.advance(Duration.ofMinutes(45));

        // a hungry dog is only a pet: the island is as open as Phase 3G made it
        assertEquals("HUNGRY", guardian(owner, "DOG").status());
        assertTrue(env.social.visit(a, handle(owner)).takes().stream().allMatch(t -> t.eligible()));

        env.animals.feedGuardian(owner, key(), "DOG");
        assertEquals("READY", guardian(owner, "DOG").status());
        int noticesBefore = env.notices.size();
        UUID k = key();
        TakeReceipt turned = env.social.take(a, k, handle(owner), crop1);
        assertTrue(turned.guarded());
        assertEquals(0, turned.portions());
        assertEquals("ISLAND_GUARDED", turned.protection().reason());
        assertEquals(env.clock.now.plus(Duration.ofHours(3)), turned.protection().until());
        assertEquals(3, turned.standing().takesLeft(), "the visitor loses nothing");
        assertEquals(0, takes(owner), "nothing left the island");
        assertEquals(0, qty(a, "SHARE:TOMATO"));
        assertTrue(planting(owner, 1).ready());
        assertTrue(env.social.take(a, k, handle(owner), crop1).guarded(), "a retry is the same answer");
        assertEquals(noticesBefore + 1, env.notices.size(), "the owner is told once");
        var notice = env.notices.getLast();
        assertEquals(owner, notice.ownerId());
        assertFalse(notice.body().contains("Khách Thứ Nhất"), "a visitor who took nothing is not named");
        assertTrue(notice.title().contains("Chó canh vườn"));
        assertEquals("GUARDING", guardian(owner, "DOG").status());

        // while the dog watches the island is guarded for everybody — and says so
        GardenException refused = assertThrows(GardenException.class, () -> take(b, owner, crop2));
        assertEquals("ISLAND_GUARDED", refused.code);
        assertNotNull(refused.details.get("availableAt"));
        var seen = env.social.visit(b, handle(owner));
        assertEquals("ISLAND_GUARDED", seen.protection().reason());
        assertTrue(seen.takes().stream().noneMatch(t -> t.eligible()));
        assertEquals("ISLAND_GUARDED", env.social.me(owner).protection().reason());

        // the watch ends: the dog is resting until its cooldown, the island is open again
        env.clock.advance(Duration.ofHours(3).plusMinutes(1));
        assertEquals("COOLDOWN", guardian(owner, "DOG").status());
        TakeReceipt taken = take(b, owner, crop2);
        assertFalse(taken.guarded());
        assertEquals(1, taken.portions());
        assertEquals(1, takes(owner));
        // every Phase 3G limit still holds with a dog around
        assertEquals("ISLAND_SHIELD", code(() -> take(c, owner, crop3)));

        // a day later a fed dog guards again
        env.clock.advance(Duration.ofHours(25));
        env.animals.feedGuardian(owner, key(), "DOG");
        assertEquals("READY", guardian(owner, "DOG").status());
        var both = race(List.<Callable<TakeReceipt>>of(() -> take(c, owner, crop3), () -> take(a, owner, crop1)));
        assertEquals(1, both.stream().filter(r -> r instanceof TakeReceipt t && t.guarded()).count(), "one watch turns one visitor away");
        assertEquals(1, failures(both, "ISLAND_GUARDED"));
        assertEquals(1, takes(owner), "racing visitors gain nothing from a guarded island");
        assertLedgerReconciles(owner);
        assertLedgerReconciles(a);
        assertLedgerReconciles(b);
    }

    @Test
    void aFedGooseLengthensTheOwnersHeadStart() {
        long owner = islander("Chủ Vườn Có Ngỗng", 6, 40_000);
        long visitor = islander("Khách Ghé Sớm", 6, 0);
        env.animals.buy(owner, key(), "GOOSE");
        supplies(owner, 10, 0);
        long crop = plant(owner, 1, "TOMATO");
        ripen(owner, Duration.ofMinutes(5), 1);
        env.clock.advance(Duration.ofMinutes(25));
        // 25–30 minutes after ripening: past the free twenty-minute head start
        assertTrue(env.social.visit(visitor, handle(owner)).takes().getFirst().eligible());
        env.animals.feedGuardian(owner, key(), "GOOSE");
        var early = env.social.visit(visitor, handle(owner)).takes().getFirst();
        assertFalse(early.eligible());
        assertEquals("CROP_FRESH", early.reason());
        assertEquals("CROP_FRESH", code(() -> take(visitor, owner, crop)));
        env.clock.advance(Duration.ofMinutes(36));
        assertEquals(1, take(visitor, owner, crop).portions(), "an hour after ripening the crop can be taken from as before");
    }

    static long card(long user, double dueHoursAgo) {
        String word = "animal" + WORDS.incrementAndGet();
        long de = jdbc.queryForObject("INSERT INTO public.dictionary_entries(word, cefr, general_translation_vi) VALUES (?, 'A2', ?) RETURNING id",
                Long.class, word, "Nghĩa của " + word);
        Timestamp due = Timestamp.valueOf(LocalDateTime.now().minusMinutes(Math.round(dueHoursAgo * 60)));
        return jdbc.queryForObject("""
                INSERT INTO public.flashcards(user_id, dictionary_entry_id, status, next_review_date, review_count)
                VALUES (?, ?, 'LEARNED', ?, 1) RETURNING id""", Long.class, user, de, due);
    }

    @Test
    void aFedCatKeepsOneCropPlaceFreeOfNewPestsAndTouchesNoWord() {
        long plain = farmer("Vườn Không Mèo", 5, 20_000);
        long withCat = farmer("Vườn Có Mèo", 5, 20_000);
        long hungryCat = farmer("Vườn Mèo Đói", 5, 20_000);
        for (long u : List.of(withCat, hungryCat)) env.animals.buy(u, key(), "CAT");
        supplies(withCat, 5, 0);
        for (long u : List.of(plain, withCat, hungryCat)) {
            for (int slot = 1; slot <= 5; slot++) plant(u, slot, "CORN");
        }
        env.clock.advance(Duration.ofMinutes(40));
        env.animals.feedGuardian(withCat, key(), "CAT");
        for (long u : List.of(plain, withCat, hungryCat)) {
            for (int i = 0; i < 6; i++) card(u, 40.0 + i);
        }
        assertEquals(2, env.state.state(plain).pests().size(), "two crops may be infested at once");
        assertEquals(1, env.state.state(withCat).pests().size(), "the cat keeps one place free — never all of them");
        assertEquals(2, env.state.state(hungryCat).pests().size(), "a hungry cat is only a pet");
        for (int i = 0; i < 3; i++) env.state.state(withCat);
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_pest WHERE user_id = ?", Integer.class, withCat));
        assertEquals(6, jdbc.queryForObject(
                "SELECT count(*) FROM public.flashcards WHERE user_id = ? AND next_review_date <= LOCALTIMESTAMP - interval '24 hours'",
                Integer.class, withCat), "every overdue word is still overdue: the cat never reviews for the learner");
    }

    // ------------------------------------------------------------------ harvest portions

    @Test
    void harvestPortionsAreSoldAtTheirProportionalValueAndNeverForMoreThanTheUnit() throws Exception {
        long owner = islander("Chủ Vườn Bị Lấy", 6, 0);
        long taker = islander("Khách Lấy Một Ít", 6, 0);
        long crop = plant(owner, 1, "TOMATO");
        ripen(owner, Duration.ofMinutes(30), 1);
        env.clock.advance(Duration.ofMinutes(45));
        take(taker, owner, crop);
        String tier = harvest(owner, crop).harvests().getFirst().tier();
        assertEquals(9, qty(owner, "SHARE:TOMATO"));
        assertEquals(0, qty(owner, "CROP:TOMATO"));

        var mine = env.state.state(owner).inventory().shares().getFirst();
        assertEquals(List.of("TOMATO", tier, 9, 10), List.of(mine.cropCode(), mine.tier(), mine.portions(), mine.unitPortions()));
        assertEquals(Math.floorDiv(mine.unitPrice() * 9, 10L), mine.value());
        assertTrue(mine.value() > 0, "nine portions are worth real Đồng Echo");

        assertEquals("NO_ITEM", code(() -> env.sell.sellShares(owner, key(), new ShareSellRequest(List.of(new ShareSellLine("TOMATO", tier, 10))))));
        assertEquals("INVALID_COMMAND", code(() -> env.sell.sellShares(owner, key(), new ShareSellRequest(List.of(new ShareSellLine("TOMATO", "SHINY", 1))))));
        assertEquals(9, qty(owner, "SHARE:TOMATO"));

        long ownerCoins = coins(owner);
        UUID k = key();
        var req = new ShareSellRequest(List.of(new ShareSellLine("TOMATO", tier, 9)));
        var results = race(List.<Callable<Object>>of(() -> env.sell.sellShares(owner, k, req), () -> env.sell.sellShares(owner, k, req),
                () -> env.sell.sellShares(owner, key(), req)));
        assertTrue(failures(results, "NO_ITEM") >= 1, "the same portions are sold once, whatever the retries and tabs");
        assertEquals(ownerCoins + mine.value(), coins(owner));
        assertEquals(0, qty(owner, "SHARE:TOMATO"));

        var theirs = env.state.state(taker).inventory().shares().getFirst();
        long takerCoins = coins(taker);
        var sold = env.sell.sellShares(taker, key(), new ShareSellRequest(List.of(new ShareSellLine("TOMATO", "NORMAL", 1))));
        assertEquals(Math.floorDiv(theirs.unitPrice(), 10L), sold.coinsGained());
        assertEquals(takerCoins + sold.coinsGained(), coins(taker));

        // the unit this crop would have paid its owner, whole: the two shares together never exceed it
        long ownerUnit = mine.unitPrice();
        assertTrue(mine.value() + AnimalEngine.portionValue(ownerUnit, 1, 10) <= ownerUnit, "no Đồng Echo is created by splitting");
        assertTrue(mine.value() + sold.coinsGained() <= Math.max(ownerUnit, theirs.unitPrice()));
        assertEquals(0, qty(taker, "SHARE:TOMATO"));
        assertLedgerReconciles(owner);
        assertLedgerReconciles(taker);

        // portion by portion is never better than all at once
        long patient = islander("Người Bán Lẻ", 6, 0);
        give(patient, "SHARE:WHEAT", "NORMAL", 9);
        long unit = env.state.state(patient).inventory().shares().getFirst().unitPrice();
        long start = coins(patient);
        for (int i = 0; i < 9; i++) env.sell.sellShares(patient, key(), new ShareSellRequest(List.of(new ShareSellLine("WHEAT", "NORMAL", 1))));
        assertTrue(coins(patient) - start <= Math.floorDiv(unit * 9, 10L));
        assertTrue(env.state.state(patient).inventory().shares().isEmpty());

        // whole produce and the automatic exchange of ten fragments are unchanged
        give(patient, "CROP:WHEAT", "NORMAL", 1);
        assertEquals(1, env.state.state(patient).inventory().produce().stream().filter(p -> p.cropCode().equals("WHEAT")).findFirst().orElseThrow().qty());
    }

    // ------------------------------------------------------------------ open garden, chosen visibility

    @Test
    void aNewIslandStartsClosedUntilItsOwnerChooses() {
        long viewer = islander("Người Khám Phá", 6, 0);
        long fresh = farmer("Người Mới Đến", 3, 0);
        var social = env.state.state(fresh).social();
        assertEquals("PRIVATE", social.visibility());
        assertFalse(social.visibilityChosen(), "the owner is asked once");
        String handle = handle(fresh);
        assertTrue(env.social.discover(viewer, null, null).islands().stream().noneMatch(i -> i.handle().equals(handle)),
                "nobody is listed before they decided");
        assertEquals("ISLAND_NOT_FOUND", code(() -> env.social.visit(viewer, handle)));

        env.social.setVisibility(fresh, key(), "PUBLIC");
        assertTrue(env.state.state(fresh).social().visibilityChosen());
        assertEquals("PUBLIC", env.state.state(fresh).social().visibility());
        assertTrue(env.social.discover(viewer, null, null).islands().stream().anyMatch(i -> i.handle().equals(handle)));
        assertNotNull(env.social.visit(viewer, handle));
        env.social.setVisibility(fresh, key(), "PRIVATE");
        assertTrue(env.state.state(fresh).social().visibilityChosen(), "asked once, never again");
        assertEquals("ISLAND_NOT_FOUND", code(() -> env.social.visit(viewer, handle)));

        long shy = farmer("Người Thích Yên Tĩnh", 3, 0);
        env.state.state(shy);
        env.social.setVisibility(shy, key(), "PRIVATE");
        assertTrue(env.state.state(shy).social().visibilityChosen(), "keeping the island closed is a decision too");
        assertEquals("PRIVATE", env.state.state(shy).social().visibility());
    }

    @Test
    void anEmptyAllowlistOpensTheGardenToEveryAccountAndTheSwitchStillCloses() {
        GardenProperties open = new GardenProperties();
        open.setEnabled(true);
        GardenAccessService everyone = new GardenAccessService(open);
        assertTrue(everyone.allowed(1) && everyone.allowed(424_242), "an empty allowlist means every account");
        assertFalse(everyone.qa(424_242), "nobody becomes a QA user by the opening");
        open.setEnabled(false);
        assertFalse(everyone.allowed(1));
        assertEquals("GARDEN_NOT_FOUND", code(() -> everyone.require(424_242)));

        // on the shared environment: an account outside the list has no garden; the open audience gives it its own
        long stranger = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id, name) VALUES (?, 'Người Lạ')", stranger);
        assertEquals("GARDEN_NOT_FOUND", code(() -> env.state.state(stranger)));
        List<Long> list = new ArrayList<>(env.props.getAllowlistUserIds());
        try {
            env.props.getAllowlistUserIds().clear();
            var state = env.state.state(stranger);
            assertEquals(6, state.plots().size(), "its own six starter beds");
            assertEquals(1, state.profile().level());
            assertFalse(state.animals().houses().isEmpty());
            assertEquals(0, state.animals().livestock());
            assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_profile WHERE user_id = ?", Integer.class, stranger));
        } finally {
            env.props.getAllowlistUserIds().addAll(list);
        }
    }

    // ------------------------------------------------------------------ upgrade

    @Test
    void aGardenFromBeforeV89KeepsEverythingAndGainsTheFarm() {
        try (GardenTestEnv before = new GardenTestEnv(START, "88")) {
            long user = farmer(before, "Nông Dân Thời 3G", 6, 0);
            LedgerService old = new LedgerService(before.ctx);
            old.addItem(user, "SHARE:TOMATO", "GOOD", 9, "TEST_FIXTURE", "TEST", "fixture", null, before.clock.now);
            old.addItem(user, "CROP:WHEAT", "NORMAL", 4, "TEST_FIXTURE", "TEST", "fixture", null, before.clock.now);
            var state = before.state.state(user);
            assertNull(state.animals(), "no animals on a database without V89");
            assertNull(before.ctx.animals());
            assertEquals("PUBLIC", state.social().visibility());
            assertTrue(state.social().visibilityChosen());
            assertEquals("ANIMALS_CLOSED", assertThrows(GardenException.class, () -> before.animals.buildHouse(user, key(), "COOP")).code);
            long growing = before.planting.plant(user, key(), state.plots().getFirst().id(), new PlantRequest("WHEAT")).plot().planting().id();
            long coinsBefore = state.profile().coins();
            String handle = before.jdbc.queryForObject("SELECT handle FROM public.garden_social_profile WHERE user_id = ?", String.class, user);

            // the release: the same database, migrated to V89
            GardenTestEnv after = new GardenTestEnv(before, before.clock.now, "89");
            after.props.getAllowlistUserIds().add(user);
            var upgraded = after.state.state(user);
            assertEquals(coinsBefore, upgraded.profile().coins(), "balances untouched");
            assertEquals(growing, upgraded.plots().getFirst().planting().id(), "the growing crop is still there");
            assertEquals("PUBLIC", upgraded.social().visibility(), "an island that was open stays open");
            assertTrue(upgraded.social().visibilityChosen(), "and is not asked again");
            assertEquals(handle, after.jdbc.queryForObject("SELECT handle FROM public.garden_social_profile WHERE user_id = ?", String.class, user));
            assertEquals(4, upgraded.inventory().produce().stream().filter(p -> p.cropCode().equals("WHEAT")).findFirst().orElseThrow().qty());
            var share = upgraded.inventory().shares().getFirst();
            assertEquals(9, share.portions());
            assertTrue(share.value() > 0, "portions from before the release can now be sold");
            assertEquals(share.value(), after.sell.sellShares(user, key(), new ShareSellRequest(List.of(new ShareSellLine("TOMATO", "GOOD", 9)))).coinsGained());
            assertEquals(4, upgraded.animals().houses().size());
            assertTrue(upgraded.animals().houses().stream().noneMatch(AnimalHouseView::built));
            assertEquals(0, after.jdbc.queryForObject("SELECT count(*) FROM public.garden_animal", Integer.class));
        }
    }
}
