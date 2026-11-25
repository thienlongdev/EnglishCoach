package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenDtos.SupplyLine;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.LedgerService;
import com.englishcoach.garden.infra.GardenRulesLoader;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3A on real PostgreSQL 17 + the real migrations through V80 ({@link GardenTestEnv}): market purchases, delivery
 * orders and bed expansion — authority, idempotency, caps, concurrency, expiry, isolation, frozen orders, ledger
 * reconciliation, and a new bed used by the unchanged planting / harvest pipeline. Each test uses its own user ids.
 */
class GardenPhase3PersistenceTest {

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static LedgerService ledger;
    static final AtomicLong USERS = new AtomicLong(30_000);

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(Instant.parse("2026-10-09T03:00:00Z")); // 10:00 Vietnam, Lữ Hành week
        jdbc = env.jdbc;
        ledger = new LedgerService(env.ctx);
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    static long newUser() {
        long id = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id) VALUES (?)", id);
        env.props.getAllowlistUserIds().add(id);
        return id;
    }

    static UUID key() {
        return UUID.randomUUID();
    }

    static GardenException rejected(Runnable r) {
        return assertThrows(GardenException.class, r::run);
    }

    /** Test fixture through the ledger (keeps every balance reconciled): XP to reach a level, coins, produce. */
    static void grantXp(long user, long xp) {
        ledger.addXp(user, xp, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
    }

    static void grantCoins(long user, long coins) {
        ledger.addCoins(user, coins, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
    }

    static void grantProduce(long user, String crop, String tier, int qty) {
        ledger.addItem(user, "CROP:" + crop, tier, qty, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
    }

    static long xpForLevel(int level) {
        return env.ctx.engine().levels().totalXpForLevel(level);
    }

    static long coins(long user) {
        return jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static int qty(long user, String item, String tier) {
        var rows = jdbc.queryForList("SELECT qty FROM public.garden_inventory WHERE user_id = ? AND item_code = ? AND tier = ?",
                Integer.class, user, item, tier);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    static long totalXp(long user) {
        return jdbc.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static void assertLedgerReconciles(long user) {
        assertEquals(coins(user), sum(user, "COIN", "NA"), "coins reconcile");
        assertEquals(totalXp(user), sum(user, "XP", "NA"), "xp reconcile");
        jdbc.query("SELECT item_code, tier, qty FROM public.garden_inventory WHERE user_id = ?", rs -> {
            assertEquals(rs.getLong("qty"), sum(user, rs.getString("item_code"), rs.getString("tier")), rs.getString("item_code"));
        }, user);
    }

    static long sum(long user, String asset, String tier) {
        Long s = jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND asset = ? AND tier = ?",
                Long.class, user, asset, tier);
        return s == null ? 0 : s;
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

    // ================================================================================ configuration

    @Test
    void v80SeedsExactlyTheDocumentedEconomy() {
        var loader = new GardenRulesLoader(jdbc, env.json);
        var rules = loader.load();
        assertTrue(GardenTestRules.equivalent(GardenTestRules.seeded(), rules), "V77 + V78 + V80 rules == fixture (harvest band 90)");
        assertEquals(GardenTestRules.economy(), loader.loadEconomy(rules), "V80 economy == GardenTestRules.economy()");
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid "
                + "WHERE t.relname IN ('garden_order','garden_market_purchase') AND c.contype = 'f' AND c.confdeltype <> 'r'", Integer.class),
                "new owner FKs restrict deletion");
    }

    // ================================================================================ market

    @Test
    void marketPurchaseIsAuthoritativeIdempotentAndReconciled() {
        long u = newUser();
        var s = env.state.state(u);
        var offers = s.economy().market().offers();
        assertEquals("ITEM:FERTILIZER", offers.getFirst().code());
        assertTrue(offers.stream().anyMatch(o -> o.code().equals("ITEM:FERTILIZER_PREMIUM") && o.locked()), "premium unlocks at level 5");
        UUID k = key();
        var receipt = env.economy.buy(u, k, new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER", 1));
        assertEquals(120, receipt.coinsPaid());
        assertEquals(80, receipt.coins());
        assertEquals(2, receipt.itemQty(), "starter fertilizer + 1");
        var replay = env.economy.buy(u, k, new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER", 1));
        assertEquals(receipt.coins(), replay.coins(), "same key = same receipt");
        assertEquals(80, coins(u), "never charged twice");
        assertEquals(422, rejected(() -> env.economy.buy(u, k, new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER", 2))).status,
                "same key with a changed payload is refused");
        assertEquals(1, jdbc.queryForObject("SELECT units FROM public.garden_market_purchase WHERE user_id = ?", Integer.class, u));
        assertLedgerReconciles(u);
    }

    @Test
    void capsLevelsFundsAndStaleOffersAreEnforcedWithoutSideEffects() {
        long u = newUser();
        env.state.state(u);
        grantCoins(u, 5000);
        env.economy.buy(u, key(), new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER", 2));
        var cap = rejected(() -> env.economy.buy(u, key(), new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER", 1)));
        assertEquals("MARKET_CAP", cap.code);
        assertEquals(0, cap.details.get("remaining"));
        assertEquals("OFFER_LOCKED", rejected(() -> env.economy.buy(u, key(), new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER_PREMIUM", 1))).code);
        assertEquals("OFFER_UNAVAILABLE", rejected(() -> env.economy.buy(u, key(), new GardenDtos.MarketBuyRequest("ITEM:WATER", 1))).code,
                "water is never on sale");
        assertEquals("OFFER_UNAVAILABLE", rejected(() -> env.economy.buy(u, key(), new GardenDtos.MarketBuyRequest("PACK:CRYSTAL_ORCHID", 1))).code);
        assertEquals(400, rejected(() -> env.economy.buy(u, key(), new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER", 9))).status,
                "more than maxPerPurchase");
        // insufficient funds: nothing is counted, nothing credited (the whole transaction rolls back)
        long poor = newUser();
        env.state.state(poor);
        grantXp(poor, xpForLevel(5));
        jdbc.update("UPDATE public.garden_profile SET coins = 100 WHERE user_id = ?", poor); // test-only setup (outside the ledger)
        var funds = rejected(() -> env.economy.buy(poor, key(), new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER_PREMIUM", 1)));
        assertEquals("INSUFFICIENT_FUNDS", funds.code);
        assertEquals(160L, ((Number) funds.details.get("missing")).longValue());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_market_purchase WHERE user_id = ?", Integer.class, poor));
        assertEquals(0, qty(poor, "FERTILIZER_PREMIUM", "NA"));
        assertLedgerReconciles(u);
    }

    @Test
    void concurrentTabsCanNeverExceedTheDailyCap() throws Exception {
        long u = newUser();
        env.state.state(u);
        grantXp(u, xpForLevel(8));
        grantCoins(u, 10_000);
        var results = race(6, () -> env.economy.buy(u, key(), new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER", 1)));
        long ok = results.stream().filter(r -> r instanceof GardenDtos.MarketReceipt).count();
        assertEquals(2, ok, "exactly the cap succeeds");
        assertTrue(results.stream().filter(r -> !(r instanceof GardenDtos.MarketReceipt))
                .allMatch(r -> r instanceof GardenException g && g.code.equals("MARKET_CAP")));
        assertEquals(10_200 - 240, coins(u));
        UUID same = key();
        var dup = race(5, () -> env.economy.buy(u, same, new GardenDtos.MarketBuyRequest("PACK:" + featuredCommon(u), 1)));
        assertTrue(dup.stream().allMatch(r -> r instanceof GardenDtos.MarketReceipt), "a duplicated packet replays the receipt: " + dup);
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'MARKET_BUY' AND asset LIKE 'SEED:%'",
                Integer.class, u), "one purchase for one key");
        assertLedgerReconciles(u);
    }

    /** A featured pack this user may buy today (callers raise the level first so the fixture day's packs are unlocked). */
    static String featuredCommon(long u) {
        var s = env.state.state(u);
        return s.economy().market().offers().stream().filter(o -> o.kind().equals("PACK") && !o.locked())
                .map(GardenDtos.OfferView::cropCode).findFirst()
                .orElseThrow(() -> new IllegalStateException("fixture day has no unlocked pack at this level"));
    }

    @Test
    void aBoughtPackIsPlantedFromInventoryWithoutASecondCharge() {
        long u = newUser();
        env.state.state(u);
        grantXp(u, xpForLevel(8));
        grantCoins(u, 2000);
        String crop = featuredCommon(u);
        var receipt = env.economy.buy(u, key(), new GardenDtos.MarketBuyRequest("PACK:" + crop, 1));
        assertEquals(5, receipt.itemsGained());
        long before = coins(u);
        var s = env.state.state(u);
        var plant = env.planting.plant(u, key(), s.plots().getFirst().id(), new GardenDtos.PlantRequest(crop));
        assertEquals(0, plant.coinsPaid(), "the held seed is used first (R1): zero accidental double purchase");
        assertEquals(before, coins(u));
        assertEquals(qty(u, "SEED:" + crop, "NA"), plant.seedsLeft());
        assertLedgerReconciles(u);
    }

    // ================================================================================ orders

    @Test
    void ordersAreMaterializedOncePerPeriodAndFrozen() {
        long u = newUser();
        var s1 = env.state.state(u);
        var board = s1.economy().board().slots();
        assertEquals(3, board.size());
        assertTrue(board.get(2).locked(), "weekly slot locked below level 3");
        var open = board.stream().filter(b -> b.order() != null).toList();
        assertEquals(2, open.size(), "two daily orders at level 1");
        var s2 = env.state.state(u);
        assertEquals(open.stream().map(b -> b.order().id()).toList(),
                s2.economy().board().slots().stream().filter(b -> b.order() != null).limit(2).map(b -> b.order().id()).toList(),
                "a refresh / second device sees the same orders");
        grantXp(u, xpForLevel(6));
        var s3 = env.state.state(u);
        var daily = s3.economy().board().slots().getFirst().order();
        assertEquals(open.getFirst().order().lines(), daily.lines().stream().map(l -> new GardenDtos.OrderLineView(l.cropCode(),
                l.nameVi(), l.qty(), l.minTier(), 0)).toList(), "a level-up never rerolls a frozen order");
        assertNotNull(s3.economy().board().slots().get(2).order(), "the weekly order appears once the level allows");
        assertEquals(3, jdbc.queryForObject("SELECT count(*) FROM public.garden_order WHERE user_id = ?", Integer.class, u));
        long id = daily.id();
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_order SET base_coins = 999999 WHERE id = ?", id), "frozen");
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_order WHERE id = ?", id), "never deleted");
        // next Vietnam day: a fresh pair of daily orders; yesterday's stays as history, nothing is lost
        env.clock.advance(Duration.ofDays(1));
        var s4 = env.state.state(u);
        assertNotEquals(id, s4.economy().board().slots().getFirst().order().id());
        env.clock.advance(Duration.ofDays(-1));
    }

    @Test
    void aDeliveryConsumesExactlyTheLinesOncePaysAndRecordsOneReceipt() throws Exception {
        long u = newUser();
        var s = env.state.state(u);
        var order = s.economy().board().slots().getFirst().order();
        for (var l : order.lines()) grantProduce(u, l.cropCode(), "NORMAL", l.qty() + 2);
        var fresh = env.state.state(u).economy().board().slots().getFirst().order();
        assertTrue(fresh.fillable());
        var lines = fresh.preview().stream().map(p -> new SupplyLine(p.cropCode(), p.tier(), p.qty())).toList();
        long coinsBefore = coins(u), xpBefore = totalXp(u);
        UUID k = key();
        var receipt = env.economy.fill(u, k, order.id(), new GardenDtos.OrderFillRequest(lines));
        assertEquals(order.baseCoins(), receipt.coinsPaid(), "no blessing today: base coins");
        assertFalse(receipt.blessing());
        assertEquals(coinsBefore + order.baseCoins(), coins(u));
        assertEquals(xpBefore, totalXp(u), "orders grant no XP");
        for (var l : order.lines()) assertEquals(2, qty(u, "CROP:" + l.cropCode(), "NORMAL"), "exactly the required units");
        for (var b : order.bonus().entrySet()) assertEquals(b.getValue(), qty(u, b.getKey(), "NA"));
        var replay = env.economy.fill(u, k, order.id(), new GardenDtos.OrderFillRequest(lines));
        assertEquals(receipt.coins(), replay.coins(), "a retry returns the same receipt");
        assertEquals("ORDER_DONE", rejected(() -> env.economy.fill(u, key(), order.id(), new GardenDtos.OrderFillRequest(lines))).code);
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'ORDER' AND asset = 'COIN'",
                Integer.class, u));
        var after = env.state.state(u).economy().board();
        assertEquals("FILLED", after.slots().getFirst().order().status());
        assertEquals(1, after.filledTotal());
        assertEquals(order.lines().stream().mapToInt(GardenDtos.OrderLineView::qty).sum(),
                after.deliveryRecord().values().stream().mapToInt(Integer::intValue).sum());
        assertLedgerReconciles(u);
    }

    @Test
    void mismatchedLowTierForeignAndExpiredDeliveriesConsumeNothing() {
        long u = newUser();
        var s = env.state.state(u);
        var order = s.economy().board().slots().getFirst().order();
        var first = order.lines().getFirst();
        for (var l : order.lines()) grantProduce(u, l.cropCode(), "NORMAL", l.qty());
        List<SupplyLine> exact = order.lines().stream().map(l -> new SupplyLine(l.cropCode(), "NORMAL", l.qty())).toList();
        List<SupplyLine> short1 = new ArrayList<>(exact);
        short1.set(0, new SupplyLine(first.cropCode(), "NORMAL", first.qty() - 1 > 0 ? first.qty() - 1 : first.qty() + 1));
        assertEquals("ORDER_LINES_MISMATCH", rejected(() -> env.economy.fill(u, key(), order.id(), new GardenDtos.OrderFillRequest(short1))).code);
        List<SupplyLine> extra = new ArrayList<>(exact);
        extra.add(new SupplyLine("PUMPKIN".equals(first.cropCode()) ? "WHEAT" : "PUMPKIN", "NORMAL", 1));
        assertEquals("ORDER_LINES_MISMATCH", rejected(() -> env.economy.fill(u, key(), order.id(), new GardenDtos.OrderFillRequest(extra))).code);
        long other = newUser();
        env.state.state(other);
        assertEquals(404, rejected(() -> env.economy.fill(other, key(), order.id(), new GardenDtos.OrderFillRequest(exact))).status,
                "another learner's order does not exist for them");
        long coinsBefore = coins(u);
        env.clock.advance(Duration.ofHours(15)); // 01:00 next Vietnam day: the daily order expired
        try {
            assertEquals("ORDER_EXPIRED", rejected(() -> env.economy.fill(u, key(), order.id(), new GardenDtos.OrderFillRequest(exact))).code);
        } finally {
            env.clock.advance(Duration.ofHours(-15));
        }
        assertEquals(coinsBefore, coins(u));
        for (var l : order.lines()) assertEquals(l.qty(), qty(u, "CROP:" + l.cropCode(), "NORMAL"), "held crops are never erased");
        assertThrows(Exception.class, () -> jdbc.update("""
                UPDATE public.garden_order SET status = 'FILLED', filled_at = expires_at, paid_coins = 1, blessing = false,
                    delivered = '[]', fill_op = gen_random_uuid() WHERE id = ?""", order.id()), "the DB refuses a delivery at / after expiry");
        assertLedgerReconciles(u);
    }

    @Test
    void weeklyGoodLinesRefuseNormalProduceAndTheBlessingMultipliesThePayout() {
        long u = newUser();
        env.state.state(u);
        grantXp(u, xpForLevel(8));
        var weekly = env.state.state(u).economy().board().slots().get(2).order();
        var good = weekly.lines().getFirst();
        assertEquals("GOOD", good.minTier());
        for (var l : weekly.lines()) {
            grantProduce(u, l.cropCode(), "NORMAL", l.qty());
            grantProduce(u, l.cropCode(), "GOOD", l.qty());
        }
        List<SupplyLine> normal = weekly.lines().stream().map(l -> new SupplyLine(l.cropCode(), "NORMAL", l.qty())).toList();
        assertEquals("ORDER_TIER_TOO_LOW", rejected(() -> env.economy.fill(u, key(), weekly.id(), new GardenDtos.OrderFillRequest(normal))).code);
        // the day's goal reached a moment ago → the Echo Blessing is active for this delivery, exactly like a sale
        for (int i = 1; i <= 20; i++) {
            jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', ?, ?)",
                    u, (90_000 + i) + ":1", Timestamp.from(env.clock.now.plusMillis(i)));
        }
        env.clock.advance(Duration.ofSeconds(5));
        List<SupplyLine> ok = weekly.lines().stream().map(l -> new SupplyLine(l.cropCode(), l.minTier().equals("GOOD") ? "GOOD" : "NORMAL", l.qty())).toList();
        var receipt = env.economy.fill(u, key(), weekly.id(), new GardenDtos.OrderFillRequest(ok));
        assertTrue(receipt.blessing());
        assertEquals((long) Math.floor(weekly.baseCoins() * 1.5 + 1e-9), receipt.coinsPaid());
        assertEquals(1, qty(u, "FERTILIZER_PREMIUM", "NA"), "weekly bonus");
        assertLedgerReconciles(u);
    }

    @Test
    void concurrentDeliveriesFromTwoTabsSucceedOnce() throws Exception {
        long u = newUser();
        var order = env.state.state(u).economy().board().slots().getFirst().order();
        for (var l : order.lines()) grantProduce(u, l.cropCode(), "NORMAL", l.qty() * 3);
        List<SupplyLine> exact = order.lines().stream().map(l -> new SupplyLine(l.cropCode(), "NORMAL", l.qty())).toList();
        var results = race(4, () -> env.economy.fill(u, key(), order.id(), new GardenDtos.OrderFillRequest(exact)));
        assertEquals(1, results.stream().filter(r -> r instanceof GardenDtos.OrderReceipt).count(), "one delivery: " + results);
        for (var l : order.lines()) assertEquals(l.qty() * 2, qty(u, "CROP:" + l.cropCode(), "NORMAL"), "consumed exactly once");
        assertLedgerReconciles(u);
    }

    // ================================================================================ expansion

    @Test
    void bedsOpenInOrderWithLevelCoinsAndCompostExactlyOnce() throws Exception {
        long u = newUser();
        env.state.state(u);
        List<SupplyLine> wheat = List.of(new SupplyLine("WHEAT", "NORMAL", 8));
        assertEquals("EXPANSION_LEVEL", rejected(() -> env.economy.expand(u, key(), new GardenDtos.ExpandRequest(7, wheat))).code);
        grantXp(u, xpForLevel(5));
        assertEquals("EXPANSION_ORDER", rejected(() -> env.economy.expand(u, key(), new GardenDtos.ExpandRequest(8, List.of()))).code);
        assertEquals("COMPOST_MISMATCH", rejected(() -> env.economy.expand(u, key(),
                new GardenDtos.ExpandRequest(7, List.of(new SupplyLine("WHEAT", "NORMAL", 7))))).code, "compost must be exact");
        assertEquals("INSUFFICIENT_FUNDS", rejected(() -> env.economy.expand(u, key(), new GardenDtos.ExpandRequest(7, wheat))).code);
        grantCoins(u, 3000);
        assertEquals("NO_ITEM", rejected(() -> env.economy.expand(u, key(), new GardenDtos.ExpandRequest(7, wheat))).code,
                "naming produce the player does not hold fails, and the coin debit rolls back");
        assertEquals(3200, coins(u));
        grantProduce(u, "WHEAT", "NORMAL", 5);
        grantProduce(u, "WHEAT", "GOOD", 5);
        List<SupplyLine> mixed = List.of(new SupplyLine("WHEAT", "NORMAL", 5), new SupplyLine("WHEAT", "GOOD", 3));
        assertEquals(5, qty(u, "CROP:WHEAT", "NORMAL"), "refused purchases consumed nothing");
        var results = race(4, () -> env.economy.expand(u, key(), new GardenDtos.ExpandRequest(7, mixed)));
        var receipts = results.stream().filter(r -> r instanceof GardenDtos.ExpansionReceipt).map(r -> (GardenDtos.ExpansionReceipt) r).toList();
        assertEquals(1, receipts.size(), "exactly one purchase under concurrency: " + results);
        var receipt = receipts.getFirst();
        assertEquals(3000, receipt.coinsPaid());
        assertEquals(8, receipt.plot().gridX());
        assertEquals(16, receipt.plot().gridY());
        assertEquals(7, receipt.plot().slot());
        assertEquals(0, qty(u, "CROP:WHEAT", "NORMAL"));
        assertEquals(2, qty(u, "CROP:WHEAT", "GOOD"));
        assertEquals("PLOT_ALREADY_OPEN", rejected(() -> env.economy.expand(u, key(), new GardenDtos.ExpandRequest(7, mixed))).code);
        var s = env.state.state(u);
        assertEquals(7, s.plots().size(), "six starter beds unchanged + bed 7");
        assertEquals(List.of(8, 9, 10, 8, 9, 10, 8), s.plots().stream().map(GardenDtos.PlotView::gridX).toList());
        assertEquals("OWNED", s.economy().expansion().plots().getFirst().status());
        assertEquals("NEXT", s.economy().expansion().plots().get(1).status());
        assertLedgerReconciles(u);
    }

    @Test
    void aNewBedUsesTheNormalPlantingAndHarvestPipelineAndStaysPrivate() throws Exception {
        long u = newUser();
        env.state.state(u);
        grantXp(u, xpForLevel(5));
        grantCoins(u, 3000);
        grantProduce(u, "WHEAT", "NORMAL", 8);
        var receipt = env.economy.expand(u, key(), new GardenDtos.ExpandRequest(7, List.of(new SupplyLine("WHEAT", "NORMAL", 8))));
        long plotId = receipt.plot().id();
        long other = newUser();
        env.state.state(other);
        assertEquals(404, rejected(() -> env.planting.plant(other, key(), plotId, new GardenDtos.PlantRequest("WHEAT"))).status,
                "another learner cannot use this bed");
        var planted = env.planting.plant(u, key(), plotId, new GardenDtos.PlantRequest("WHEAT"));
        assertEquals(7, planted.plot().slot());
        env.clock.advance(Duration.ofMinutes(25));
        try {
            var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(planted.plot().planting().id())));
            var res = env.harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
            assertEquals(plotId, res.harvests().getFirst().plotId());
            assertEquals(1, qty(u, "CROP:WHEAT", res.harvests().getFirst().tier()));
        } finally {
            env.clock.advance(Duration.ofMinutes(-25));
        }
        assertLedgerReconciles(u);
    }

    @Test
    void oldGardensAndReceiptsSurviveAndKeepWorking() {
        long u = newUser();
        var s = env.state.state(u);
        // a Phase 1 command receipt stored before Phase 3A replays unchanged
        UUID k = key();
        var plant = env.planting.plant(u, k, s.plots().getFirst().id(), new GardenDtos.PlantRequest("WHEAT"));
        var replay = env.planting.plant(u, k, s.plots().getFirst().id(), new GardenDtos.PlantRequest("WHEAT"));
        assertEquals(plant.plot().planting().id(), replay.plot().planting().id());
        assertEquals(6, env.state.state(u).plots().size(), "no bed appears without a purchase");
        assertEquals(Map.of(), env.state.state(u).economy().board().deliveryRecord());
    }
}
