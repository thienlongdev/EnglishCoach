package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenDtos.BuildingUpgradeRequest;
import com.englishcoach.garden.api.GardenDtos.BuildingView;
import com.englishcoach.garden.api.GardenDtos.CompostRequest;
import com.englishcoach.garden.api.GardenDtos.LandBuyRequest;
import com.englishcoach.garden.api.GardenDtos.RegionView;
import com.englishcoach.garden.api.GardenDtos.RewardView;
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
 * Phase 3C on real PostgreSQL 17 + the real migrations through V83 ({@link GardenTestEnv}): building upgrades, the
 * compost bin, farmland regions, staged Forgotten Pest damage with recovery by a genuine review, Echo Contribution
 * (once per fact, capped, account-isolated, append-only) and Echo Rewards (closed by default, atomic, idempotent,
 * limited, audited; entitlement rewards never redeemable). Each test uses its own user ids.
 */
class GardenPhase3CPersistenceTest {

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static LedgerService ledger;
    static final AtomicLong USERS = new AtomicLong(50_000);
    static final AtomicLong WORDS = new AtomicLong(50_000);

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

    // ------------------------------------------------------------------ helpers

    static long newUser() {
        long id = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id) VALUES (?)", id);
        env.props.getAllowlistUserIds().add(id);
        return id;
    }

    /** A garden past the tutorial at {@code level} (XP granted through the ledger so balances reconcile). */
    static long farmer(int level) {
        long u = newUser();
        env.state.state(u);
        jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", u);
        long xp = env.ctx.engine().levels().totalXpForLevel(level);
        if (xp > 0) ledger.addXp(u, xp, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        return u;
    }

    static UUID key() {
        return UUID.randomUUID();
    }

    static GardenException rejected(Runnable r) {
        return assertThrows(GardenException.class, r::run);
    }

    static void grantCoins(long user, long coins) {
        ledger.addCoins(user, coins, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
    }

    static void grantProduce(long user, String crop, String tier, int qty) {
        ledger.addItem(user, "CROP:" + crop, tier, qty, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
    }

    static long coins(long user) {
        return jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static int qty(long user, String item, String tier) {
        var rows = jdbc.queryForList("SELECT qty FROM public.garden_inventory WHERE user_id = ? AND item_code = ? AND tier = ?",
                Integer.class, user, item, tier);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    static void assertLedgerReconciles(long user) {
        assertEquals(coins(user), jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND asset = 'COIN'",
                Long.class, user), "coins reconcile");
        Integer orphan = jdbc.queryForObject("""
                SELECT count(*) FROM (SELECT asset, tier, sum(delta) s FROM public.garden_ledger WHERE user_id = ? AND asset NOT IN ('COIN','XP','ESSENCE')
                GROUP BY asset, tier) l LEFT JOIN public.garden_inventory i ON i.user_id = ? AND i.item_code = l.asset AND i.tier = l.tier
                WHERE COALESCE(i.qty, 0) <> l.s""", Integer.class, user, user);
        assertEquals(0, orphan, "inventory reconciles with the ledger");
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

    static long plotId(GardenDtos.State s, int slot) {
        return s.plots().stream().filter(p -> p.slot() == slot).findFirst().orElseThrow().id();
    }

    static BuildingView building(long user, String code) {
        return env.state.state(user).estate().buildings().stream().filter(b -> b.code().equals(code)).findFirst().orElseThrow();
    }

    static RegionView region(long user, String code) {
        return env.state.state(user).estate().land().regions().stream().filter(r -> r.code().equals(code)).findFirst().orElseThrow();
    }

    static RewardView reward(long user, String code) {
        return env.state.state(user).estate().rewards().rewards().stream().filter(r -> r.code().equals(code)).findFirst().orElseThrow();
    }

    /** Test fixture: a building already at a level (real play buys every level through the upgrade command). */
    static void buildingFixture(long user, String code, int level) {
        jdbc.update("INSERT INTO public.garden_building(user_id, code, level, upgraded_at, op_key) VALUES (?, ?, ?, now(), ?)",
                user, code, level, UUID.randomUUID());
    }

    /** One of the player's cards: {@code dueHoursAgo} null = never studied, negative = due in the future. */
    static long card(long user, String status, Double dueHoursAgo) {
        String word = "estate" + WORDS.incrementAndGet();
        long de = jdbc.queryForObject("INSERT INTO public.dictionary_entries(word, cefr, general_translation_vi) VALUES (?, 'A2', ?) RETURNING id",
                Long.class, word, "Nghĩa của " + word);
        Timestamp due = dueHoursAgo == null ? null : Timestamp.valueOf(LocalDateTime.now().minusMinutes(Math.round(dueHoursAgo * 60)));
        return jdbc.queryForObject("""
                INSERT INTO public.flashcards(user_id, dictionary_entry_id, status, next_review_date, review_count)
                VALUES (?, ?, ?, ?, ?) RETURNING id""", Long.class, user, de, status, due, dueHoursAgo == null ? 0 : 1);
    }

    /** What FlashcardService#reviewFlashcard records and does: one review-log row, and the card is due later again. */
    static void review(long user, long cardId, Instant at) {
        int n = jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = ? AND source_ref LIKE ?",
                Integer.class, user, cardId + ":%") + 1;
        jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', ?, ?)",
                user, cardId + ":" + n, Timestamp.from(at));
        jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP + interval '3 days' WHERE id = ?", cardId);
    }

    /** {@code days} verified learning days: every day five different cards are reviewed (the monument's own rule). */
    static void study(long user, List<Long> cards, int days) {
        for (int d = 0; d < days; d++) {
            env.clock.advance(Duration.ofDays(1));
            for (int i = 0; i < 5; i++) review(user, cards.get(i), env.clock.now.minusSeconds(600 - i));
        }
    }

    static List<Long> deck(long user) {
        List<Long> out = new ArrayList<>();
        for (int i = 0; i < 5; i++) out.add(card(user, "LEARNED", -72.0));
        return out;
    }

    /** Test fixture: the four Phase 3A beds (real play buys them through {@code /plots/expand}). */
    static void tenBeds(long user) {
        for (var p : GardenTestRules.economy().expansion().plots()) {
            jdbc.update("""
                    INSERT INTO public.garden_plot(user_id, kind, slot_index, grid_x, grid_y, unlocked_at) VALUES (?, 'CROP', ?, ?, ?, now())
                    ON CONFLICT DO NOTHING""", user, p.slot(), p.gx(), p.gy());
        }
    }

    /** Test fixture: delivered orders and closed harvests (real play fills orders and harvests crops). */
    static void farmFacts(long user, int orders, int harvests) {
        for (int i = 0; i < orders; i++) {
            jdbc.update("""
                    INSERT INTO public.garden_order(user_id, slot, kind, period_key, lines, base_coins, bonus, created_at, expires_at, status,
                        filled_at, paid_coins, blessing, delivered, fill_op)
                    VALUES (?, 1, 'DAILY', ?, '[{"cropCode":"WHEAT","qty":1,"minTier":"NORMAL"}]'::jsonb, 1, '{}'::jsonb,
                        now() - interval '2 hours', now() + interval '2 hours', 'FILLED', now() - interval '1 hour', 1, false,
                        '[{"cropCode":"WHEAT","tier":"NORMAL","qty":1}]'::jsonb, ?)""", user, "fx-" + user + "-" + i, UUID.randomUUID());
        }
        jdbc.update("""
                INSERT INTO public.garden_crop_mastery(user_id, crop_code, harvests, best_tier, seasons, tier, first_at, last_at)
                VALUES (?, 'WHEAT', ?, 0, 1, 2, now(), now())
                ON CONFLICT (user_id, crop_code) DO UPDATE SET harvests = EXCLUDED.harvests""", user, harvests);
    }

    static int contributionBalance(long user) {
        var rows = jdbc.queryForList("SELECT balance FROM public.garden_contribution WHERE user_id = ?", Integer.class, user);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    static int entryPoints(long user, String source) {
        return jdbc.queryForObject("SELECT COALESCE(sum(points), 0) FROM public.garden_contribution_entry WHERE user_id = ? AND source = ?",
                Integer.class, user, source);
    }

    static int entryCount(long user, String source) {
        return jdbc.queryForObject("SELECT count(*) FROM public.garden_contribution_entry WHERE user_id = ? AND source = ?",
                Integer.class, user, source);
    }

    // ================================================================================ configuration

    @Test
    void v83SeedsExactlyTheDocumentedEstateAndChangesNoEarlierRule() {
        var loader = new GardenRulesLoader(jdbc, env.json);
        var rules = loader.load();
        assertTrue(GardenTestRules.equivalent(GardenTestRules.seeded(), rules), "V83 changes no Phase 1-3A rule (the V78 pest key included)");
        assertEquals(GardenTestRules.economy(), loader.loadEconomy(rules), "V83 changes no Phase 3A economy rule");
        assertEquals(GardenTestRules.living(), loader.loadLiving(rules), "V82 rules + the one REWARD cultivar of V83");
        assertTrue(GardenTestRules.estateEquivalent(GardenTestRules.estate(), loader.loadEstate(rules)), "V83 seed == GardenTestRules.estate()");
        // the reward catalogue: exactly one deliverable reward; every entitlement reward is disabled with no delivery
        assertEquals(List.of("SKIN_WATERMELON_ECHO"),
                jdbc.queryForList("SELECT code FROM public.garden_reward_def WHERE enabled ORDER BY code", String.class));
        assertEquals(3, jdbc.queryForObject("""
                SELECT count(*) FROM public.garden_reward_def WHERE kind IN ('AVATAR_FRAME','AI_VOUCHER','PREMIUM_TRIAL')
                  AND NOT enabled AND delivery = 'UNAVAILABLE'""", Integer.class));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_reward_def SET enabled = TRUE WHERE code = 'PREMIUM_TRIAL'"),
                "the database refuses to enable a reward that has no delivery mechanism");
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_reward_def SET delivery = 'GARDEN_SKIN' WHERE code = 'AI_VOUCHER_FEEDBACK'"),
                "an entitlement reward cannot borrow the in-garden delivery");
        // every owner foreign key of the new tables is restrictive (no cascade)
        assertEquals(0, jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                WHERE t.relname IN ('garden_building','garden_contribution','garden_contribution_entry','garden_reward_redemption','garden_reward_counter')
                  AND c.contype = 'f' AND c.confdeltype <> 'r'""", Integer.class));
    }

    // ================================================================================ buildings

    @Test
    void aBuildingLevelNeedsLevelCoinsAndExactProduceAndIsBoughtExactlyOnce() {
        long u = farmer(4);
        var wheat16 = new BuildingUpgradeRequest(1, List.of(new SupplyLine("WHEAT", "NORMAL", 10), new SupplyLine("WHEAT", "GOOD", 6)));
        assertEquals("BUILDING_LEVEL", rejected(() -> env.estate.upgrade(u, key(), "WAREHOUSE", wheat16)).code);
        ledger.addXp(u, env.ctx.engine().levels().totalXpForLevel(5), "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        assertEquals("INSUFFICIENT_FUNDS", rejected(() -> env.estate.upgrade(u, key(), "WAREHOUSE", wheat16)).code);
        grantCoins(u, 20_000);
        long before = coins(u);
        assertEquals("NO_ITEM", rejected(() -> env.estate.upgrade(u, key(), "WAREHOUSE", wheat16)).code);
        assertEquals(before, coins(u), "a failed upgrade takes nothing (one transaction)");
        grantProduce(u, "WHEAT", "NORMAL", 10);
        grantProduce(u, "WHEAT", "GOOD", 10);
        assertEquals("MATERIALS_MISMATCH", rejected(() -> env.estate.upgrade(u, key(), "WAREHOUSE",
                new BuildingUpgradeRequest(1, List.of(new SupplyLine("WHEAT", "NORMAL", 10), new SupplyLine("WHEAT", "GOOD", 5))))).code);
        assertEquals("MATERIALS_MISMATCH", rejected(() -> env.estate.upgrade(u, key(), "WAREHOUSE",
                new BuildingUpgradeRequest(1, List.of(new SupplyLine("WHEAT", "NORMAL", 10), new SupplyLine("WHEAT", "GOOD", 6),
                        new SupplyLine("TOMATO", "NORMAL", 1))))).code);
        assertEquals("BUILDING_ORDER", rejected(() -> env.estate.upgrade(u, key(), "WAREHOUSE", new BuildingUpgradeRequest(2, wheat16.materials()))).code);
        assertEquals(404, rejected(() -> env.estate.upgrade(u, key(), "CASTLE", wheat16)).status);
        assertEquals(before, coins(u));

        UUID k = key();
        var receipt = env.estate.upgrade(u, k, "WAREHOUSE", wheat16);
        assertEquals(1, receipt.level());
        assertEquals(12_000, receipt.coinsPaid());
        assertEquals(before - 12_000, coins(u));
        assertEquals(0, qty(u, "CROP:WHEAT", "NORMAL"));
        assertEquals(4, qty(u, "CROP:WHEAT", "GOOD"));
        assertEquals(receipt.coins(), env.estate.upgrade(u, k, "WAREHOUSE", wheat16).coins(), "replay returns the stored receipt");
        assertEquals(before - 12_000, coins(u), "charged once");
        assertEquals(422, rejected(() -> env.estate.upgrade(u, k, "COTTAGE", wheat16)).status, "a key cannot be reused for another payload");
        assertEquals("BUILDING_ORDER", rejected(() -> env.estate.upgrade(u, key(), "WAREHOUSE", wheat16)).code, "level 1 is bought once");
        var view = building(u, "WAREHOUSE");
        assertEquals(1, view.level());
        assertEquals(2, view.next().level());
        assertEquals(2.0, view.effects().stream().filter(x -> x.code().equals("compostDaily")).findFirst().orElseThrow().value());
        assertEquals(0, building(u, "COTTAGE").level());
        assertLedgerReconciles(u);
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'BUILDING' AND asset = 'COIN'", Integer.class, u));
        // the database itself refuses a skipped level, a lowered level and a delete
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_building SET level = 3 WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_building SET level = 0 WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_building WHERE user_id = ?", u));
        // another garden is untouched
        long other = farmer(9);
        assertEquals(0, building(other, "WAREHOUSE").level());
    }

    @Test
    void concurrentUpgradesOfOneBuildingChargeOnce() throws Exception {
        long u = farmer(7);
        grantCoins(u, 100_000);
        grantProduce(u, "TOMATO", "NORMAL", 30);
        grantProduce(u, "CORN", "NORMAL", 30);
        long before = coins(u);
        var req = new BuildingUpgradeRequest(1, List.of(new SupplyLine("TOMATO", "NORMAL", 12), new SupplyLine("CORN", "NORMAL", 8)));
        var results = race(6, () -> env.estate.upgrade(u, key(), "MARKET", req));
        assertEquals(1, results.stream().filter(r -> r instanceof GardenDtos.BuildingReceipt).count(), "exactly one request buys the level");
        assertTrue(results.stream().filter(r -> r instanceof GardenException).allMatch(r -> ((GardenException) r).code.equals("BUILDING_ORDER")));
        assertEquals(before - 25_000, coins(u));
        assertEquals(18, qty(u, "CROP:TOMATO", "NORMAL"));
        assertEquals(1, jdbc.queryForObject("SELECT level FROM public.garden_building WHERE user_id = ? AND code = 'MARKET'", Integer.class, u));
        assertLedgerReconciles(u);
    }

    @Test
    void theStorehouseCompostsSurplusProduceWithinItsDailyCapAndNeverCapsInventory() {
        long u = farmer(6);
        grantProduce(u, "WHEAT", "NORMAL", 5_000); // far more than any "capacity": nothing is ever refused or taken
        grantProduce(u, "TOMATO", "GOOD", 40);
        var batch = new CompostRequest("STANDARD", List.of(new SupplyLine("WHEAT", "NORMAL", 8)));
        assertEquals("COMPOST_LOCKED", rejected(() -> env.estate.compost(u, key(), batch)).code, "no storehouse yet");
        buildingFixture(u, "WAREHOUSE", 1);
        assertEquals(5_000, qty(u, "CROP:WHEAT", "NORMAL"), "a storehouse never confiscates stock");
        int fert = qty(u, "FERTILIZER", "NA");
        assertEquals("COMPOST_UNITS", rejected(() -> env.estate.compost(u, key(), new CompostRequest("STANDARD", List.of(new SupplyLine("WHEAT", "NORMAL", 7))))).code);
        assertEquals("COMPOST_LOCKED", rejected(() -> env.estate.compost(u, key(), new CompostRequest("PREMIUM", List.of(new SupplyLine("TOMATO", "GOOD", 12))))).code,
                "the premium recipe needs storehouse level 2");
        UUID k = key();
        var r = env.estate.compost(u, k, batch);
        assertEquals("FERTILIZER", r.item());
        assertEquals(1, r.usedToday());
        assertEquals(1, r.remaining());
        assertEquals(r.itemQty(), env.estate.compost(u, k, batch).itemQty(), "replay");
        assertEquals(fert + 1, qty(u, "FERTILIZER", "NA"), "one fertilizer, once");
        assertEquals(4_992, qty(u, "CROP:WHEAT", "NORMAL"));
        env.estate.compost(u, key(), batch);
        assertEquals("COMPOST_CAP", rejected(() -> env.estate.compost(u, key(), batch)).code, "two batches a day at level 1");
        assertEquals(4_984, qty(u, "CROP:WHEAT", "NORMAL"), "a refused batch consumes nothing");
        var view = env.state.state(u).estate().compost().getFirst();
        assertEquals(2, view.usedToday());
        assertEquals(0, view.remaining());
        env.clock.advance(Duration.ofDays(1));
        env.estate.compost(u, key(), batch);
        assertEquals(fert + 3, qty(u, "FERTILIZER", "NA"), "the cap is per Vietnam day");
        // level 2: the premium recipe asks GOOD or better
        jdbc.update("UPDATE public.garden_building SET level = 2 WHERE user_id = ? AND code = 'WAREHOUSE'", u);
        assertEquals("COMPOST_TIER_TOO_LOW", rejected(() -> env.estate.compost(u, key(), new CompostRequest("PREMIUM", List.of(new SupplyLine("WHEAT", "NORMAL", 12))))).code);
        int premium = qty(u, "FERTILIZER_PREMIUM", "NA");
        env.estate.compost(u, key(), new CompostRequest("PREMIUM", List.of(new SupplyLine("TOMATO", "GOOD", 12))));
        assertEquals(premium + 1, qty(u, "FERTILIZER_PREMIUM", "NA"));
        assertEquals("COMPOST_CAP", rejected(() -> env.estate.compost(u, key(), new CompostRequest("PREMIUM", List.of(new SupplyLine("TOMATO", "GOOD", 12))))).code);
        assertEquals(400, rejected(() -> env.estate.compost(u, key(), new CompostRequest("STANDARD", List.of(new SupplyLine("QA_SPROUT", "NORMAL", 8))))).status,
                "the QA crop is never compost");
        assertLedgerReconciles(u);
    }

    @Test
    void marketAndCottageLevelsChangeOnlyTheirBoundedPerks() {
        long u = farmer(8);
        var s0 = env.state.state(u);
        long packs0 = s0.economy().market().offers().stream().filter(o -> o.kind().equals("PACK")).count();
        int forecast0 = s0.world().forecast().size();
        var fert0 = s0.economy().market().offers().stream().filter(o -> o.code().equals("ITEM:FERTILIZER")).findFirst().orElseThrow();
        // a ripe wheat: its freshness window before the cottage
        long plot = plotId(s0, 1);
        env.planting.plant(u, key(), plot, new GardenDtos.PlantRequest("WHEAT"));
        env.clock.advance(Duration.ofMinutes(30));
        var ripe0 = env.state.state(u).plots().stream().filter(p -> p.id() == plot).findFirst().orElseThrow().planting();
        Duration window0 = Duration.between(ripe0.readyAt(), ripe0.freshUntil());
        assertEquals(Duration.ofHours(2), window0);

        buildingFixture(u, "MARKET", 2);
        buildingFixture(u, "COTTAGE", 2);
        var s1 = env.state.state(u);
        var offers = s1.economy().market().offers();
        assertEquals(packs0 + 1, offers.stream().filter(o -> o.kind().equals("PACK")).count(), "one more featured pack");
        var fert1 = offers.stream().filter(o -> o.code().equals("ITEM:FERTILIZER")).findFirst().orElseThrow();
        assertEquals(fert0.price(), fert1.price(), "the price is unchanged");
        assertEquals(fert0.dailyCap() + 1, fert1.dailyCap(), "one more purchase a day");
        assertEquals(forecast0 + 2, s1.world().forecast().size(), "the almanac shows two more windows");
        assertTrue(s1.world().forecast().stream().skip(1).noneMatch(w -> w.kind().equals("RAINBOW")));
        var ripe1 = s1.plots().stream().filter(p -> p.id() == plot).findFirst().orElseThrow().planting();
        assertEquals(ripe0.readyAt(), ripe1.readyAt(), "growth is untouched");
        assertEquals(Duration.ofHours(3), Duration.between(ripe1.readyAt(), ripe1.freshUntil()), "+50 % freshness");
        // the raised cap is real and still a cap
        grantCoins(u, 5_000);
        for (int i = 0; i < 3; i++) env.economy.buy(u, key(), new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER", 1));
        assertEquals("MARKET_CAP", rejected(() -> env.economy.buy(u, key(), new GardenDtos.MarketBuyRequest("ITEM:FERTILIZER", 1))).code);
        // harvested 2 h 30 after ripening: fresh only thanks to the cottage
        env.clock.advance(Duration.ofMinutes(150));
        var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(ripe1.id())));
        var res = env.harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
        assertEquals(10, res.harvests().getFirst().components().fresh());
        assertLedgerReconciles(u);
    }

    // ================================================================================ land

    @Test
    void aRegionStaysLockedUntilItsFarmGateAndItsBedsAreBoughtInOrderExactlyOnce() {
        long u = farmer(12);
        grantCoins(u, 400_000);
        for (String c : List.of("CORN", "STRAWBERRY", "TOMATO", "ROSE")) grantProduce(u, c, "NORMAL", 40);
        var bed11 = new LandBuyRequest(11, List.of(new SupplyLine("CORN", "NORMAL", 12), new SupplyLine("STRAWBERRY", "NORMAL", 6)));
        long before = coins(u);
        var locked = rejected(() -> env.estate.buyLand(u, key(), bed11));
        assertEquals("LAND_REGION_LOCKED", locked.code);
        assertEquals("PLOTS", locked.details.get("reason"), "the ten earlier beds come first");
        tenBeds(u);
        assertEquals("ORDERS", rejected(() -> env.estate.buyLand(u, key(), bed11)).details.get("reason"));
        farmFacts(u, 10, 149);
        assertEquals("HARVESTS", rejected(() -> env.estate.buyLand(u, key(), bed11)).details.get("reason"));
        farmFacts(u, 0, 150);
        var view = region(u, "WEST_TILLED");
        assertTrue(view.open());
        assertEquals("NEXT", view.plots().get(0).status());
        assertEquals("LATER", view.plots().get(1).status());
        assertFalse(region(u, "WEST_FALLOW").open(), "the next region has its own gate");
        assertEquals("EXPANSION_ORDER", rejected(() -> env.estate.buyLand(u, key(),
                new LandBuyRequest(12, List.of(new SupplyLine("TOMATO", "NORMAL", 16), new SupplyLine("ROSE", "NORMAL", 6))))).code);
        assertEquals("MATERIALS_MISMATCH", rejected(() -> env.estate.buyLand(u, key(),
                new LandBuyRequest(11, List.of(new SupplyLine("CORN", "NORMAL", 12))))).code);
        assertEquals(404, rejected(() -> env.estate.buyLand(u, key(), new LandBuyRequest(7, List.of()))).status, "a V80 bed is not a regional bed");
        assertEquals(404, rejected(() -> env.estate.buyLand(u, key(), new LandBuyRequest(99, List.of()))).status);
        assertEquals(before, coins(u), "refusals take nothing");

        UUID k = key();
        var receipt = env.estate.buyLand(u, k, bed11);
        assertEquals(90_000, receipt.coinsPaid(), "no learning: the listed price");
        assertEquals(0.0, receipt.discount());
        assertEquals(11, receipt.plot().slot());
        assertEquals(6, receipt.plot().gridX());
        assertEquals(19, receipt.plot().gridY());
        assertEquals(receipt.coins(), env.estate.buyLand(u, k, bed11).coins(), "replay");
        assertEquals(before - 90_000, coins(u), "charged once");
        assertEquals("PLOT_ALREADY_OPEN", rejected(() -> env.estate.buyLand(u, key(), bed11)).code);
        assertEquals(28, qty(u, "CROP:CORN", "NORMAL"));
        assertEquals(11, env.state.state(u).plots().size());
        assertEquals(11, env.state.state(u).estate().land().plotsOwned());
        assertEquals("NEXT", region(u, "WEST_TILLED").plots().get(1).status());
        assertLedgerReconciles(u);
        // another garden cannot see, plant on or buy through this bed
        long other = farmer(12);
        assertEquals(6, env.state.state(other).plots().size());
        assertEquals(404, rejected(() -> env.planting.plant(other, key(), receipt.plot().id(), new GardenDtos.PlantRequest("WHEAT"))).status);
    }

    @Test
    void concurrentPurchasesOfOneBedChargeOnce() throws Exception {
        long u = farmer(12);
        tenBeds(u);
        farmFacts(u, 10, 150);
        grantCoins(u, 500_000);
        grantProduce(u, "CORN", "NORMAL", 60);
        grantProduce(u, "STRAWBERRY", "NORMAL", 60);
        long before = coins(u);
        var req = new LandBuyRequest(11, List.of(new SupplyLine("CORN", "NORMAL", 12), new SupplyLine("STRAWBERRY", "NORMAL", 6)));
        var results = race(6, () -> env.estate.buyLand(u, key(), req));
        assertEquals(1, results.stream().filter(r -> r instanceof GardenDtos.LandReceipt).count());
        assertEquals(before - 90_000, coins(u));
        assertEquals(48, qty(u, "CROP:CORN", "NORMAL"));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_plot WHERE user_id = ? AND slot_index = 11", Integer.class, u));
        assertLedgerReconciles(u);
    }

    @Test
    void aLearnerPaysLessForLandAndAFarmOnlyPlayerCanStillBuy() {
        long learner = farmer(12);
        var cards = deck(learner);
        study(learner, cards, 21);
        tenBeds(learner);
        farmFacts(learner, 10, 150);
        grantCoins(learner, 200_000);
        grantProduce(learner, "CORN", "NORMAL", 12);
        grantProduce(learner, "STRAWBERRY", "NORMAL", 6);
        var land = env.state.state(learner).estate().land();
        assertEquals(21, land.learningDays());
        assertEquals(0.05, land.discount(), 1e-9);
        assertEquals(75, land.nextDiscountAt());
        var plot = land.regions().getFirst().plots().getFirst();
        assertEquals(85_500, plot.coins());
        assertEquals(90_000, plot.basePrice());
        long before = coins(learner);
        var receipt = env.estate.buyLand(learner, key(), new LandBuyRequest(11, plot.preview().stream()
                .map(p -> new SupplyLine(p.cropCode(), p.tier(), p.qty())).toList()));
        assertEquals(85_500, receipt.coinsPaid(), "the server applies the discount, never the client");
        assertEquals(before - 85_500, coins(learner));
        // the farm-only player (no learning day at all) meets the same gate with farm facts only
        long farmerOnly = farmer(12);
        tenBeds(farmerOnly);
        farmFacts(farmerOnly, 10, 150);
        grantCoins(farmerOnly, 200_000);
        grantProduce(farmerOnly, "CORN", "NORMAL", 12);
        grantProduce(farmerOnly, "STRAWBERRY", "NORMAL", 6);
        assertEquals(0, env.state.state(farmerOnly).estate().land().learningDays());
        assertEquals(90_000, env.estate.buyLand(farmerOnly, key(),
                new LandBuyRequest(11, List.of(new SupplyLine("CORN", "NORMAL", 12), new SupplyLine("STRAWBERRY", "NORMAL", 6)))).coinsPaid());
        assertLedgerReconciles(learner);
        assertLedgerReconciles(farmerOnly);
    }

    @Test
    void aRegionalBedUsesTheUnchangedFarmingPipeline() {
        long u = farmer(12);
        tenBeds(u);
        farmFacts(u, 10, 150);
        grantCoins(u, 200_000);
        grantProduce(u, "CORN", "NORMAL", 12);
        grantProduce(u, "STRAWBERRY", "NORMAL", 6);
        long plot = env.estate.buyLand(u, key(), new LandBuyRequest(11,
                List.of(new SupplyLine("CORN", "NORMAL", 12), new SupplyLine("STRAWBERRY", "NORMAL", 6)))).plot().id();
        int wheatHarvests = jdbc.queryForObject("SELECT harvests FROM public.garden_crop_mastery WHERE user_id = ? AND crop_code = 'WHEAT'", Integer.class, u);
        // the very first wheat of a garden is the 60-second tutorial crop (never a pest host): plant it on a starter bed
        env.planting.plant(u, key(), plotId(env.state.state(u), 1), new GardenDtos.PlantRequest("WHEAT"));
        long pid = env.planting.plant(u, key(), plot, new GardenDtos.PlantRequest("WHEAT")).plot().planting().id();
        assertEquals("PLOT_OCCUPIED", rejected(() -> env.planting.plant(u, key(), plot, new GardenDtos.PlantRequest("WHEAT"))).code);
        env.planting.boost(u, key(), pid, new GardenDtos.BoostRequest("WATER"));
        env.planting.boost(u, key(), pid, new GardenDtos.BoostRequest("FERTILIZER"));
        env.clock.advance(Duration.ofMinutes(40));
        // an overdue word settles on the new bed's crop exactly like on a starter bed
        long word = card(u, "LEARNED", 30.0);
        var pest = env.state.state(u).pests().getFirst();
        assertEquals(11, pest.plotSlot());
        assertEquals(1, pest.stage());
        review(u, word, env.clock.now);
        env.clock.advance(Duration.ofSeconds(30));
        var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(pid)));
        var res = env.harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
        var line = res.harvests().getFirst();
        assertEquals(25, line.components().pest());
        assertEquals(15, line.components().care());
        assertEquals(1, qty(u, "CROP:WHEAT", line.tier()));
        assertEquals(wheatHarvests + 1, jdbc.queryForObject("SELECT harvests FROM public.garden_crop_mastery WHERE user_id = ? AND crop_code = 'WHEAT'", Integer.class, u),
                "mastery counts the harvest of a regional bed");
        assertTrue(env.state.state(u).plots().stream().anyMatch(p -> p.slot() == 11 && p.planting() == null), "the bed is free again");
        assertLedgerReconciles(u);
    }

    @Test
    void aGardenFromBeforeV83KeepsEverythingAndSimplyGainsTheEstate() {
        long u = farmer(9);
        grantProduce(u, "WHEAT", "NORMAL", 300);
        grantProduce(u, "ROSE", "GOLDEN", 7);
        long coinsBefore = coins(u);
        long planted = env.planting.plant(u, key(), plotId(env.state.state(u), 2), new GardenDtos.PlantRequest("TOMATO")).plot().planting().id();
        var s = env.state.state(u);
        // nothing was created, charged or removed for a garden that never used Phase 3C
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_building WHERE user_id = ?", Integer.class, u));
        assertEquals(6, s.plots().size());
        assertEquals(300, qty(u, "CROP:WHEAT", "NORMAL"));
        assertEquals(7, qty(u, "CROP:ROSE", "GOLDEN"));
        assertTrue(coins(u) <= coinsBefore && coinsBefore - coins(u) <= 15, "only the tomato seed was paid");
        assertTrue(s.plots().stream().anyMatch(p -> p.planting() != null && p.planting().id() == planted && p.planting().pestStage() == null));
        assertTrue(s.estate().buildings().stream().allMatch(b -> b.level() == 0 && b.next() != null && b.next().level() == 1));
        assertEquals(3, s.estate().land().regions().size());
        assertTrue(s.estate().land().regions().stream().noneMatch(RegionView::open));
        assertEquals(24, s.estate().land().maxPlots());
        assertEquals(0, s.estate().contribution().balance());
        assertFalse(s.estate().rewards().open());
        assertLedgerReconciles(u);
    }

    // ================================================================================ Forgotten Pests

    @Test
    void masteredAndFreshCardsNeverBringAPestAndInfestationStaysCapped() {
        long u = farmer(3);
        var s = env.state.state(u);
        for (int slot = 1; slot <= 5; slot++) env.planting.plant(u, key(), plotId(s, slot), new GardenDtos.PlantRequest("CORN"));
        env.clock.advance(Duration.ofMinutes(40));
        card(u, "MASTERED", 500.0); // the scheduler never re-dues a mastered card: never a pest
        card(u, "LEARNED", 20.0);   // overdue, but inside the grace day
        card(u, "LEARNED", -5.0);   // due in the future
        card(u, "NEW", null);       // never studied
        assertTrue(env.state.state(u).pests().isEmpty(), "none of these is a genuinely overdue word");
        for (int i = 0; i < 6; i++) card(u, "LEARNED", 40.0 + i);
        var pests = env.state.state(u).pests();
        assertEquals(2, pests.size(), "at most two crops are infested at once, however many words are overdue");
        assertTrue(pests.stream().allMatch(p -> p.stage() == 1 && !p.slowing() && p.nextStageAt() != null), "every pest starts as a warning");
        for (int i = 0; i < 3; i++) env.state.state(u);
        assertEquals(2, jdbc.queryForObject("SELECT count(*) FROM public.garden_pest WHERE user_id = ?", Integer.class, u));
        var echo = env.state.state(u).living().echo();
        assertEquals("RESCUE", echo.code());
        assertEquals(1, echo.params().get("stage"));
    }

    @Test
    void aPestWarnsFirstThenDamagesLeavesThenWiltsAndAGenuineReviewRestoresTheCrop() {
        long u = farmer(10);
        var s = env.state.state(u);
        grantCoins(u, 1_000);
        long plot = plotId(s, 1);
        long twinPlot = plotId(s, 2);
        // two pumpkins planted at the same instant (6 h base): the older planting hosts the pest, its twin stays clean
        long pid = env.planting.plant(u, key(), plot, new GardenDtos.PlantRequest("PUMPKIN")).plot().planting().id();
        env.planting.plant(u, key(), twinPlot, new GardenDtos.PlantRequest("PUMPKIN"));
        env.clock.advance(Duration.ofMinutes(40));
        long word = card(u, "LEARNED", 30.0);
        var s1 = env.state.state(u);
        assertEquals(1, s1.pests().size());
        var warning = s1.pests().getFirst();
        Instant spawned = warning.spawnedAt();
        assertEquals(pid, warning.plantingId());
        assertEquals(1, warning.stage());
        assertFalse(warning.slowing());
        assertEquals(spawned.plus(Duration.ofHours(6)), warning.nextStageAt(), "the player is told when the damage would start");
        var planting1 = s1.plots().stream().filter(p -> p.id() == plot).findFirst().orElseThrow().planting();
        assertEquals(1, planting1.pestStage());

        env.clock.advance(Duration.ofHours(7));
        var s2 = env.state.state(u);
        assertEquals(2, s2.pests().getFirst().stage());
        assertTrue(s2.pests().getFirst().slowing());
        assertEquals(2, s2.living().echo().params().get("stage"));
        var planting2 = s2.plots().stream().filter(p -> p.id() == plot).findFirst().orElseThrow().planting();
        assertEquals(2, planting2.pestStage());

        env.clock.advance(Duration.ofHours(18)); // 25 h after the pest appeared
        var s3 = env.state.state(u);
        var wilt = s3.pests().getFirst();
        assertEquals(3, wilt.stage());
        assertNull(wilt.nextStageAt(), "wilting is the last stage");
        assertEquals(spawned.plus(Duration.ofHours(36)), wilt.effectEndsAt());
        var planting3 = s3.plots().stream().filter(p -> p.id() == plot).findFirst().orElseThrow().planting();
        assertEquals(3, planting3.pestStage());
        var twin = s3.plots().stream().filter(p -> p.id() == twinPlot).findFirst().orElseThrow().planting();
        assertTrue(planting3.ready(), "the crop still ripened: a pest never blocks the harvest");
        assertNull(twin.pestStage());
        assertTrue(planting3.readyAt().isAfter(twin.readyAt()), "the damage delayed it compared with its clean twin");
        assertTrue(Duration.between(twin.readyAt(), planting3.readyAt()).compareTo(Duration.ofHours(9)) <= 0, "by a bounded time");
        // spraying still needs the genuine review: no shortcut exists
        assertEquals("PEST_NEEDS_REVIEW", rejected(() -> env.pests.spray(u, key(), wilt.id())).code);
        assertEquals(0, jdbc.queryForObject("SELECT review_count FROM public.flashcards WHERE id = ?", Integer.class, word) - 1,
                "the garden never touched the Flashcard card");

        review(u, word, env.clock.now);
        env.clock.advance(Duration.ofSeconds(30));
        var s4 = env.state.state(u);
        // Phase 4: the genuine review is the whole cure, the pest leaves with it (no second action)
        assertTrue(s4.pests().isEmpty());
        assertNull(s4.plots().stream().filter(p -> p.id() == plot).findFirst().orElseThrow().planting().pestStage());
        var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(pid)));
        var res = env.harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
        assertEquals(25, res.harvests().getFirst().components().pest(), "the review restored the full pest score, even after wilting");
        assertLedgerReconciles(u);
    }

    @Test
    void anUnresolvedWiltingCropLosesOnlyThePestPartOfItsQualityAndNothingElse() {
        long u = farmer(3);
        var s = env.state.state(u);
        long pid = env.planting.plant(u, key(), plotId(s, 1), new GardenDtos.PlantRequest("TOMATO")).plot().planting().id();
        long control = env.planting.plant(u, key(), plotId(s, 2), new GardenDtos.PlantRequest("TOMATO")).plot().planting().id();
        env.clock.advance(Duration.ofMinutes(40));
        card(u, "LEARNED", 30.0);
        assertEquals(1, env.state.state(u).pests().size());
        env.clock.advance(Duration.ofHours(26));
        var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(pid, control)));
        var res = env.harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
        var infested = res.harvests().stream().filter(h -> h.plantingId() == pid).findFirst().orElseThrow();
        var clean = res.harvests().stream().filter(h -> h.plantingId() == control).findFirst().orElseThrow();
        assertEquals(0, infested.components().pest(), "wilting: the pest part is lost");
        assertEquals(25, clean.components().pest());
        assertEquals(clean.score() - 25, infested.score(), "nothing but the pest part differs");
        assertTrue(qty(u, "CROP:TOMATO", infested.tier()) >= 1, "the wilted crop is still harvested into the Kho");
        assertEquals(2, jdbc.queryForObject("SELECT COALESCE(sum(qty), 0) FROM public.garden_inventory WHERE user_id = ? AND item_code = 'CROP:TOMATO'", Integer.class, u),
                "both crops were harvested: nothing is destroyed");
        assertLedgerReconciles(u);
    }

    @Test
    void aLongAbsenceNeverDestroysACropAndTheReturnerRecoversIt() {
        long u = farmer(8);
        var s = env.state.state(u);
        long plot = plotId(s, 1);
        long pid = env.planting.plant(u, key(), plot, new GardenDtos.PlantRequest("CORN")).plot().planting().id();
        env.clock.advance(Duration.ofMinutes(40));
        long word = card(u, "LEARNED", 30.0);
        assertEquals(1, env.state.state(u).pests().size());
        int plotsBefore = env.state.state(u).plots().size();
        long coinsBefore = coins(u);
        long xpBefore = jdbc.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, u);

        env.clock.advance(Duration.ofDays(45)); // the player is away for six weeks
        var back = env.state.state(u);
        var planting = back.plots().stream().filter(p -> p.id() == plot).findFirst().orElseThrow().planting();
        assertNotNull(planting, "the crop is still there");
        assertEquals(pid, planting.id());
        assertTrue(planting.ready(), "and ripe");
        assertEquals(1, back.pests().size(), "no pest piled up while the player was away");
        assertEquals(3, back.pests().getFirst().stage());
        assertFalse(back.pests().getFirst().slowing(), "the growth penalty ended long ago");
        assertEquals(plotsBefore, back.plots().size());
        assertEquals(coinsBefore, coins(u), "an absence costs no coin");
        assertEquals(xpBefore, jdbc.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, u), "and no XP");
        // one real review brings the crop back to a clean harvest
        var pest = back.pests().getFirst();
        review(u, word, env.clock.now);
        env.clock.advance(Duration.ofSeconds(30));
        UUID k = key();
        var sprayed = env.pests.spray(u, k, pest.id());
        assertTrue(sprayed.rewarded());
        assertEquals(sprayed.totalXp(), env.pests.spray(u, k, pest.id()).totalXp(), "the cure reward is granted once");
        assertEquals("PEST_GONE", rejected(() -> env.pests.spray(u, key(), pest.id())).code);
        var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(pid)));
        var res = env.harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
        assertEquals(25, res.harvests().getFirst().components().pest());
        assertEquals(0, res.harvests().getFirst().components().fresh(), "only freshness (an old rule) reflects the absence");
        assertTrue(env.state.state(u).pests().isEmpty());
        assertLedgerReconciles(u);
    }

    @Test
    void careSoftensTheDamageButOnlyTheReviewResolvesIt() {
        long u = farmer(10);
        var s = env.state.state(u);
        grantCoins(u, 1_000);
        long plot = plotId(s, 1);
        long pid = env.planting.plant(u, key(), plot, new GardenDtos.PlantRequest("PUMPKIN")).plot().planting().id();
        long twinPlot = plotId(s, 2);
        env.planting.plant(u, key(), twinPlot, new GardenDtos.PlantRequest("PUMPKIN"));
        env.clock.advance(Duration.ofMinutes(40));
        card(u, "LEARNED", 30.0);
        card(u, "LEARNED", 31.0);
        assertEquals(2, env.state.state(u).pests().size());
        env.clock.advance(Duration.ofHours(7)); // both crops now have leaf damage
        env.planting.boost(u, key(), pid, new GardenDtos.BoostRequest("WATER"));
        var after = env.state.state(u);
        var tended = after.pests().stream().filter(p -> p.plantingId() == pid).findFirst().orElseThrow();
        var untended = after.pests().stream().filter(p -> p.plantingId() != pid).findFirst().orElseThrow();
        assertTrue(tended.tended());
        assertFalse(untended.tended());
        assertEquals(2, tended.stage(), "care does not resolve the pest");
        assertFalse(tended.reviewed());
        double tendedSpeed = after.plots().stream().filter(p -> p.id() == plot).findFirst().orElseThrow().planting().speed();
        double plainSpeed = after.plots().stream().filter(p -> p.id() == twinPlot).findFirst().orElseThrow().planting().speed();
        assertTrue(tendedSpeed > plainSpeed, "the tended crop grows faster than the untended one: " + tendedSpeed + " vs " + plainSpeed);
        assertEquals("PEST_NEEDS_REVIEW", rejected(() -> env.pests.spray(u, key(), tended.id())).code);
    }

    // ================================================================================ Echo Contribution

    @Test
    void verifiedFactsAreCreditedOnceUnderTheCapsAndNeverTwice() {
        long u = farmer(3);
        var cards = deck(u);
        study(u, cards, 3);
        var c = env.state.state(u).estate().contribution();
        assertEquals(30, entryPoints(u, "LEARNING_DAY"));
        assertEquals(3, entryCount(u, "LEARNING_DAY"));
        assertEquals(10, entryPoints(u, "BRANCH"), "the first vocabulary ornament (3 days)");
        assertEquals(40, c.balance());
        assertEquals(40, c.earned());
        assertEquals(10, c.dayPoints(), "today's capped points");
        for (int i = 0; i < 4; i++) env.state.state(u);
        assertEquals(40, contributionBalance(u), "re-reading the state credits nothing again");
        assertEquals(3, entryCount(u, "LEARNING_DAY"));
        // more reviews on an already credited day change nothing
        review(u, cards.get(0), env.clock.now.minusSeconds(60));
        review(u, cards.get(1), env.clock.now.minusSeconds(50));
        env.state.state(u);
        assertEquals(40, contributionBalance(u));
        // a graduation worth 40 on a day that already holds 10: the day cap (60) still has room for all of it
        long tree = jdbc.queryForObject("""
                INSERT INTO public.garden_knowledge_tree(user_id, slot, species, planted_at, status, peak_stage, essence_since, graduated_at)
                VALUES (?, 1, 'SPRING', ?, 'GRADUATED', 4, ?, ?) RETURNING id""", Long.class, u,
                Timestamp.from(env.clock.now.minus(Duration.ofDays(15))), Timestamp.from(env.clock.now), Timestamp.from(env.clock.now));
        for (int i = 0; i < 5; i++) {
            jdbc.update("INSERT INTO public.garden_knowledge_card(tree_id, user_id, position, flashcard_id, word, meaning_vi, released_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    tree, u, i + 1, cards.get(i), "w" + i, "nghĩa", Timestamp.from(env.clock.now));
        }
        env.state.state(u);
        assertEquals(40, entryPoints(u, "GRADUATION"));
        assertEquals(20, entryPoints(u, "MEMORY"), "the first memory lantern");
        assertEquals(100, contributionBalance(u));
        // a second and a third graduation the same day: the day cap (60) cuts them, the facts stay recorded
        for (int t = 0; t < 2; t++) {
            long extra = jdbc.queryForObject("""
                    INSERT INTO public.garden_knowledge_tree(user_id, slot, species, planted_at, status, peak_stage, essence_since, graduated_at)
                    VALUES (?, 1, 'SUMMER', ?, 'GRADUATED', 4, ?, ?) RETURNING id""", Long.class, u,
                    Timestamp.from(env.clock.now.minus(Duration.ofDays(15))), Timestamp.from(env.clock.now), Timestamp.from(env.clock.now));
            for (int i = 0; i < 5; i++) {
                long fresh = card(u, "LEARNED", -72.0);
                jdbc.update("INSERT INTO public.garden_knowledge_card(tree_id, user_id, position, flashcard_id, word, meaning_vi, released_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        extra, u, i + 1, fresh, "x" + i, "nghĩa", Timestamp.from(env.clock.now));
            }
        }
        var capped = env.state.state(u).estate().contribution();
        assertEquals(3, entryCount(u, "GRADUATION"));
        assertEquals(50, entryPoints(u, "GRADUATION"), "40 + 10 (the day had 10 left) + 0");
        assertEquals(60, capped.dayPoints());
        assertEquals(60, capped.dayCap());
        assertEquals(110, capped.balance(), "30 days + 10 branch + 50 graduations + 20 lantern");
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_contribution_entry WHERE user_id = ? AND source = 'GRADUATION' AND points = 0 AND nominal = 40",
                Integer.class, u), "a fully capped fact is recorded with zero points, so it can never be replayed later");
        // balance == sum of the append-only entries
        assertEquals(contributionBalance(u), jdbc.queryForObject("SELECT COALESCE(sum(points), 0) FROM public.garden_contribution_entry WHERE user_id = ?", Integer.class, u));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_contribution_entry SET points = 999 WHERE user_id = ?", u), "append-only");
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_contribution_entry WHERE user_id = ?", u), "append-only");
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_contribution SET balance = balance + 500 WHERE user_id = ?", u),
                "a balance that does not equal earned - spent is refused");
        // the history page returns the player's own entries only
        var page = env.contribution.history(u, null);
        assertFalse(page.entries().isEmpty());
        long stranger = farmer(3);
        assertTrue(env.contribution.history(stranger, null).entries().isEmpty());
    }

    @Test
    void contributionIsIsolatedPerAccountAndFarmingAloneEarnsOnlyFarmMilestones() {
        long learner = farmer(3);
        long farmerOnly = farmer(3);
        study(learner, deck(learner), 5);
        env.state.state(learner);
        var mine = env.state.state(farmerOnly).estate().contribution();
        assertEquals(0, mine.balance(), "another account's learning credits nothing here");
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_contribution_entry WHERE user_id = ?", Integer.class, farmerOnly));
        assertTrue(contributionBalance(learner) >= 50);
        // a delivered weekly order is a farm fact: credited once
        jdbc.update("""
                INSERT INTO public.garden_order(user_id, slot, kind, period_key, lines, base_coins, bonus, created_at, expires_at, status,
                    filled_at, paid_coins, blessing, delivered, fill_op)
                VALUES (?, 3, 'WEEKLY', 'fx-weekly', '[{"cropCode":"WHEAT","qty":1,"minTier":"NORMAL"}]'::jsonb, 1, '{}'::jsonb,
                    ?, ?, 'FILLED', ?, 1, false, '[{"cropCode":"WHEAT","tier":"NORMAL","qty":1}]'::jsonb, ?)""", farmerOnly,
                Timestamp.from(env.clock.now.minus(Duration.ofHours(2))), Timestamp.from(env.clock.now.plus(Duration.ofDays(2))),
                Timestamp.from(env.clock.now.minus(Duration.ofHours(1))), UUID.randomUUID());
        env.state.state(farmerOnly);
        env.state.state(farmerOnly);
        assertEquals(15, contributionBalance(farmerOnly));
        assertEquals(1, entryCount(farmerOnly, "WEEKLY_ORDER"));
        // a building at its top level is a one-time farm milestone
        buildingFixture(farmerOnly, "WAREHOUSE", 3);
        env.state.state(farmerOnly);
        env.state.state(farmerOnly);
        assertEquals(55, contributionBalance(farmerOnly));
        assertEquals(1, entryCount(farmerOnly, "BUILDING_MAX"));
        // yet a farm-only player cannot redeem: the reward asks for verified learning days
        env.props.setRewardsEnabled(true);
        try {
            var r = reward(farmerOnly, "SKIN_WATERMELON_ECHO");
            assertEquals("LOCKED", r.status());
            assertTrue(r.requirements().stream().anyMatch(q -> q.code().equals("LEARNING_DAYS") && !q.met()));
        } finally {
            env.props.setRewardsEnabled(false);
        }
    }

    // ================================================================================ Echo Rewards

    /** A learner with 60 verified days: 600 (days) + 100 (vocabulary ornaments) + 100 (era 1) = 800 contribution. */
    static long eligibleLearner() {
        long u = farmer(8);
        study(u, deck(u), 60);
        env.state.state(u);
        assertEquals(600, entryPoints(u, "LEARNING_DAY"));
        assertEquals(100, entryPoints(u, "BRANCH"));
        assertEquals(100, entryPoints(u, "ERA"));
        assertEquals(800, contributionBalance(u));
        return u;
    }

    @Test
    void theRewardCounterIsClosedByDefaultAndEntitlementRewardsCanNeverBeRedeemed() {
        long u = eligibleLearner();
        assertFalse(env.props.isRewardsEnabled(), "the kill switch is off by default");
        var shop = env.state.state(u).estate().rewards();
        assertFalse(shop.open());
        assertEquals("CLOSED", reward(u, "SKIN_WATERMELON_ECHO").status());
        assertEquals("REWARDS_CLOSED", rejected(() -> env.contribution.redeem(u, key(), "SKIN_WATERMELON_ECHO")).code);
        assertEquals(800, contributionBalance(u));
        env.props.setRewardsEnabled(true);
        try {
            for (String code : List.of("PREMIUM_TRIAL", "AI_VOUCHER_FEEDBACK", "FRAME_GARDEN_KEEPER")) {
                var r = reward(u, code);
                assertEquals("UNAVAILABLE", r.status(), code + " has no delivery mechanism");
                assertNull(r.cost(), "no price is shown for a reward that cannot be redeemed");
                assertEquals("REWARD_UNAVAILABLE", rejected(() -> env.contribution.redeem(u, key(), code)).code);
            }
            assertEquals(404, rejected(() -> env.contribution.redeem(u, key(), "NOPE")).status);
            assertEquals(800, contributionBalance(u), "nothing was spent");
            assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_reward_redemption WHERE user_id = ?", Integer.class, u));
            assertEquals("OPEN", reward(u, "SKIN_WATERMELON_ECHO").status());
        } finally {
            env.props.setRewardsEnabled(false);
        }
    }

    @Test
    void aRedemptionIsAtomicIdempotentLimitedAndAudited() {
        long u = eligibleLearner();
        long poor = farmer(8);
        study(poor, deck(poor), 20);
        env.state.state(poor);
        env.props.setRewardsEnabled(true);
        try {
            // not enough contribution: 200 (days) + 10 + 30 (ornaments) = 240 < 600
            assertEquals(240, contributionBalance(poor));
            var locked = reward(poor, "SKIN_WATERMELON_ECHO");
            assertEquals("LOCKED", locked.status());
            assertEquals("INSUFFICIENT_CONTRIBUTION", rejected(() -> env.contribution.redeem(poor, key(), "SKIN_WATERMELON_ECHO")).code);
            assertEquals(240, contributionBalance(poor));

            UUID k = key();
            var receipt = env.contribution.redeem(u, k, "SKIN_WATERMELON_ECHO");
            assertEquals(600, receipt.cost());
            assertEquals(200, receipt.balance());
            assertEquals("GARDEN_SKIN", receipt.delivery());
            assertEquals("WATERMELON_ECHO", receipt.deliveryRef());
            assertEquals(receipt.redemptionId(), env.contribution.redeem(u, k, "SKIN_WATERMELON_ECHO").redemptionId(), "replay returns the stored receipt");
            assertEquals(200, contributionBalance(u), "spent once");
            assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_reward_redemption WHERE user_id = ?", Integer.class, u));
            assertEquals("REWARD", jdbc.queryForObject("SELECT source FROM public.garden_skin_owned WHERE user_id = ? AND skin_code = 'WATERMELON_ECHO'", String.class, u),
                    "the cultivar was really delivered");
            assertEquals(-600, entryPoints(u, "REDEEM"));
            assertEquals(contributionBalance(u), jdbc.queryForObject("SELECT COALESCE(sum(points), 0) FROM public.garden_contribution_entry WHERE user_id = ?", Integer.class, u),
                    "the balance equals the audit trail");
            assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_event_log WHERE user_id = ? AND type = 'REWARD_REDEEM'", Integer.class, u));
            var owned = reward(u, "SKIN_WATERMELON_ECHO");
            assertEquals("OWNED", owned.status());
            assertEquals(1, owned.redeemed());
            assertEquals(1, env.state.state(u).estate().rewards().history().size());
            var again = rejected(() -> env.contribution.redeem(u, key(), "SKIN_WATERMELON_ECHO"));
            assertTrue(List.of("REWARD_LIMIT", "REWARD_OWNED").contains(again.code), again.code);
            assertEquals(200, contributionBalance(u));
            assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_reward_redemption WHERE user_id = ?", u), "a redemption is permanent");
            assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_reward_redemption SET cost = 1 WHERE user_id = ?", u));
            // the delivered cultivar is art only: it can be equipped and planted, and changes no number
            var equip = env.collection.equip(u, key(), new GardenDtos.SkinEquipRequest("WATERMELON", "WATERMELON_ECHO"));
            assertEquals("WATERMELON_ECHO", equip.skinCode());
            var planted = env.planting.plant(u, key(), plotId(env.state.state(u), 1), new GardenDtos.PlantRequest("WATERMELON")).plot().planting();
            assertEquals("WATERMELON_ECHO", planted.skinCode());
            assertEquals("watermelon_echo", planted.skinArt());
            // the other account never received anything
            assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_skin_owned WHERE user_id = ?", Integer.class, poor));
            assertLedgerReconciles(u);
        } finally {
            env.props.setRewardsEnabled(false);
        }
    }

    @Test
    void concurrentRedemptionsDeliverOnceAndAGlobalLimitIsNeverExceeded() throws Exception {
        long a = eligibleLearner();
        long b = eligibleLearner();
        env.props.setRewardsEnabled(true);
        try {
            var results = race(5, () -> env.contribution.redeem(a, key(), "SKIN_WATERMELON_ECHO"));
            assertEquals(1, results.stream().filter(r -> r instanceof GardenDtos.RewardReceipt).count(), "five tabs, one delivery");
            assertEquals(200, contributionBalance(a));
            assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_reward_redemption WHERE user_id = ?", Integer.class, a));
            // a global stock of one unit is already used by nobody (unlimited so far): limit it and let b take it, then nobody else
            jdbc.update("UPDATE public.garden_reward_def SET global_limit = 1 WHERE code = 'SKIN_WATERMELON_ECHO'");
            long c = eligibleLearner();
            env.contribution.redeem(b, key(), "SKIN_WATERMELON_ECHO");
            assertEquals("SOLD_OUT", reward(c, "SKIN_WATERMELON_ECHO").status());
            assertEquals("REWARD_SOLD_OUT", rejected(() -> env.contribution.redeem(c, key(), "SKIN_WATERMELON_ECHO")).code);
            assertEquals(800, contributionBalance(c), "a sold-out reward takes nothing");
            assertEquals(1, jdbc.queryForObject("SELECT redeemed FROM public.garden_reward_counter WHERE reward_code = 'SKIN_WATERMELON_ECHO'", Integer.class));
        } finally {
            jdbc.update("UPDATE public.garden_reward_def SET global_limit = NULL WHERE code = 'SKIN_WATERMELON_ECHO'");
            env.props.setRewardsEnabled(false);
        }
    }

    @Test
    void aRewardCultivarCannotBeCollectedOrBoughtAnyOtherWay() {
        long u = eligibleLearner();
        grantCoins(u, 1_000_000);
        var skin = env.state.state(u).living().collection().crops().stream().flatMap(c -> c.skins().stream())
                .filter(k -> k.code().equals("WATERMELON_ECHO")).findFirst().orElseThrow();
        assertEquals("LOCKED", skin.status(), "never AVAILABLE in the codex");
        assertEquals("REWARD", skin.unlockKind());
        long before = coins(u);
        var refused = rejected(() -> env.collection.acquire(u, key(), new GardenDtos.SkinAcquireRequest("WATERMELON_ECHO")));
        assertEquals("SKIN_LOCKED", refused.code);
        assertEquals("REWARD", refused.details.get("reason"));
        assertEquals(before, coins(u));
        assertEquals(404, rejected(() -> env.collection.equip(u, key(), new GardenDtos.SkinEquipRequest("WATERMELON", "WATERMELON_ECHO"))).status,
                "a skin the player does not own cannot be equipped");
        assertNotEquals("WATERMELON_ECHO", env.state.state(u).living().echo().params().get("skinCode"),
                "Echo never points at a reward cultivar as collectable");
    }
}
