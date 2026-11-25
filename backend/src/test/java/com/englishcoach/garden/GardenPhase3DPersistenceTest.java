package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenDtos.CompostRequest;
import com.englishcoach.garden.api.GardenDtos.HarvestCompleteRequest;
import com.englishcoach.garden.api.GardenDtos.HarvestResult;
import com.englishcoach.garden.api.GardenDtos.HarvestStartRequest;
import com.englishcoach.garden.api.GardenDtos.MarketBuyRequest;
import com.englishcoach.garden.api.GardenDtos.PlantRequest;
import com.englishcoach.garden.api.GardenDtos.PlantingView;
import com.englishcoach.garden.api.GardenDtos.SellLine;
import com.englishcoach.garden.api.GardenDtos.SellRequest;
import com.englishcoach.garden.api.GardenDtos.SupplyLine;
import com.englishcoach.garden.api.GardenDtos.TreatRequest;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.LedgerService;
import com.englishcoach.garden.domain.WeatherCalendar.Weather;
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
 * Phase 3D on real PostgreSQL 17 + the real migrations through V85: the seeded crop profiles and farming rules, the
 * harvest that grants produce and a small coin bonus exactly once, lifetime records that a sale never erases, supplies
 * bought, applied once and expiring, server-computed soil, a pest spray that never forges a review, and a garden planted
 * before the rules changed surviving the upgrade. Each test uses its own user ids.
 */
class GardenPhase3DPersistenceTest {

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static LedgerService ledger;
    static final AtomicLong USERS = new AtomicLong(60_000);
    static final AtomicLong WORDS = new AtomicLong(60_000);
    static final Instant START = Instant.parse("2026-10-09T03:00:00Z"); // 10:00 Vietnam, Lữ Hành week

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(START, "85");
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

    /** A garden past the tutorial at {@code level} (XP granted through the ledger so balances reconcile). */
    static long farmer(GardenTestEnv e, int level) {
        long u = newUser(e);
        e.state.state(u);
        e.jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", u);
        long xp = e.ctx.engine().levels().totalXpForLevel(level);
        if (xp > 0) new LedgerService(e.ctx).addXp(u, xp, "TEST_FIXTURE", "TEST", "fixture", null, e.clock.now);
        return u;
    }

    static long farmer(int level) {
        return farmer(env, level);
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

    static long coins(long user) {
        return jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static long xp(long user) {
        return jdbc.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static int qty(long user, String item) {
        return jdbc.queryForObject("SELECT COALESCE(sum(qty), 0) FROM public.garden_inventory WHERE user_id = ? AND item_code = ?",
                Integer.class, user, item);
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

    static PlantingView planting(GardenTestEnv e, long user, int slot) {
        return e.state.state(user).plots().stream().filter(p -> p.slot() == slot).findFirst().orElseThrow().planting();
    }

    static PlantingView planting(long user, int slot) {
        return planting(env, user, slot);
    }

    static long plant(long user, int slot, String crop) {
        return env.planting.plant(user, key(), plotId(env.state.state(user), slot), new PlantRequest(crop)).plot().planting().id();
    }

    static HarvestResult harvest(GardenTestEnv e, long user, List<Long> plantings) {
        var ch = e.harvest.start(user, key(), new HarvestStartRequest(plantings));
        return e.harvest.complete(user, key(), new HarvestCompleteRequest(ch.challengeId(), List.of(0, 0, 0), false));
    }

    /** Advances the clock until the planting in {@code slot} is ripe (bounded: every crop ripens). */
    static void ripen(long user, int slot) {
        for (int i = 0; i < 400 && !planting(user, slot).ready(); i++) env.clock.advance(Duration.ofMinutes(30));
        assertTrue(planting(user, slot).ready());
    }

    /** Moves the clock to the start of the next stretch of {@code hours} without rain (the weather timeline is global). */
    static void advanceToDrySpell(int hours) {
        var weather = env.ctx.engine().weather();
        for (int tries = 0; tries < 6000; tries++) {
            boolean dry = true;
            for (int h = 0; h <= hours && dry; h++) dry = weather.at(env.clock.now.plus(Duration.ofHours(h))) != Weather.RAIN;
            if (dry) return;
            env.clock.advance(Duration.ofHours(1));
        }
        fail("no dry spell found");
    }

    /** Moves the clock to the start of {@code hours} of continuous rain on the global weather timeline. */
    static void advanceToRain(int hours) {
        var weather = env.ctx.engine().weather();
        for (int tries = 0; tries < 8000; tries++) {
            boolean rain = true;
            for (int h = 0; h <= hours && rain; h++) rain = weather.at(env.clock.now.plus(Duration.ofHours(h))) == Weather.RAIN;
            if (rain) return;
            env.clock.advance(Duration.ofHours(1));
        }
        fail("no rain spell found");
    }

    /** One of the player's cards, due {@code dueHoursAgo} hours ago. */
    static long card(long user, double dueHoursAgo) {
        String word = "farming" + WORDS.incrementAndGet();
        long de = jdbc.queryForObject("INSERT INTO public.dictionary_entries(word, cefr, general_translation_vi) VALUES (?, 'A2', ?) RETURNING id",
                Long.class, word, "Nghĩa của " + word);
        Timestamp due = Timestamp.valueOf(LocalDateTime.now().minusMinutes(Math.round(dueHoursAgo * 60)));
        return jdbc.queryForObject("""
                INSERT INTO public.flashcards(user_id, dictionary_entry_id, status, next_review_date, review_count)
                VALUES (?, ?, 'LEARNED', ?, 1) RETURNING id""", Long.class, user, de, due);
    }

    /** What FlashcardService#reviewFlashcard records and does: one review-log row, and the card is due later again. */
    static void review(long user, long cardId, Instant at) {
        int n = jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = ? AND source_ref LIKE ?",
                Integer.class, user, cardId + ":%") + 1;
        jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', ?, ?)",
                user, cardId + ":" + n, Timestamp.from(at));
        jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP + interval '3 days' WHERE id = ?", cardId);
    }

    static void buy(long user, String item, int units) {
        env.economy.buy(user, key(), new MarketBuyRequest("ITEM:" + item, units));
    }

    // ------------------------------------------------------------------ seed

    @Test
    void v85SeedsExactlyTheDocumentedRulesAndTouchesNoEarlierSystem() {
        assertTrue(GardenTestRules.equivalent(GardenTestRules.phase3d(), env.ctx.engine().rules()), "crop profiles = the documented fixture");
        assertTrue(GardenTestRules.farmingEquivalent(GardenTestRules.farming(), env.ctx.farming().rules()), "farming rules = the documented fixture");
        assertEquals(GardenTestRules.economy3d().market().staples(), env.ctx.engine().economy().market().staples());
        assertEquals(GardenTestRules.economy().orders(), env.ctx.engine().economy().orders(), "the delivery board is untouched");
        assertEquals(GardenTestRules.economy().expansion(), env.ctx.engine().economy().expansion(), "the expansion beds are untouched");
        assertTrue(GardenTestRules.estateEquivalent(GardenTestRules.estate(), env.ctx.estate().rules()), "the estate (24 beds, buildings) is untouched");
        assertEquals(24, env.ctx.estate().rules().land().maxPlots());
        assertEquals(8, jdbc.queryForObject("SELECT count(*) FROM public.garden_item_def WHERE kind = 'TOOL' AND in_fixed_shop", Integer.class));
        assertEquals(60, jdbc.queryForObject("SELECT base_seconds FROM public.garden_crop_def WHERE code = 'QA_SPROUT'", Integer.class));
        // water is still never sold: only the moisture-only well water is
        assertFalse(env.ctx.engine().economy().market().staples().stream().anyMatch(s -> s.item().equals("WATER")));
    }

    // ------------------------------------------------------------------ upgrade of an existing garden

    @Test
    void aGardenPlantedBeforeTheRulesChangeSurvivesTheUpgradeAndNothingUnripens() {
        try (var old = new GardenTestEnv(START, "84")) { // Phase 3C rules on the new schema = production before V85
            assertNull(old.ctx.farming(), "without the V85 configuration the garden runs the Phase 3C rules");
            long u = farmer(old, 8);
            var s = old.state.state(u);
            long tomato = old.planting.plant(u, key(), plotId(s, 1), new PlantRequest("TOMATO")).plot().planting().id();
            long corn = old.planting.plant(u, key(), plotId(s, 2), new PlantRequest("CORN")).plot().planting().id();
            long pumpkin = old.planting.plant(u, key(), plotId(s, 3), new PlantRequest("PUMPKIN")).plot().planting().id();
            old.clock.advance(Duration.ofMinutes(50));
            var tomatoBefore = planting(old, u, 1);
            var cornBefore = planting(old, u, 2);
            var pumpkinBefore = planting(old, u, 3);
            assertTrue(tomatoBefore.ready(), "the 45-minute tomato is ripe");
            assertFalse(cornBefore.ready());
            assertNull(old.state.state(u).farming());
            long coinsBefore = old.jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, u);
            int seedsBefore = old.jdbc.queryForObject("SELECT COALESCE(sum(qty), 0) FROM public.garden_inventory WHERE user_id = ?", Integer.class, u);

            // ----- the release: V85 is applied by a normal start, the backend reloads its rules -----
            var up = new GardenTestEnv(old, old.clock.now, "85");
            up.props.getAllowlistUserIds().add(u);
            assertNotNull(up.ctx.farming());
            assertEquals(5400, up.ctx.engine().rules().crop("TOMATO").baseSeconds(), "new plantings use the new growth time");

            var tomatoAfter = planting(up, u, 1);
            var cornAfter = planting(up, u, 2);
            var pumpkinAfter = planting(up, u, 3);
            assertTrue(tomatoAfter.ready(), "a crop that was ripe is still ripe");
            assertEquals(tomatoBefore.readyAt(), tomatoAfter.readyAt());
            assertEquals(2700.0, tomatoAfter.requiredSeconds(), "it keeps the growth time it was planted with");
            assertEquals(cornBefore.readyAt(), cornAfter.readyAt(), "a growing crop ripens exactly when it was going to");
            assertEquals(cornBefore.progress(), cornAfter.progress());
            assertEquals(pumpkinBefore.readyAt(), pumpkinAfter.readyAt());
            assertEquals(21600.0, pumpkinAfter.requiredSeconds());
            assertNull(tomatoAfter.soil(), "an old planting has no soil to manage");
            assertNull(pumpkinAfter.soil());
            assertEquals(3, up.jdbc.queryForObject("SELECT count(*) FROM public.garden_planting WHERE user_id = ? AND growth_model = 1", Integer.class, u));
            assertEquals(coinsBefore, up.jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, u), "no balance is rewritten");
            assertEquals(seedsBefore, up.jdbc.queryForObject("SELECT COALESCE(sum(qty), 0) FROM public.garden_inventory WHERE user_id = ?", Integer.class, u));

            // soil supplies are refused on an old planting and nothing is consumed
            new LedgerService(up.ctx).addItem(u, "WELL_WATER", "NA", 1, "TEST_FIXTURE", "TEST", "fixture", null, up.clock.now);
            var ex = assertThrows(GardenException.class, () -> up.farming.treat(u, key(), pumpkin, new TreatRequest("WELL_WATER")));
            assertEquals("TREATMENT_NOT_NEEDED", ex.code);
            assertEquals(1, up.jdbc.queryForObject("SELECT qty FROM public.garden_inventory WHERE user_id = ? AND item_code = 'WELL_WATER'", Integer.class, u));

            // even weeks later the old crops are simply ripe, and harvesting them pays the new bonus once
            up.clock.advance(Duration.ofDays(20));
            assertTrue(planting(up, u, 2).ready());
            assertTrue(planting(up, u, 3).ready());
            var result = harvest(up, u, List.of(tomato, corn, pumpkin));
            assertEquals(3, result.harvests().size());
            assertEquals(3 + 5 + 23, result.coinsGained(), "tomato 3 + corn 5 + pumpkin 23");
            assertEquals(coinsBefore + 31, result.coins());

            // a crop planted now follows the new rules
            long fresh = up.planting.plant(u, key(), plotId(up.state.state(u), 1), new PlantRequest("TOMATO")).plot().planting().id();
            var planted = planting(up, u, 1);
            assertEquals(5400.0, planted.requiredSeconds());
            assertNotNull(planted.soil());
            assertEquals(2, up.jdbc.queryForObject("SELECT growth_model FROM public.garden_planting WHERE id = ?", Integer.class, fresh));
        }
    }

    // ------------------------------------------------------------------ harvest: produce + bonus, once

    @Test
    void aHarvestGivesProduceAndASmallCoinBonusExactlyOnce() throws Exception {
        long u = farmer(8);
        grantCoins(u, 2_000);
        long corn = plant(u, 1, "CORN");
        ripen(u, 1);
        long before = coins(u);
        var ch = env.harvest.start(u, key(), new HarvestStartRequest(List.of(corn)));
        UUID k = key();
        var request = new HarvestCompleteRequest(ch.challengeId(), List.of(0, 0, 0), false);
        var first = env.harvest.complete(u, k, request);
        assertEquals(5, first.coinsGained(), "corn sells for 84: bonus 5");
        assertEquals(5, first.harvests().getFirst().coins());
        assertEquals(before + 5, first.coins());
        assertEquals(before + 5, coins(u));
        assertEquals(1, qty(u, "CROP:CORN"), "the produce is in the storehouse");
        // the same command again: the stored answer, nothing granted twice
        var replay = env.harvest.complete(u, k, request);
        assertEquals(first, replay);
        assertEquals(before + 5, coins(u));
        // another key for the closed challenge is refused
        assertEquals("CHALLENGE_DONE", rejected(() -> env.harvest.complete(u, key(), request)).code);
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'HARVEST_BONUS'", Integer.class, u));
        assertEquals(5L, jdbc.queryForObject("SELECT sum(delta) FROM public.garden_ledger WHERE user_id = ? AND reason = 'HARVEST_BONUS'", Long.class, u));
        assertEquals(1, qty(u, "CROP:CORN"));

        // two crops, one challenge, six concurrent completions with different keys: one harvest, one bonus each
        long a = plant(u, 1, "CORN");
        long b = plant(u, 2, "CORN");
        ripen(u, 1);
        ripen(u, 2);
        long coinsBefore = coins(u);
        var ch2 = env.harvest.start(u, key(), new HarvestStartRequest(List.of(a, b)));
        var results = race(6, () -> env.harvest.complete(u, key(), new HarvestCompleteRequest(ch2.challengeId(), List.of(0, 0, 0), false)));
        assertEquals(1, results.stream().filter(r -> r instanceof HarvestResult).count());
        assertEquals(5, results.stream().filter(r -> r instanceof GardenException).count());
        assertEquals(coinsBefore + 10, coins(u));
        assertEquals(3, qty(u, "CROP:CORN"));
        assertEquals(3, jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'HARVEST_BONUS'", Integer.class, u));
        assertLedgerReconciles(u);
    }

    @Test
    void theHarvestBonusStopsAtTheDailyCapButTheProduceIsStillGranted() {
        long u = farmer(8);
        grantCoins(u, 2_000);
        long a = plant(u, 1, "CORN");
        long b = plant(u, 2, "CORN");
        ripen(u, 1);
        ripen(u, 2);
        int cap = env.ctx.farming().rules().harvestBonus().dailyCap();
        var day = env.ctx.engine().calendar().dayKey(env.clock.now);
        env.farmingRepo.addHarvestBonus(u, day, cap - 2); // a long farming day already paid almost the whole cap
        long before = coins(u);
        var first = harvest(env, u, List.of(a));
        assertEquals(2, first.coinsGained(), "only what the cap still allows");
        var second = harvest(env, u, List.of(b));
        assertEquals(0, second.coinsGained());
        assertEquals(before + 2, coins(u));
        assertEquals(2, qty(u, "CROP:CORN"), "both crops are in the storehouse");
        assertEquals(cap, env.state.state(u).farming().harvestBonusPaid());
        assertEquals(cap, env.state.state(u).farming().harvestBonusCap());
        // a new Vietnam day opens a new cap
        env.clock.advance(Duration.ofDays(1));
        assertEquals(0, env.state.state(u).farming().harvestBonusPaid());
        assertLedgerReconciles(u);
    }

    // ------------------------------------------------------------------ records and inventory

    @Test
    void sellingNeverErasesTheLifetimeRecordAndProduceIsSpentOnlyOnce() throws Exception {
        long u = farmer(8);
        grantCoins(u, 2_000);
        for (int slot = 1; slot <= 3; slot++) plant(u, slot, "CORN");
        for (int slot = 1; slot <= 3; slot++) ripen(u, slot);
        var ids = env.state.state(u).plots().stream().filter(p -> p.planting() != null).map(p -> p.planting().id()).toList();
        var harvested = harvest(env, u, ids);
        String tier = harvested.harvests().getFirst().tier();
        assertTrue(harvested.harvests().stream().allMatch(h -> h.tier().equals(tier)));
        var before = env.farming.records(u);
        var cornBefore = before.crops().stream().filter(c -> c.cropCode().equals("CORN")).findFirst().orElseThrow();
        assertEquals(3, cornBefore.harvested());
        assertEquals(3, cornBefore.inStock());
        assertEquals(0, cornBefore.sold());
        assertEquals(15, before.harvestBonusCoins());

        var sale = env.sell.sell(u, key(), new SellRequest(List.of(new SellLine("CORN", tier, 2))));
        var after = env.farming.records(u);
        var corn = after.crops().stream().filter(c -> c.cropCode().equals("CORN")).findFirst().orElseThrow();
        assertEquals(3, corn.harvested(), "selling never lowers what the farm has grown");
        assertEquals(3, after.harvestedTotal());
        assertEquals(1, corn.inStock());
        assertEquals(2, corn.sold());
        assertEquals(sale.coinsGained(), after.saleCoins());
        assertEquals(3, jdbc.queryForObject("SELECT harvests FROM public.garden_crop_mastery WHERE user_id = ? AND crop_code = 'CORN'", Integer.class, u),
                "the Phase 3B mastery counter is the same record: counted once per harvest");

        // the last unit: six concurrent sales with different keys sell it once
        var sales = race(6, () -> env.sell.sell(u, key(), new SellRequest(List.of(new SellLine("CORN", tier, 1)))));
        assertEquals(1, sales.stream().filter(r -> r instanceof GardenDtos.SellResult).count());
        assertEquals(0, qty(u, "CROP:CORN"));
        assertEquals(3, env.farming.records(u).crops().stream().filter(c -> c.cropCode().equals("CORN")).findFirst().orElseThrow().sold());

        // a sale and the compost bin race for the same eight units: exactly one of them gets the produce
        jdbc.update("INSERT INTO public.garden_building(user_id, code, level, upgraded_at, op_key) VALUES (?, 'WAREHOUSE', 1, now(), ?)", u, UUID.randomUUID());
        ledger.addItem(u, "CROP:WHEAT", "NORMAL", 8, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        long coinsBefore = coins(u);
        int fertilizerBefore = qty(u, "FERTILIZER");
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch go = new CountDownLatch(1);
        Future<Object> selling = pool.submit(() -> {
            go.await();
            try {
                return env.sell.sell(u, key(), new SellRequest(List.of(new SellLine("WHEAT", "NORMAL", 8))));
            } catch (GardenException e) {
                return e;
            }
        });
        Future<Object> composting = pool.submit(() -> {
            go.await();
            try {
                return env.estate.compost(u, key(), new CompostRequest("STANDARD", List.of(new SupplyLine("WHEAT", "NORMAL", 8))));
            } catch (GardenException e) {
                return e;
            }
        });
        go.countDown();
        Object sold = selling.get(), composted = composting.get();
        pool.shutdown();
        assertTrue(sold instanceof GardenException ^ composted instanceof GardenException, "exactly one of the two spends the wheat");
        assertEquals(0, qty(u, "CROP:WHEAT"));
        if (sold instanceof GardenException) assertEquals(fertilizerBefore + 1, qty(u, "FERTILIZER"));
        else assertEquals(coinsBefore + ((GardenDtos.SellResult) sold).coinsGained(), coins(u));
        var wheat = env.farming.records(u).crops().stream().filter(c -> c.cropCode().equals("WHEAT")).findFirst().orElseThrow();
        assertEquals(8, wheat.sold() + wheat.composted());
        assertLedgerReconciles(u);
    }

    // ------------------------------------------------------------------ supplies

    @Test
    void aSupplyIsBoughtAppliedOnceExpiresAndIsNeverFree() throws Exception {
        long u = farmer(8);
        long other = farmer(8);
        grantCoins(u, 5_000);
        long pumpkin = plant(u, 1, "PUMPKIN");
        long coinsBefore = coins(u);
        buy(u, "RAIN_COVER", 2);
        assertEquals(coinsBefore - 120, coins(u), "two covers at the listed price");
        assertEquals(2, qty(u, "RAIN_COVER"));
        assertEquals(2, env.state.state(u).farming().items().stream().filter(i -> i.code().equals("RAIN_COVER")).findFirst().orElseThrow().owned());

        UUID k = key();
        var applied = env.farming.treat(u, k, pumpkin, new TreatRequest("RAIN_COVER"));
        assertEquals(1, applied.itemQty());
        assertEquals(env.clock.now.plus(Duration.ofHours(12)), applied.expiresAt());
        assertTrue(planting(u, 1).protections().stream().anyMatch(p -> p.itemCode().equals("RAIN_COVER") && p.effect().equals("RAIN_COVER")));
        // the same command again consumes nothing more
        assertEquals(applied, env.farming.treat(u, k, pumpkin, new TreatRequest("RAIN_COVER")));
        assertEquals(1, qty(u, "RAIN_COVER"));
        // a second cover while the first one works is refused; the item stays
        assertEquals("TREATMENT_ACTIVE", rejected(() -> env.farming.treat(u, key(), pumpkin, new TreatRequest("RAIN_COVER"))).code);
        assertEquals(1, qty(u, "RAIN_COVER"));
        // the same key for another item is a different command
        assertEquals(422, rejected(() -> env.farming.treat(u, k, pumpkin, new TreatRequest("SHADE_NET"))).status);

        // unknown items, fertilizers (their own command), missing keys and other people's crops
        assertEquals("ITEM_NOT_FOUND", rejected(() -> env.farming.treat(u, key(), pumpkin, new TreatRequest("MAGIC"))).code);
        assertEquals("ITEM_NOT_FOUND", rejected(() -> env.farming.treat(u, key(), pumpkin, new TreatRequest("FERTILIZER"))).code);
        assertEquals(400, rejected(() -> env.farming.treat(u, null, pumpkin, new TreatRequest("RAIN_COVER"))).status);
        ledger.addItem(other, "RAIN_COVER", "NA", 1, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        assertEquals(404, rejected(() -> env.farming.treat(other, key(), pumpkin, new TreatRequest("RAIN_COVER"))).status);
        assertEquals(1, qty(other, "RAIN_COVER"), "nothing is consumed for a crop that is not yours");
        assertTrue(planting(u, 1).protections().stream().noneMatch(p -> p.appliedAt().isAfter(applied.expiresAt().minus(Duration.ofHours(12)))));
        assertEquals("NO_ITEM", rejected(() -> env.farming.treat(u, key(), pumpkin, new TreatRequest("SHADE_NET"))).code);

        // after twelve hours the cover is gone; a new one costs a new item, and with none left it is refused
        env.clock.advance(Duration.ofHours(12).plusMinutes(1));
        if (!planting(u, 1).ready()) {
            assertTrue(planting(u, 1).protections().stream().noneMatch(p -> p.itemCode().equals("RAIN_COVER")));
            env.farming.treat(u, key(), pumpkin, new TreatRequest("RAIN_COVER"));
            assertEquals(0, qty(u, "RAIN_COVER"));
            env.clock.advance(Duration.ofHours(12).plusMinutes(1));
            if (!planting(u, 1).ready()) {
                assertEquals("NO_ITEM", rejected(() -> env.farming.treat(u, key(), pumpkin, new TreatRequest("RAIN_COVER"))).code);
            }
        }
        // a treatment is a stored fact: it can never be edited or extended
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_treatment SET expires_at = expires_at + interval '1 day' WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_treatment WHERE user_id = ?", u));

        // one shade net, five concurrent applications with different keys: one net on the crop
        long melon = plant(u, 2, "WATERMELON");
        buy(u, "SHADE_NET", 1);
        var tries = race(5, () -> env.farming.treat(u, key(), melon, new TreatRequest("SHADE_NET")));
        assertEquals(1, tries.stream().filter(r -> r instanceof GardenDtos.TreatResult).count());
        assertEquals(0, qty(u, "SHADE_NET"));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_treatment WHERE planting_id = ? AND item_code = 'SHADE_NET'", Integer.class, melon));
        // mulch and the tonic: once per planting
        buy(u, "MULCH", 2);
        env.farming.treat(u, key(), melon, new TreatRequest("MULCH"));
        assertEquals("TREATMENT_USED", rejected(() -> env.farming.treat(u, key(), melon, new TreatRequest("MULCH"))).code);
        assertEquals(1, qty(u, "MULCH"));
        // the market keeps its daily caps for supplies
        assertEquals("MARKET_CAP", rejected(() -> buy(u, "RAIN_COVER", 5)).code);
        assertLedgerReconciles(u);
        assertLedgerReconciles(other);
        assertTrue(env.farming.records(other).crops().isEmpty(), "another account's records are its own");
    }

    @Test
    void theSoilIsComputedByTheServerAndWateringHealsAThirstyCrop() {
        long u = farmer(8);
        grantCoins(u, 2_000);
        advanceToDrySpell(14);
        long melon = plant(u, 1, "WATERMELON");
        var sown = planting(u, 1).soil();
        assertEquals(60.0, sown.moisture(), 0.5);
        assertEquals("OK", sown.status());
        assertEquals(1.5, sown.thirst());
        assertEquals("DRY", sown.nextStatus(), "the plot card can say when the soil will dry");
        assertNotNull(sown.nextChangeAt());
        assertEquals(sown, planting(u, 1).soil(), "reading again changes nothing");

        for (int i = 0; i < 14 && !planting(u, 1).soil().status().equals("DRY"); i++) env.clock.advance(Duration.ofHours(1));
        var dry = planting(u, 1);
        assertEquals("DRY", dry.soil().status(), "moisture " + dry.soil().moisture());
        assertTrue(dry.soil().slowing());
        assertTrue(dry.speed() <= 0.76, "a thirsty crop grows slower: " + dry.speed());
        assertFalse(dry.ready());
        // well water (bought for coins) wets the soil without any growth boost
        buy(u, "WELL_WATER", 1);
        var watered = env.farming.treat(u, key(), melon, new TreatRequest("WELL_WATER")).plot().planting();
        assertEquals("OK", watered.soil().status());
        assertFalse(watered.soil().slowing());
        assertEquals(0.0, watered.boostFraction());
        assertEquals(dry.soil().moisture() + 30, watered.soil().moisture(), 0.5);
        // the Flashcard-review water does both: moisture and its growth boost; it never floods the bed
        var boosted = env.planting.boost(u, key(), melon, new GardenDtos.BoostRequest("WATER")).plot().planting();
        assertEquals(0.04, boosted.boostFraction(), 1e-9);
        assertTrue(boosted.soil().moisture() <= 85.0 + 1e-9);
        assertEquals("OK", boosted.soil().status());
        env.planting.boost(u, key(), melon, new GardenDtos.BoostRequest("WATER"));
        assertEquals("OK", planting(u, 1).soil().status());
        buy(u, "WELL_WATER", 1);
        assertEquals("SOIL_TOO_WET", rejected(() -> env.farming.treat(u, key(), melon, new TreatRequest("WELL_WATER"))).code);
        assertEquals(1, qty(u, "WELL_WATER"), "a refused supply is not consumed");
        // the crop ripens; once ripe its soil is frozen and supplies are refused
        ripen(u, 1);
        var ripe = planting(u, 1);
        env.clock.advance(Duration.ofDays(3));
        assertEquals(ripe.soil(), planting(u, 1).soil(), "a ripe crop keeps the soil it ripened with");
        assertEquals("ALREADY_READY", rejected(() -> env.farming.treat(u, key(), melon, new TreatRequest("WELL_WATER"))).code);
        var result = harvest(env, u, List.of(melon));
        assertTrue(result.harvests().getFirst().components().care() <= env.ctx.engine().rules().quality().cared());
        assertLedgerReconciles(u);
    }

    @Test
    void aNeglectedCropIsCappedInQualityButNeverLostAndGoodCareKeepsTheFullScore() {
        long u = farmer(8);
        grantCoins(u, 2_000);
        advanceToDrySpell(30);
        long neglected = plant(u, 1, "WATERMELON");
        long tended = plant(u, 2, "WATERMELON");
        buy(u, "MULCH", 1);
        env.farming.treat(u, key(), tended, new TreatRequest("MULCH"));
        // the careful player waters three times on the way; the other bed is left alone
        for (int i = 0; i < 3; i++) {
            env.clock.advance(Duration.ofHours(5));
            if (!planting(u, 2).ready()) env.planting.boost(u, key(), tended, new GardenDtos.BoostRequest("WATER"));
        }
        ripen(u, 1);
        ripen(u, 2);
        var left = planting(u, 1);
        var cared = planting(u, 2);
        assertTrue(left.soil().stressShare() > 0.4, "left alone in a dry spell: " + left.soil().stressShare());
        assertEquals("GOOD", left.soil().tierCap());
        assertTrue(cared.soil().stressShare() <= 0.15, "mulched and watered: " + cared.soil().stressShare());
        assertNull(cared.soil().tierCap());
        assertTrue(Instant.parse(cared.readyAt().toString()).isBefore(left.readyAt()), "the tended crop also ripened first");
        var result = harvest(env, u, List.of(neglected, tended));
        var a = result.harvests().stream().filter(h -> h.plantingId() == neglected).findFirst().orElseThrow();
        var b = result.harvests().stream().filter(h -> h.plantingId() == tended).findFirst().orElseThrow();
        assertEquals(0, a.components().care());
        assertEquals(env.ctx.engine().rules().quality().cared(), b.components().care());
        assertTrue(List.of("NORMAL", "GOOD").contains(a.tier()), "capped, not destroyed: " + a.tier());
        assertEquals(2, qty(u, "CROP:WATERMELON"), "both crops were harvested");
        assertEquals(18 * 2, result.coinsGained());
    }

    @Test
    void persistentRainWaterlogsACropWhileACoverKeepsItDryAndDrainageClearsIt() {
        long u = farmer(8);
        grantCoins(u, 5_000);
        advanceToRain(9);
        long open = plant(u, 1, "PUMPKIN");
        long covered = plant(u, 2, "PUMPKIN");
        buy(u, "RAIN_COVER", 1);
        env.farming.treat(u, key(), covered, new TreatRequest("RAIN_COVER"));
        env.clock.advance(Duration.ofHours(5));
        var wet = planting(u, 1);
        var dry = planting(u, 2);
        assertEquals("WET", wet.soil().status(), "five hours of rain: moisture " + wet.soil().moisture());
        assertTrue(wet.soil().slowing());
        assertEquals("OK", dry.soil().status(), "the cover kept the rain out");
        assertEquals(60.0, dry.soil().moisture(), 0.5);
        assertTrue(wet.speed() < dry.speed(), "a waterlogged crop grows slower than a covered one: " + wet.speed() + " / " + dry.speed());
        assertFalse(wet.ready());
        // drainage: the soil is healthy at once and stays so while the rain goes on
        buy(u, "DRAINAGE", 1);
        var drained = env.farming.treat(u, key(), open, new TreatRequest("DRAINAGE")).plot().planting();
        assertEquals("OK", drained.soil().status());
        assertFalse(drained.soil().slowing());
        assertTrue(drained.soil().moisture() <= 65.5);
        env.clock.advance(Duration.ofHours(3));
        assertEquals("OK", planting(u, 1).soil().status(), "it is still raining; the drained bed cannot flood");
        // nothing was lost to the weather: both crops ripen and are harvested
        ripen(u, 1);
        ripen(u, 2);
        assertEquals(2, harvest(env, u, List.of(open, covered)).harvests().size());
        assertEquals(2, qty(u, "CROP:PUMPKIN"));
        assertLedgerReconciles(u);
    }

    // ------------------------------------------------------------------ pests

    @Test
    void aSprayNeverForgesAReviewAndOnlyTheRealReviewResolvesThePest() {
        long u = farmer(10);
        grantCoins(u, 5_000);
        long pumpkin = plant(u, 1, "PUMPKIN");
        long twin = plant(u, 2, "PUMPKIN");
        env.clock.advance(Duration.ofMinutes(40));
        long word = card(u, 30.0);
        var pests = env.state.state(u).pests();
        assertEquals(1, pests.size());
        long pestId = pests.getFirst().id();
        long host = pests.getFirst().plantingId();
        long free = host == pumpkin ? twin : pumpkin;
        env.clock.advance(Duration.ofHours(7));
        var damaged = env.state.state(u).pests().getFirst();
        assertEquals(2, damaged.stage(), "leaf damage");
        assertTrue(damaged.slowing());

        buy(u, "ORGANIC_SPRAY", 2);
        var cardBefore = jdbc.queryForMap("SELECT status, next_review_date, review_count, state FROM public.flashcards WHERE id = ?", word);
        int reviewsBefore = jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = ?", Integer.class, u);
        int gardenEventsBefore = jdbc.queryForObject("SELECT count(*) FROM public.garden_learning_event WHERE user_id = ?", Integer.class, u);
        long xpBefore = xp(u);
        long coinsBefore = coins(u);

        // a crop without a pest cannot be sprayed
        assertEquals("NO_PEST", rejected(() -> env.farming.treat(u, key(), free, new TreatRequest("ORGANIC_SPRAY"))).code);
        var sprayed = env.farming.treat(u, key(), host, new TreatRequest("ORGANIC_SPRAY"));
        assertEquals(env.clock.now.plus(Duration.ofHours(12)), sprayed.expiresAt());
        var pest = env.state.state(u).pests().getFirst();
        assertEquals(pestId, pest.id(), "the pest is still there");
        assertFalse(pest.reviewed(), "the word is still not reviewed");
        assertEquals(2, pest.stage(), "its stage clock is untouched");
        assertFalse(pest.slowing(), "the spray only suspends the damage");
        assertTrue(sprayed.plot().planting().protections().stream().anyMatch(p -> p.effect().equals("PEST_SPRAY")));
        // nothing about learning changed and nothing was rewarded
        assertEquals(cardBefore, jdbc.queryForMap("SELECT status, next_review_date, review_count, state FROM public.flashcards WHERE id = ?", word));
        assertEquals(reviewsBefore, jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = ?", Integer.class, u));
        assertEquals(gardenEventsBefore, jdbc.queryForObject("SELECT count(*) FROM public.garden_learning_event WHERE user_id = ?", Integer.class, u));
        assertEquals(xpBefore, xp(u), () -> "XP ledger: " + jdbc.queryForList(
                "SELECT reason, delta, ref_type, ref_id FROM public.garden_ledger WHERE user_id = ? AND asset = 'XP' ORDER BY id", u));
        assertEquals(coinsBefore, coins(u));
        assertEquals("PEST_NEEDS_REVIEW", rejected(() -> env.pests.spray(u, key(), pestId)).code, "sending the pest away still needs the real review");
        assertEquals("TREATMENT_ACTIVE", rejected(() -> env.farming.treat(u, key(), host, new TreatRequest("ORGANIC_SPRAY"))).code);

        // when the spray wears off the damage resumes: the overdue word is still overdue
        env.clock.advance(Duration.ofHours(12).plusMinutes(5));
        var back = env.state.state(u).pests().getFirst();
        assertFalse(back.reviewed());
        assertTrue(back.stage() >= 2);
        assertTrue(back.slowing() || back.stage() == 3);

        // the genuine review (recorded by the Flashcard module) resolves it, and its small reward is paid once
        review(u, word, env.clock.now);
        // Phase 4: the review is the whole cure; the garden's confirmation reports the reward (the review also earned
        // its ordinary learning XP through the Flashcard ingest, nothing more)
        var sent = env.pests.spray(u, key(), pestId);
        assertTrue(sent.rewarded());
        assertEquals((long) sent.xp(), jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND reason = 'PEST_CURE'",
                Long.class, u));
        assertEquals("PEST_GONE", rejected(() -> env.pests.spray(u, key(), pestId)).code);
        assertEquals(0, env.state.state(u).pests().size());
        assertLedgerReconciles(u);
    }

    @Test
    void aSprayedHarvestIsBetterThanAWiltingOneAndWorseThanAReviewedOne() {
        long u = farmer(10);
        grantCoins(u, 5_000);
        long a = plant(u, 1, "CORN");
        long b = plant(u, 2, "CORN");
        env.clock.advance(Duration.ofMinutes(40));
        card(u, 30.0);
        card(u, 31.0);
        assertEquals(2, env.state.state(u).pests().size());
        env.clock.advance(Duration.ofHours(25)); // both crops are ripe and wilting
        buy(u, "ORGANIC_SPRAY", 1);
        env.farming.treat(u, key(), a, new TreatRequest("ORGANIC_SPRAY")); // a ripe crop may still be sprayed
        var result = harvest(env, u, List.of(a, b));
        int sprayed = result.harvests().stream().filter(h -> h.plantingId() == a).findFirst().orElseThrow().components().pest();
        int wilting = result.harvests().stream().filter(h -> h.plantingId() == b).findFirst().orElseThrow().components().pest();
        assertEquals(18, sprayed);
        assertEquals(0, wilting);
        assertTrue(sprayed < env.ctx.engine().rules().quality().pestClean(), "only a genuine review gives the clean score");
    }

    @Test
    void anInsectNetKeepsNewPestsOffThatCropAndNeverTouchesTheWord() {
        long u = farmer(10);
        grantCoins(u, 5_000);
        long netted = plant(u, 1, "PUMPKIN");
        long open = plant(u, 2, "PUMPKIN");
        env.clock.advance(Duration.ofMinutes(40));
        buy(u, "INSECT_NET", 1);
        env.farming.treat(u, key(), netted, new TreatRequest("INSECT_NET"));
        long first = card(u, 30.0);
        long second = card(u, 31.0);
        var pests = env.state.state(u).pests();
        assertEquals(1, pests.size(), "one open host: one pest; the net keeps the other word off the netted crop");
        assertEquals(open, pests.getFirst().plantingId());
        assertEquals(2, jdbc.queryForObject("SELECT count(*) FROM public.flashcards WHERE user_id = ? AND next_review_date < LOCALTIMESTAMP",
                Integer.class, u), "both words are still overdue");
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = ?", Integer.class, u));
        // when the net is gone the still-overdue word may settle there
        env.clock.advance(Duration.ofHours(24).plusMinutes(5));
        {
            var later = env.state.state(u).pests();
            assertEquals(2, later.size());
            assertTrue(later.stream().anyMatch(p -> p.plantingId() == netted));
        }
        assertTrue(first != second);
    }

    // ------------------------------------------------------------------ the shop and the earlier systems

    @Test
    void theShopListsEverySupplyWithItsCategoryPriceAndStockAndTheEarlierSystemsStillWork() {
        long u = farmer(8);
        grantCoins(u, 5_000);
        var state = env.state.state(u);
        var offers = state.economy().market().offers();
        Map<String, String> category = new java.util.HashMap<>();
        offers.forEach(o -> category.put(o.code(), o.category()));
        assertEquals("CARE", category.get("ITEM:FERTILIZER"));
        assertEquals("CARE", category.get("ITEM:MULCH"));
        assertEquals("WEATHER", category.get("ITEM:RAIN_COVER"));
        assertEquals("WEATHER", category.get("ITEM:DRAINAGE"));
        assertEquals("PEST", category.get("ITEM:ORGANIC_SPRAY"));
        assertEquals("UTILITY", category.get("ITEM:WELL_WATER"));
        assertTrue(offers.stream().filter(o -> o.kind().equals("PACK")).allMatch(o -> o.category().equals("SEEDS")));
        assertFalse(category.containsKey("ITEM:WATER"));
        var items = state.farming().items();
        assertEquals(10, items.size());
        var cover = items.stream().filter(i -> i.code().equals("RAIN_COVER")).findFirst().orElseThrow();
        assertEquals(60L, cover.price());
        assertEquals(12.0, cover.hours());
        assertEquals(0, cover.owned());
        assertTrue(items.stream().filter(i -> i.code().equals("DRAINAGE")).findFirst().orElseThrow().locked() == (8 < 6));
        // a locked supply cannot be bought before its level
        long novice = farmer(1);
        grantCoins(novice, 1_000);
        assertEquals("OFFER_LOCKED", rejected(() -> env.economy.buy(novice, key(), new MarketBuyRequest("ITEM:DRAINAGE", 1))).code);
        // every crop shows its growth conditions
        var crops = state.crops();
        assertEquals(1.5, crops.stream().filter(c -> c.code().equals("WATERMELON")).findFirst().orElseThrow().thirst());
        assertEquals(23, crops.stream().filter(c -> c.code().equals("PUMPKIN")).findFirst().orElseThrow().harvestBonus());
        assertEquals(57600, crops.stream().filter(c -> c.code().equals("PUMPKIN")).findFirst().orElseThrow().baseSeconds());
        // Phase 3C building perks still apply
        jdbc.update("INSERT INTO public.garden_building(user_id, code, level, upgraded_at, op_key) VALUES (?, 'COTTAGE', 1, now(), ?)", u, UUID.randomUUID());
        assertEquals(0.25, env.ctx.perks(u).freshBonus());
        assertEquals(6, env.state.state(u).plots().size(), "the six starter beds");
        assertEquals(24, env.state.state(u).estate().land().maxPlots());
    }
}
