package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenDtos.CosmeticBuyRequest;
import com.englishcoach.garden.api.GardenDtos.CosmeticCheckoutRequest;
import com.englishcoach.garden.api.GardenDtos.CosmeticEquipRequest;
import com.englishcoach.garden.api.GardenDtos.CosmeticItemView;
import com.englishcoach.garden.api.GardenDtos.DecorMoveRequest;
import com.englishcoach.garden.api.GardenDtos.DecorPlaceRequest;
import com.englishcoach.garden.api.GardenDtos.PlantRequest;
import com.englishcoach.garden.api.GardenDtos.SkinAcquireRequest;
import com.englishcoach.garden.api.GardenDtos.SkinEquipRequest;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.CosmeticCheckoutService;
import com.englishcoach.garden.application.CosmeticPaymentGateway;
import com.englishcoach.garden.application.LedgerService;
import com.englishcoach.garden.config.GardenProperties;
import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3E on real PostgreSQL 17 + the real migrations through V86 ({@link GardenTestEnv}): the seeded catalogue, coin
 * purchases (once, idempotent, concurrency-safe, ledger-reconciled), earned items that cannot be bought or spoofed,
 * equipment, decoration placement, account isolation, "art only" (no gameplay value changes), the upgrade of a garden
 * that existed before V86, and the closed direct-purchase boundary. Each test uses its own user ids.
 */
class GardenPhase3EPersistenceTest {

    static final Instant START = Instant.parse("2026-10-09T03:00:00Z"); // 10:00 Vietnam
    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static LedgerService ledger;
    static final AtomicLong USERS = new AtomicLong(90_000);

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(START, "86");
        jdbc = env.jdbc;
        ledger = new LedgerService(env.ctx);
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    // ------------------------------------------------------------------ helpers

    static long newUser(GardenTestEnv e) {
        long id = USERS.incrementAndGet();
        e.jdbc.update("INSERT INTO public.users(id) VALUES (?)", id);
        e.props.getAllowlistUserIds().add(id);
        return id;
    }

    /** A garden past the tutorial with {@code coins} extra Đồng Echo (granted through the ledger so balances reconcile). */
    static long farmer(long coins) {
        long u = newUser(env);
        env.state.state(u);
        jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", u);
        if (coins > 0) ledger.addCoins(u, coins, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        return u;
    }

    static UUID key() {
        return UUID.randomUUID();
    }

    static GardenException rejected(Runnable r) {
        return assertThrows(GardenException.class, r::run);
    }

    static long coins(long user) {
        return jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static int count(String sql, Object... args) {
        return jdbc.queryForObject(sql, Integer.class, args);
    }

    static void assertCoinsReconcile(long user) {
        assertEquals(coins(user), jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND asset = 'COIN'",
                Long.class, user), "coins reconcile with the ledger");
    }

    static CosmeticItemView item(GardenDtos.CosmeticShopView shop, String code) {
        return shop.items().stream().filter(i -> i.code().equals(code)).findFirst().orElseThrow();
    }

    static <T> List<Object> race(int n, Callable<T> call) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<T>> futures = new ArrayList<>();
        for (int i = 0; i < n; i++) futures.add(pool.submit(() -> {
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

    // ------------------------------------------------------------------ catalogue

    @Test
    void v86SeedsExactlyTheReviewedCatalogueAndTouchesNoEarlierRow() throws Exception {
        JsonNode cat;
        try (var in = getClass().getResourceAsStream("/garden/phase3e_catalogue.json")) {
            cat = env.json.readTree(in);
        }
        var rules = env.ctx.cosmetics();
        assertNotNull(rules);
        var expected = GardenPhase3EDomainTest.fromCatalogue(cat);
        assertEquals(expected.collections(), rules.collections());
        assertEquals(expected.items(), rules.items(), "every cosmetic row = the reviewed catalogue");
        assertEquals(expected.skinCollections(), rules.skinCollections());
        assertEquals(expected.regions(), rules.regions());
        assertEquals(expected.maxPlaced(), rules.maxPlaced());
        assertEquals(expected.snap(), rules.snap());
        // the fifty cultivars: exact rows
        for (JsonNode s : cat.get("skins")) {
            Map<String, Object> row = jdbc.queryForMap("SELECT * FROM public.garden_skin_def WHERE code = ?", s.get("code").asText());
            assertEquals(s.get("cropCode").asText(), row.get("crop_code"));
            assertEquals(s.get("unlockKind").asText(), row.get("unlock_kind"));
            assertEquals(s.get("coinPrice").asInt(), ((Number) row.get("coin_price")).intValue());
            assertEquals(s.get("masteryTier").asInt(), ((Number) row.get("mastery_tier")).intValue());
            assertEquals(s.get("learningDays").asInt(), ((Number) row.get("learning_days")).intValue());
            assertEquals(s.get("artKey").asText(), row.get("art_key"));
            assertEquals(s.get("collection").asText(), row.get("collection_code"));
            assertEquals(s.get("nameVi").asText(), row.get("name_vi"));
        }
        assertEquals(57, count("SELECT count(*) FROM public.garden_skin_def"), "6 (V82) + 1 (V83) + 50 (V86)");
        assertEquals(5, count("SELECT min(n) FROM (SELECT count(*) n FROM public.garden_skin_def WHERE collection_code IS NOT NULL GROUP BY crop_code) t"));
        assertEquals(10, count("SELECT count(DISTINCT crop_code) FROM public.garden_skin_def WHERE collection_code IS NOT NULL"));
        // earlier cultivars are untouched (no collection, same prices)
        assertEquals(7, count("SELECT count(*) FROM public.garden_skin_def WHERE collection_code IS NULL"));
        assertEquals(24000, count("SELECT coin_price FROM public.garden_skin_def WHERE code = 'TOMATO_AMBER'"));
        assertEquals(57, env.ctx.living().rules().skins().size(), "the living rules see the whole catalogue");
        // nothing is for sale for real money: no SKU, no order
        assertEquals(0, count("SELECT count(*) FROM public.garden_cosmetic_sku"));
        assertEquals(0, count("SELECT count(*) FROM public.garden_cosmetic_order"));
        // Phase 3D rules are exactly what they were
        assertTrue(GardenTestRules.equivalent(GardenTestRules.phase3d(), env.ctx.engine().rules()));
        assertTrue(GardenTestRules.farmingEquivalent(GardenTestRules.farming(), env.ctx.farming().rules()));
        assertTrue(GardenTestRules.estateEquivalent(GardenTestRules.estate(), env.ctx.estate().rules()));
    }

    @Test
    void theCatalogueRefusesContradictoryRows() {
        // a coin item without a price, an earned item with a price, a decoration without a footprint, an unknown collection
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_cosmetic_def(code, category, family, collection_code, name_vi, description_vi, art_key, unlock_kind, coin_price, sort_order)
                VALUES ('X_FREE', 'HOUSE', 'HOUSE', 'FROST', 'x', 'x', 'x', 'COIN', 0, 900)"""));
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_cosmetic_def(code, category, family, collection_code, name_vi, description_vi, art_key, unlock_kind, coin_price, requirement, sort_order)
                VALUES ('X_SOLD', 'HOUSE', 'HOUSE', 'FROST', 'x', 'x', 'x', 'LEARNING', 500, 7, 901)"""));
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_cosmetic_def(code, category, family, collection_code, name_vi, description_vi, art_key, unlock_kind, coin_price, sort_order)
                VALUES ('X_FLAT', 'DECOR', 'LANTERN', 'FROST', 'x', 'x', 'x', 'COIN', 500, 902)"""));
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_cosmetic_def(code, category, family, collection_code, name_vi, description_vi, art_key, unlock_kind, coin_price, sort_order)
                VALUES ('X_LOST', 'HOUSE', 'HOUSE', 'NOPE', 'x', 'x', 'x', 'COIN', 500, 903)"""));
        // a SKU can never be enabled without a price
        assertThrows(Exception.class, () -> jdbc.update(
                "INSERT INTO public.garden_cosmetic_sku(sku_code, item_kind, item_code, enabled) VALUES ('SKU_X', 'COSMETIC', 'HOUSE_FROST', TRUE)"));
    }

    // ------------------------------------------------------------------ coin purchases

    @Test
    void aCoinPurchaseDeductsThePriceExactlyOnceAndIsReplayedByItsKey() {
        long u = farmer(100_000);
        long before = coins(u);
        var shop = env.cosmetics.shop(u);
        assertEquals("AVAILABLE", item(shop, "HOUSE_BLOSSOM").status());
        assertTrue(item(shop, "HOUSE_BLOSSOM").coinsOk());
        assertEquals("AVAILABLE", item(shop, "HOUSE_LONGPHUNG").status(), "affordability is reported separately from eligibility");
        assertFalse(item(shop, "HOUSE_LONGPHUNG").coinsOk());
        assertFalse(shop.checkoutEnabled());

        UUID k = key();
        var receipt = env.cosmetics.buy(u, k, new CosmeticBuyRequest("HOUSE_BLOSSOM"));
        assertEquals(60_000, receipt.coinsPaid());
        assertEquals(before - 60_000, receipt.coins());
        assertEquals(before - 60_000, coins(u));
        assertEquals("OWNED", item(receipt.shop(), "HOUSE_BLOSSOM").status());
        // the same key again: the stored receipt, no second charge, no second unit
        var replay = env.cosmetics.buy(u, k, new CosmeticBuyRequest("HOUSE_BLOSSOM"));
        assertEquals(receipt.coins(), replay.coins());
        assertEquals(before - 60_000, coins(u));
        assertEquals(1, count("SELECT count(*) FROM public.garden_cosmetic_acquisition WHERE user_id = ?", u));
        // the same key for another item is refused (422), a new key for the owned item too (409)
        assertEquals(422, rejected(() -> env.cosmetics.buy(u, k, new CosmeticBuyRequest("HOUSE_SUNGOLD"))).status);
        assertEquals("COSMETIC_OWNED", rejected(() -> env.cosmetics.buy(u, key(), new CosmeticBuyRequest("HOUSE_BLOSSOM"))).code);
        assertEquals(before - 60_000, coins(u));
        // too poor: nothing moves
        var poor = rejected(() -> env.cosmetics.buy(u, key(), new CosmeticBuyRequest("HOUSE_SUNGOLD")));
        assertEquals("INSUFFICIENT_FUNDS", poor.code);
        assertEquals(90_000 - (before - 60_000), ((Number) poor.details.get("missing")).longValue());
        assertEquals(404, rejected(() -> env.cosmetics.buy(u, key(), new CosmeticBuyRequest("HOUSE_CLASSIC"))).status);
        assertEquals(400, rejected(() -> env.cosmetics.buy(u, null, new CosmeticBuyRequest("HOUSE_SUNGOLD"))).status);
        assertEquals(1, count("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'COSMETIC_BUY'", u));
        assertEquals(-60_000L, jdbc.queryForObject("SELECT delta FROM public.garden_ledger WHERE user_id = ? AND reason = 'COSMETIC_BUY'", Long.class, u));
        assertCoinsReconcile(u);
    }

    @Test
    void racingPurchasesOfOnePermanentItemGrantItOnceAndChargeOnce() throws Exception {
        long u = farmer(500_000);
        long before = coins(u);
        var results = race(6, () -> env.cosmetics.buy(u, key(), new CosmeticBuyRequest("HOUSE_FROST")));
        long ok = results.stream().filter(r -> r instanceof GardenDtos.CosmeticReceipt).count();
        long owned = results.stream().filter(r -> r instanceof GardenException g && g.code.equals("COSMETIC_OWNED")).count();
        assertEquals(1, ok, "exactly one tab buys it: " + results);
        assertEquals(5, owned);
        assertEquals(before - 180_000, coins(u), "charged once");
        assertEquals(1, count("SELECT quantity FROM public.garden_cosmetic_owned WHERE user_id = ? AND cosmetic_code = 'HOUSE_FROST'", u));
        assertEquals(1, count("SELECT count(*) FROM public.garden_cosmetic_acquisition WHERE user_id = ?", u));
        assertCoinsReconcile(u);
    }

    @Test
    void aDecorationCanBeBoughtUpToItsLimitOneUnitPerKey() throws Exception {
        long u = farmer(50_000);
        long before = coins(u);
        // four tabs press "buy" at once with their own keys: each is a real purchase, never more than the limit
        var results = race(6, () -> env.cosmetics.buy(u, key(), new CosmeticBuyRequest("DECOR_LANTERN_STONE")));
        long ok = results.stream().filter(r -> r instanceof GardenDtos.CosmeticReceipt).count();
        assertEquals(4, ok, "max_owned = 4: " + results);
        assertEquals(before - 4 * 2_500, coins(u));
        assertEquals(4, count("SELECT quantity FROM public.garden_cosmetic_owned WHERE user_id = ? AND cosmetic_code = 'DECOR_LANTERN_STONE'", u));
        assertEquals(List.of(1, 2, 3, 4), jdbc.queryForList(
                "SELECT unit_no FROM public.garden_cosmetic_acquisition WHERE user_id = ? ORDER BY unit_no", Integer.class, u));
        assertEquals("COSMETIC_OWNED", rejected(() -> env.cosmetics.buy(u, key(), new CosmeticBuyRequest("DECOR_LANTERN_STONE"))).code);
        // the database itself refuses a fifth unit and any rewrite of history
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_cosmetic_owned SET quantity = 5 WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_cosmetic_acquisition WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_cosmetic_acquisition SET coins_paid = 1 WHERE user_id = ?", u));
        assertCoinsReconcile(u);
    }

    // ------------------------------------------------------------------ earned items

    @Test
    void earnedItemsFollowStoredFactsAndCanBeNeitherBoughtNorSpoofed() {
        long u = farmer(2_000_000);
        long before = coins(u);
        for (String code : List.of("DECOR_STATUE_WHALE", "DECOR_STATUE_MEMORY", "TREE_PHUONG", "MONUMENT_PHOENIX", "SHRUB_HOLLY", "FLOWER_MOONLILY")) {
            var e = rejected(() -> env.cosmetics.buy(u, key(), new CosmeticBuyRequest(code)));
            assertEquals("COSMETIC_LOCKED", e.code, code + " cannot be bought with two million coins");
            assertEquals(0, ((Number) e.details.get("have")).intValue());
        }
        assertEquals(before, coins(u));
        assertEquals("LOCKED", item(env.cosmetics.shop(u), "DECOR_STATUE_WHALE").status());
        // seven verified learning days recorded by the monument (the garden's own fact)
        jdbc.update("UPDATE public.garden_monument SET learning_days = 7 WHERE user_id = ?", u);
        var shop = env.cosmetics.shop(u);
        assertEquals("AVAILABLE", item(shop, "DECOR_STATUE_WHALE").status());
        assertEquals(7, item(shop, "DECOR_STATUE_WHALE").progress());
        assertEquals("LOCKED", item(shop, "DECOR_STATUE_MEMORY").status(), "fourteen days are not seven");
        var r = env.cosmetics.buy(u, key(), new CosmeticBuyRequest("DECOR_STATUE_WHALE"));
        assertEquals(0, r.coinsPaid());
        assertEquals("LEARNING", r.source());
        assertEquals(before, coins(u), "an earned item is free");
        assertEquals("LEARNING", jdbc.queryForObject("SELECT source FROM public.garden_cosmetic_acquisition WHERE user_id = ?", String.class, u));
        // harvests and graduations
        jdbc.update("""
                INSERT INTO public.garden_crop_mastery(user_id, crop_code, harvests, best_tier, seasons, tier, first_at, last_at)
                VALUES (?, 'WHEAT', 300, 2, 1, 3, now(), now())
                ON CONFLICT (user_id, crop_code) DO UPDATE SET harvests = 300""", u);
        assertEquals("HARVESTS", env.cosmetics.buy(u, key(), new CosmeticBuyRequest("SHRUB_HOLLY")).source());
        assertEquals("COSMETIC_LOCKED", rejected(() -> env.cosmetics.buy(u, key(), new CosmeticBuyRequest("FLOWER_MOONLILY"))).code);
        jdbc.update("""
                INSERT INTO public.garden_knowledge_tree(user_id, slot, species, planted_at, status, peak_stage, essence_since, graduated_at)
                VALUES (?, 1, 'SPRING', now() - interval '15 days', 'GRADUATED', 4, now(), now())""", u);
        assertEquals("GRADUATIONS", env.cosmetics.buy(u, key(), new CosmeticBuyRequest("FLOWER_MOONLILY")).source());
        assertEquals(before, coins(u));
        assertCoinsReconcile(u);
    }

    @Test
    void aCultivarStillNeedsItsCropGrownAndItsOwnGate() {
        long u = farmer(1_000_000);
        // the legendary orchid cultivar cannot be bought by a player who never grew the orchid (graduation-only seed)
        var e = rejected(() -> env.collection.acquire(u, key(), new SkinAcquireRequest("CRYSTAL_ORCHID_RUBY")));
        assertEquals("SKIN_LOCKED", e.code);
        assertEquals("MASTERY", e.details.get("reason"));
        var shop = env.cosmetics.shop(u);
        assertEquals(50, shop.skins().size(), "the shop lists the fifty collection cultivars");
        assertTrue(shop.skins().stream().allMatch(s -> s.status().equals("LOCKED")), "nothing harvested yet");
        // after the first wheat harvest (mastery tier 1) the wheat coin cultivars open; the earned ones stay closed
        jdbc.update("""
                INSERT INTO public.garden_crop_mastery(user_id, crop_code, harvests, best_tier, seasons, tier, first_at, last_at)
                VALUES (?, 'WHEAT', 1, 0, 1, 1, now(), now())""", u);
        long before = coins(u);
        var r = env.collection.acquire(u, key(), new SkinAcquireRequest("WHEAT_BLOSSOM"));
        assertEquals(6_000, r.coinsPaid());
        assertEquals(before - 6_000, coins(u));
        assertEquals("SKIN_LOCKED", rejected(() -> env.collection.acquire(u, key(), new SkinAcquireRequest("WHEAT_SUNFIRE"))).code);
        assertEquals("SKIN_LOCKED", rejected(() -> env.collection.acquire(u, key(), new SkinAcquireRequest("WHEAT_STARLIGHT"))).code);
        env.collection.equip(u, key(), new SkinEquipRequest("WHEAT", "WHEAT_BLOSSOM"));
        var s = env.state.state(u);
        var planted = env.planting.plant(u, key(), s.plots().getFirst().id(), new PlantRequest("WHEAT"));
        assertEquals("wheat_blossom", planted.plot().planting().skinArt(), "the planting wears the cultivar's art");
        assertCoinsReconcile(u);
    }

    // ------------------------------------------------------------------ equipment

    @Test
    void onlyAnOwnedAppearanceOfTheRightSlotCanBeEquippedAndItPersists() {
        long u = farmer(400_000);
        assertNotNull(env.state.state(u).cosmetics());
        assertTrue(env.state.state(u).cosmetics().equipped().isEmpty(), "a new garden wears the island's own look");
        assertEquals(404, rejected(() -> env.cosmetics.equip(u, key(), new CosmeticEquipRequest("HOUSE", "HOUSE_FROST"))).status, "not owned");
        env.cosmetics.buy(u, key(), new CosmeticBuyRequest("HOUSE_FROST"));
        env.cosmetics.buy(u, key(), new CosmeticBuyRequest("FENCE_BAMBOO"));
        assertEquals("COSMETIC_SLOT_MISMATCH", rejected(() -> env.cosmetics.equip(u, key(), new CosmeticEquipRequest("FENCE", "HOUSE_FROST"))).code);
        assertEquals(404, rejected(() -> env.cosmetics.equip(u, key(), new CosmeticEquipRequest("HOUSE", "HOUSE_NOWHERE"))).status);
        var eq = env.cosmetics.equip(u, key(), new CosmeticEquipRequest("HOUSE", "HOUSE_FROST"));
        assertEquals("frost", eq.state().equipped().get("HOUSE"));
        env.cosmetics.equip(u, key(), new CosmeticEquipRequest("FENCE", "FENCE_BAMBOO"));
        // a fresh read (another device) shows the same island
        var state = env.state.state(u).cosmetics();
        assertEquals(Map.of("HOUSE", "frost", "FENCE", "bamboo"), state.equipped());
        assertEquals(Map.of("HOUSE", "HOUSE_FROST", "FENCE", "FENCE_BAMBOO"), state.equippedCodes());
        assertTrue(item(env.cosmetics.shop(u), "HOUSE_FROST").equipped());
        // restoring the island's own look consumes nothing
        var back = env.cosmetics.equip(u, key(), new CosmeticEquipRequest("HOUSE", null));
        assertFalse(back.state().equipped().containsKey("HOUSE"));
        assertEquals("OWNED", item(env.cosmetics.shop(u), "HOUSE_FROST").status());
        // the database refuses an item of another category in a slot and an item the player does not own
        assertThrows(Exception.class, () -> jdbc.update(
                "INSERT INTO public.garden_cosmetic_equipped(user_id, slot, cosmetic_code, equipped_at) VALUES (?, 'PATH', 'HOUSE_FROST', now())", u));
        assertThrows(Exception.class, () -> jdbc.update(
                "INSERT INTO public.garden_cosmetic_equipped(user_id, slot, cosmetic_code, equipped_at) VALUES (?, 'PATH', 'PATH_JADE', now())", u));
    }

    // ------------------------------------------------------------------ decorations

    @Test
    void decorationsArePlacedMovedAndStoredWithoutEverBeingDuplicatedOrLost() {
        long u = farmer(60_000);
        assertEquals(404, rejected(() -> env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 9.0, 25.25))).status, "not owned");
        env.cosmetics.buy(u, key(), new CosmeticBuyRequest("DECOR_LANTERN_STONE"));
        env.cosmetics.buy(u, key(), new CosmeticBuyRequest("DECOR_LANTERN_STONE"));
        env.cosmetics.buy(u, key(), new CosmeticBuyRequest("FENCE_BAMBOO"));
        assertEquals("COSMETIC_NOT_PLACEABLE", rejected(() -> env.cosmetics.place(u, key(), new DecorPlaceRequest("FENCE_BAMBOO", 9.0, 25.25))).code);

        UUID k = key();
        var a = env.cosmetics.place(u, k, new DecorPlaceRequest("DECOR_LANTERN_STONE", 9.0, 25.25));
        assertEquals("SOUTH_SHORE", a.decor().region());
        assertEquals("lantern_stone", a.decor().artKey());
        assertEquals(a.decor().id(), env.cosmetics.place(u, k, new DecorPlaceRequest("DECOR_LANTERN_STONE", 9.0, 25.25)).decor().id(), "a retry is the same lantern");
        assertEquals(1, env.state.state(u).cosmetics().decor().size());
        // protected and invalid points
        assertEquals("DECOR_OUT_OF_BOUNDS", rejected(() -> env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 8.0, 18.0))).code, "a farm bed");
        assertEquals("DECOR_OUT_OF_BOUNDS", rejected(() -> env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 14.5, 7.25))).code, "the cottage");
        assertEquals("DECOR_OUT_OF_BOUNDS", rejected(() -> env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 0.0, 0.0))).code, "off the island");
        assertEquals("DECOR_OFF_GRID", rejected(() -> env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 9.13, 25.25))).code);
        assertEquals("DECOR_OVERLAP", rejected(() -> env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 9.25, 25.25))).code);
        var b = env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 10.0, 25.25));
        assertNotEquals(a.decor().id(), b.decor().id());
        assertEquals("DECOR_NONE_STORED", rejected(() -> env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 11.0, 25.25))).code,
                "two owned, two standing");
        var shop = env.cosmetics.shop(u);
        assertEquals(2, item(shop, "DECOR_LANTERN_STONE").owned());
        assertEquals(2, item(shop, "DECOR_LANTERN_STONE").placed());
        // move: never onto the other lantern, never off a region; its own spot does not block it
        assertEquals("DECOR_OVERLAP", rejected(() -> env.cosmetics.move(u, key(), a.decor().id(), new DecorMoveRequest(10.25, 25.25))).code);
        assertEquals("DECOR_OUT_OF_BOUNDS", rejected(() -> env.cosmetics.move(u, key(), a.decor().id(), new DecorMoveRequest(12.5, 12.5))).code);
        var moved = env.cosmetics.move(u, key(), a.decor().id(), new DecorMoveRequest(9.25, 25.25));
        assertEquals(9.25, moved.decor().gx());
        var far = env.cosmetics.move(u, key(), a.decor().id(), new DecorMoveRequest(15.0, 10.5));
        assertEquals("COTTAGE_GARDEN", far.decor().region());
        // store and place again: the unit is never destroyed
        var stored = env.cosmetics.store(u, key(), a.decor().id());
        assertNull(stored.decor());
        assertEquals(1, stored.state().decor().size());
        assertEquals(2, count("SELECT quantity FROM public.garden_cosmetic_owned WHERE user_id = ? AND cosmetic_code = 'DECOR_LANTERN_STONE'", u));
        assertEquals(404, rejected(() -> env.cosmetics.store(u, key(), a.decor().id())).status, "already stored");
        assertEquals(404, rejected(() -> env.cosmetics.move(u, key(), a.decor().id(), new DecorMoveRequest(9.0, 25.75))).status);
        var again = env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 9.0, 25.75));
        assertEquals(2, again.state().decor().size());
        // the database refuses a unit the player does not hold, a second copy of a unit and two decorations on one point
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_decor_placement(user_id, cosmetic_code, unit_no, region_code, gx, gy, placed_at, moved_at)
                VALUES (?, 'DECOR_LANTERN_STONE', 3, 'SOUTH_SHORE', 11, 25.5, now(), now())""", u));
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_decor_placement(user_id, cosmetic_code, unit_no, region_code, gx, gy, placed_at, moved_at)
                VALUES (?, 'DECOR_LANTERN_STONE', 1, 'SOUTH_SHORE', 11, 25.5, now(), now())""", u));
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_decor_placement(user_id, cosmetic_code, unit_no, region_code, gx, gy, placed_at, moved_at)
                VALUES (?, 'FENCE_BAMBOO', 1, 'SOUTH_SHORE', 11, 25.5, now(), now())""", u));
    }

    @Test
    void twoTabsCannotStandTheSameDecorationTwice() throws Exception {
        long u = farmer(20_000);
        env.cosmetics.buy(u, key(), new CosmeticBuyRequest("DECOR_SIGN_FARM"));   // one unit only
        AtomicInteger n = new AtomicInteger();
        var results = race(5, () -> env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_SIGN_FARM", 8.0 + 0.75 * n.getAndIncrement(), 25.0)));
        assertEquals(1, results.stream().filter(r -> r instanceof GardenDtos.DecorResult).count(), "one sign, one place: " + results);
        assertEquals(4, results.stream().filter(r -> r instanceof GardenException g && g.code.equals("DECOR_NONE_STORED")).count());
        assertEquals(1, count("SELECT count(*) FROM public.garden_decor_placement WHERE user_id = ?", u));
    }

    // ------------------------------------------------------------------ isolation

    @Test
    void anotherPlayerSeesAndTouchesNothingOfThisGarden() {
        long a = farmer(100_000);
        long b = farmer(0);
        env.cosmetics.buy(a, key(), new CosmeticBuyRequest("HOUSE_BLOSSOM"));
        env.cosmetics.buy(a, key(), new CosmeticBuyRequest("DECOR_LANTERN_STONE"));
        env.cosmetics.equip(a, key(), new CosmeticEquipRequest("HOUSE", "HOUSE_BLOSSOM"));
        long decor = env.cosmetics.place(a, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 9.0, 25.25)).decor().id();
        var sb = env.state.state(b).cosmetics();
        assertTrue(sb.equipped().isEmpty());
        assertTrue(sb.decor().isEmpty());
        assertEquals(0, item(env.cosmetics.shop(b), "HOUSE_BLOSSOM").owned());
        assertEquals(404, rejected(() -> env.cosmetics.equip(b, key(), new CosmeticEquipRequest("HOUSE", "HOUSE_BLOSSOM"))).status);
        assertEquals(404, rejected(() -> env.cosmetics.move(b, key(), decor, new DecorMoveRequest(10.0, 25.25))).status);
        assertEquals(404, rejected(() -> env.cosmetics.store(b, key(), decor)).status);
        assertEquals(404, rejected(() -> env.cosmetics.place(b, key(), new DecorPlaceRequest("DECOR_LANTERN_STONE", 10.0, 25.25))).status);
        assertEquals(1, env.state.state(a).cosmetics().decor().size(), "untouched");
        // a user without garden access gets 404 everywhere
        long stranger = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id) VALUES (?)", stranger);
        assertEquals(404, rejected(() -> env.cosmetics.shop(stranger)).status);
        assertEquals(404, rejected(() -> env.cosmetics.buy(stranger, key(), new CosmeticBuyRequest("PATH_COBBLE"))).status);
        assertEquals(0, count("SELECT count(*) FROM public.garden_profile WHERE user_id = ?", stranger));
    }

    // ------------------------------------------------------------------ art only

    @Test
    void wearingEveryCosmeticChangesNoGameplayValue() {
        long u = farmer(3_000_000);
        var before = env.state.state(u);
        for (String code : List.of("HOUSE_LONGPHUNG", "TREE_SAKURA", "SHRUB_BAMBOO", "FLOWER_LOTUS", "MONUMENT_DRAGON", "FENCE_LONGPHUNG", "PATH_JADE",
                "BED_LONGPHUNG", "DECOR_STATUE_DRAGON")) {
            env.cosmetics.buy(u, key(), new CosmeticBuyRequest(code));
        }
        for (String slot : com.englishcoach.garden.domain.CosmeticRules.SLOTS) {
            String code = env.ctx.cosmetics().items().values().stream().filter(i -> i.category().equals(slot))
                    .filter(i -> env.cosmeticRepo.quantity(u, i.code()) > 0).findFirst().orElseThrow().code();
            env.cosmetics.equip(u, key(), new CosmeticEquipRequest(slot, code));
        }
        env.cosmetics.place(u, key(), new DecorPlaceRequest("DECOR_STATUE_DRAGON", 10.0, 25.75));
        var after = env.state.state(u);
        assertEquals(8, after.cosmetics().equipped().size());
        // everything that is gameplay is byte-identical: beds, crops and prices, boosts, tiers, market, orders, estate perks, farming rules, level
        assertEquals(env.ctx.write(before.plots()), env.ctx.write(after.plots()));
        assertEquals(env.ctx.write(before.crops()), env.ctx.write(after.crops()));
        assertEquals(env.ctx.write(before.boosts()), env.ctx.write(after.boosts()));
        assertEquals(env.ctx.write(before.tiers()), env.ctx.write(after.tiers()));
        assertEquals(env.ctx.write(before.economy()), env.ctx.write(after.economy()));
        assertEquals(env.ctx.write(before.estate().buildings()), env.ctx.write(after.estate().buildings()));
        assertEquals(env.ctx.write(before.estate().land()), env.ctx.write(after.estate().land()));
        assertEquals(env.ctx.write(before.farming().soil()), env.ctx.write(after.farming().soil()));
        assertEquals(before.profile().level(), after.profile().level());
        assertEquals(before.profile().totalXp(), after.profile().totalXp());
        assertEquals(env.ctx.write(before.living().monument()), env.ctx.write(after.living().monument()), "a dragon at the roots is not a learning milestone");
        assertEquals(0, env.ctx.repo.buildingLevels(u).getOrDefault("COTTAGE", 0), "a house family is not a building level");
        assertCoinsReconcile(u);
    }

    // ------------------------------------------------------------------ upgrade of an existing garden

    @Test
    void aGardenFromBeforeV86KeepsEverythingAndSimplyGainsAnEmptyWardrobe() {
        try (var old = new GardenTestEnv(START, "85")) {
            assertNull(old.ctx.cosmetics(), "without V86 there is no cosmetic catalogue");
            long u = newUser(old);
            var s0 = old.state.state(u);
            assertNull(s0.cosmetics());
            assertEquals("COSMETICS_CLOSED", rejected(() -> old.cosmetics.shop(u)).code);
            assertEquals("COSMETICS_CLOSED", rejected(() -> old.cosmetics.buy(u, key(), new CosmeticBuyRequest("PATH_COBBLE"))).code);
            assertEquals("CHECKOUT_DISABLED", rejected(() -> old.checkout.start(u, key(), new CosmeticCheckoutRequest("PATH_COBBLE"))).code);
            old.planting.plant(u, key(), s0.plots().getFirst().id(), new PlantRequest("WHEAT"));
            long coinsBefore = old.jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, u);
            String ledgerBefore = old.jdbc.queryForObject("SELECT md5(string_agg(id || ':' || delta, ',' ORDER BY id)) FROM public.garden_ledger WHERE user_id = ?", String.class, u);
            int skinsBefore = old.jdbc.queryForObject("SELECT count(*) FROM public.garden_skin_def", Integer.class);

            var up = new GardenTestEnv(old, old.clock.now, "86");   // the release: same database, V86 applied, rules reloaded
            up.props.getAllowlistUserIds().add(u);
            var s1 = up.state.state(u);
            assertNotNull(s1.cosmetics());
            assertTrue(s1.cosmetics().equipped().isEmpty());
            assertTrue(s1.cosmetics().decor().isEmpty());
            assertEquals(10, s1.cosmetics().regions().size());
            assertEquals(coinsBefore, up.jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, u));
            assertEquals(ledgerBefore, up.jdbc.queryForObject("SELECT md5(string_agg(id || ':' || delta, ',' ORDER BY id)) FROM public.garden_ledger WHERE user_id = ?", String.class, u));
            assertEquals(skinsBefore + 50, up.jdbc.queryForObject("SELECT count(*) FROM public.garden_skin_def", Integer.class));
            assertEquals(1, s1.plots().stream().filter(p -> p.planting() != null).count(), "the wheat is still growing");
            assertEquals(0, up.jdbc.queryForObject("SELECT count(*) FROM public.garden_cosmetic_owned", Integer.class), "V86 writes nothing for a player");
            assertEquals(65, up.cosmetics.shop(u).items().size());
        }
    }

    // The direct-purchase tests moved to GardenPhase3FPersistenceTest: since V87 a cosmetic order is paid through the
    // existing SePay path and has a payment row, so it is qualified on the V87 schema.
}
