package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.GardenAccessService;
import com.englishcoach.garden.application.GardenContext;
import com.englishcoach.garden.application.GardenSetup;
import com.englishcoach.garden.application.GardenStateService;
import com.englishcoach.garden.application.GardenViews;
import com.englishcoach.garden.application.HarvestService;
import com.englishcoach.garden.application.LearningIngestService;
import com.englishcoach.garden.application.LedgerService;
import com.englishcoach.garden.application.PlantingService;
import com.englishcoach.garden.application.SellService;
import com.englishcoach.garden.config.GardenProperties;
import com.englishcoach.garden.infra.GardenRepository;
import com.englishcoach.garden.infra.GardenRulesLoader;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.testcontainers.containers.PostgreSQLContainer;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
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
 * Real PostgreSQL 17 + the real V77 + V78 migrations ({@link GardenTestEnv}). Phase 1 farming loop: isolation, access,
 * idempotency, concurrency, time progression, learning rewards and ledger invariants. Each test uses its own user ids.
 */
class GardenPersistenceTest {

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static GardenTestEnv.MutableClock clock;
    static GardenProperties props;
    static GardenContext ctx;
    static GardenStateService state;
    static PlantingService planting;
    static HarvestService harvest;
    static SellService sell;
    static ObjectMapper json;
    static final AtomicLong USERS = new AtomicLong(100);

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(Instant.parse("2026-10-09T03:00:00Z")); // 10:00 Vietnam, Lữ Hành week
        jdbc = env.jdbc;
        clock = env.clock;
        props = env.props;
        ctx = env.ctx;
        state = env.state;
        planting = env.planting;
        harvest = env.harvest;
        sell = env.sell;
        json = env.json;
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    static long newUser() {
        long id = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id) VALUES (?)", id);
        props.getAllowlistUserIds().add(id);
        return id;
    }

    static UUID key() {
        return UUID.randomUUID();
    }

    static GardenException rejected(Executable e) {
        return assertThrows(GardenException.class, e::run);
    }

    interface Executable {
        void run();
    }

    static long plotId(GardenDtos.State s, int slot) {
        return s.plots().stream().filter(p -> p.slot() == slot).findFirst().orElseThrow().id();
    }

    static List<Integer> correctAnswers(UUID challengeId) throws Exception {
        JsonNode qs = json.readTree(jdbc.queryForObject("SELECT questions::text FROM public.garden_challenge WHERE id = ?", String.class, challengeId));
        List<Integer> out = new ArrayList<>();
        qs.forEach(q -> out.add(q.get("answer").asInt()));
        return out;
    }

    /** sum(ledger delta) == balance for coins, XP and every inventory line. */
    static void assertLedgerReconciles(long user) {
        long coins = jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
        long xp = jdbc.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, user);
        assertEquals(coins, sum(user, "COIN", "NA"), "coins reconcile");
        assertEquals(xp, sum(user, "XP", "NA"), "xp reconcile");
        jdbc.query("SELECT item_code, tier, qty FROM public.garden_inventory WHERE user_id = ?", rs -> {
            assertEquals(rs.getLong("qty"), sum(user, rs.getString("item_code"), rs.getString("tier")), rs.getString("item_code"));
        }, user);
        Integer orphan = jdbc.queryForObject("""
                SELECT count(*) FROM (SELECT asset, tier, sum(delta) s FROM public.garden_ledger WHERE user_id = ? AND asset NOT IN ('COIN','XP')
                GROUP BY asset, tier) l LEFT JOIN public.garden_inventory i ON i.user_id = ? AND i.item_code = l.asset AND i.tier = l.tier
                WHERE COALESCE(i.qty, 0) <> l.s""", Integer.class, user, user);
        assertEquals(0, orphan, "no ledger asset without matching inventory");
    }

    static long sum(long user, String asset, String tier) {
        Long s = jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND asset = ? AND tier = ?",
                Long.class, user, asset, tier);
        return s == null ? 0 : s;
    }

    // ================================================================================ configuration

    @Test
    void migrationSeedsExactlyTheDocumentedRules() {
        var loaded = new GardenRulesLoader(jdbc, json).load();
        assertTrue(GardenTestRules.equivalent(GardenTestRules.seeded(), loaded), "V77 + V78 seed == GardenTestRules fixture");
    }

    // ================================================================================ initialization / access

    @Test
    void firstVisitCreatesSixPlotsAndGrantsTheStarterPackExactlyOnceEvenConcurrently() throws Exception {
        long u = newUser();
        ExecutorService pool = Executors.newFixedThreadPool(8);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<GardenDtos.State>> calls = new ArrayList<>();
        for (int i = 0; i < 8; i++) calls.add(pool.submit(() -> {
            go.await();
            return state.state(u);
        }));
        go.countDown();
        for (var f : calls) f.get();
        pool.shutdown();
        var s = state.state(u);
        assertEquals(6, s.plots().size());
        assertEquals(List.of(8, 9, 10, 8, 9, 10), s.plots().stream().map(GardenDtos.PlotView::gridX).toList());
        assertEquals(200, s.profile().coins());
        assertEquals(3, s.inventory().water());
        assertEquals(1, s.inventory().fertilizer());
        assertEquals(Map.of("WHEAT", 4, "TOMATO", 2), Map.of(s.inventory().seeds().get(0).cropCode(), s.inventory().seeds().get(0).qty(),
                s.inventory().seeds().get(1).cropCode(), s.inventory().seeds().get(1).qty()));
        assertEquals(5, jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'STARTER'", Integer.class, u));
        assertThrows(Exception.class, () -> jdbc.update("INSERT INTO public.garden_ledger(user_id, asset, delta, reason) VALUES (?, 'COIN', 200, 'STARTER')", u),
                "the partial unique index refuses a second starter grant");
        assertLedgerReconciles(u);
    }

    @Test
    void accessIsGatedByFlagAndAllowlist() {
        long outsider = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id) VALUES (?)", outsider);
        assertEquals(404, rejected(() -> state.state(outsider)).status);
        assertEquals(404, rejected(() -> planting.plant(outsider, key(), 1, new GardenDtos.PlantRequest("WHEAT"))).status);
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_profile WHERE user_id = ?", Integer.class, outsider));
        long u = newUser();
        props.setEnabled(false);
        try {
            assertEquals(404, rejected(() -> state.state(u)).status);
        } finally {
            props.setEnabled(true);
        }
    }

    @Test
    void oneLearnerCanNeverReadOrMutateAnothersGarden() throws Exception {
        long a = newUser();
        long b = newUser();
        var sa = state.state(a);
        state.state(b);
        long plotA = plotId(sa, 1);
        assertEquals(404, rejected(() -> planting.plant(b, key(), plotA, new GardenDtos.PlantRequest("WHEAT"))).status);
        var planted = planting.plant(a, key(), plotA, new GardenDtos.PlantRequest("WHEAT"));
        long pid = planted.plot().planting().id();
        assertEquals(404, rejected(() -> planting.boost(b, key(), pid, new GardenDtos.BoostRequest("WATER"))).status);
        clock.advance(Duration.ofSeconds(61));
        var ch = harvest.start(a, key(), new GardenDtos.HarvestStartRequest(List.of(pid)));
        assertEquals(404, rejected(() -> harvest.start(b, key(), new GardenDtos.HarvestStartRequest(List.of(pid)))).status);
        assertEquals(404, rejected(() -> harvest.complete(b, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true))).status);
        // the same idempotency key used by another user is a different operation (keys are per user)
        UUID shared = key();
        planting.plant(a, shared, plotId(sa, 2), new GardenDtos.PlantRequest("WHEAT"));
        var sb = state.state(b);
        var other = planting.plant(b, shared, plotId(sb, 2), new GardenDtos.PlantRequest("WHEAT"));
        assertEquals(plotId(sb, 2), other.plot().id());
    }

    // ================================================================================ the farming loop

    @Test
    void fullLoopPlantWaterGrowHarvestSellWithReplaySafety() throws Exception {
        long u = newUser();
        var s = state.state(u);
        long plot = plotId(s, 1);
        UUID plantKey = key();
        var p = planting.plant(u, plantKey, plot, new GardenDtos.PlantRequest("WHEAT"));
        assertTrue(p.tutorial(), "the first wheat is the 60-second tutorial crop");
        assertEquals(0, p.coinsPaid());
        assertEquals(3, p.seedsLeft());
        var replay = planting.plant(u, plantKey, plot, new GardenDtos.PlantRequest("WHEAT"));
        assertEquals(json.writeValueAsString(p), json.writeValueAsString(replay), "replay returns the stored response");
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_planting WHERE user_id = ?", Integer.class, u));
        assertEquals(422, rejected(() -> planting.plant(u, plantKey, plotId(s, 2), new GardenDtos.PlantRequest("WHEAT"))).status,
                "same key + different payload");
        assertEquals("PLOT_OCCUPIED", rejected(() -> planting.plant(u, key(), plot, new GardenDtos.PlantRequest("TOMATO"))).code);
        long pid = p.plot().planting().id();

        var watered = planting.boost(u, key(), pid, new GardenDtos.BoostRequest("WATER"));
        assertEquals(1, watered.plot().planting().waterCount());
        assertEquals(2, watered.itemLeft());
        assertEquals("NOT_READY", rejected(() -> harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(pid)))).code);

        clock.advance(Duration.ofSeconds(58)); // 60 s × 0.96 = 57.6 s of required work
        var grown = state.state(u);
        var view = grown.plots().stream().filter(x -> x.id() == plot).findFirst().orElseThrow().planting();
        assertTrue(view.ready());
        assertEquals(4, view.stage());
        assertEquals("ALREADY_READY", rejected(() -> planting.boost(u, key(), pid, new GardenDtos.BoostRequest("WATER"))).code);

        UUID startKey = key();
        var ch = harvest.start(u, startKey, new GardenDtos.HarvestStartRequest(List.of(pid)));
        assertEquals(3, ch.questions().size());
        assertEquals(json.writeValueAsString(ch), json.writeValueAsString(harvest.start(u, startKey, new GardenDtos.HarvestStartRequest(List.of(pid)))));
        assertFalse(json.writeValueAsString(ch).contains("\"answer\""), "answers never leave the server before completion");
        List<Integer> answers = correctAnswers(ch.challengeId());
        UUID doneKey = key();
        var result = harvest.complete(u, doneKey, new GardenDtos.HarvestCompleteRequest(ch.challengeId(), answers, false));
        assertEquals(3, result.recall().correct());
        var line = result.harvests().getFirst();
        // recall 30 + clean 25 + Common 10 + cared 15 + fresh 10 = 90 → Perfect
        assertEquals(90, line.score());
        assertEquals("PERFECT", line.tier());
        assertTrue(line.newForms().contains("PERFECT"));
        assertEquals(json.writeValueAsString(result),
                json.writeValueAsString(harvest.complete(u, doneKey, new GardenDtos.HarvestCompleteRequest(ch.challengeId(), answers, false))));
        assertEquals("CHALLENGE_DONE", rejected(() -> harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), answers, false))).code);
        var after = state.state(u);
        assertNull(after.plots().stream().filter(x -> x.id() == plot).findFirst().orElseThrow().planting(), "plot is empty again");
        assertEquals(1, after.inventory().produce().size());
        assertEquals(result.xpGained(), after.profile().totalXp());

        UUID sellKey = key();
        var sold = sell.sell(u, sellKey, new GardenDtos.SellRequest(List.of(new GardenDtos.SellLine("WHEAT", "PERFECT", 1))));
        assertEquals(20, sold.coinsGained(), "floor(15 × 1.35) without blessing");
        assertEquals(220, sold.coins());
        assertEquals(json.writeValueAsString(sold),
                json.writeValueAsString(sell.sell(u, sellKey, new GardenDtos.SellRequest(List.of(new GardenDtos.SellLine("WHEAT", "PERFECT", 1))))));
        assertEquals("NO_ITEM", rejected(() -> sell.sell(u, key(), new GardenDtos.SellRequest(List.of(new GardenDtos.SellLine("WHEAT", "PERFECT", 1))))).code);
        assertEquals(220, state.state(u).profile().coins());
        assertLedgerReconciles(u);
    }

    @Test
    void seedsAreBoughtAtTheFixedPriceAndLockedCropsAndFundsAreEnforced() {
        long u = newUser();
        var s = state.state(u);
        for (int slot = 1; slot <= 4; slot++) planting.plant(u, key(), plotId(s, slot), new GardenDtos.PlantRequest("WHEAT"));
        var bought = planting.plant(u, key(), plotId(s, 5), new GardenDtos.PlantRequest("WHEAT"));
        assertEquals(5, bought.coinsPaid());
        assertEquals(195, bought.coins());
        var e = rejected(() -> planting.plant(u, key(), plotId(s, 6), new GardenDtos.PlantRequest("CORN")));
        assertEquals("CROP_LOCKED", e.code);
        assertEquals(2, e.details.get("level"));
        // V78: the legendary orchid is never sold (graduation seed only), so it is refused for lack of a seed
        var orchid = rejected(() -> planting.plant(u, key(), plotId(s, 6), new GardenDtos.PlantRequest("CRYSTAL_ORCHID")));
        assertEquals("NO_SEED", orchid.code);
        assertEquals(404, rejected(() -> planting.plant(u, key(), plotId(s, 6), new GardenDtos.PlantRequest("QA_SPROUT"))).status, "QA crop hidden");
        props.getQaUserIds().add(u);
        assertEquals("QA_SPROUT", planting.plant(u, key(), plotId(s, 6), new GardenDtos.PlantRequest("QA_SPROUT")).plot().planting().cropCode());
        assertLedgerReconciles(u);

        long poor = newUser();
        var sp = state.state(poor);
        planting.plant(poor, key(), plotId(sp, 1), new GardenDtos.PlantRequest("TOMATO")); // starter seed 1
        planting.plant(poor, key(), plotId(sp, 2), new GardenDtos.PlantRequest("TOMATO")); // starter seed 2
        jdbc.update("UPDATE public.garden_profile SET coins = 3 WHERE user_id = ?", poor); // test-only setup (outside the ledger)
        var funds = rejected(() -> planting.plant(poor, key(), plotId(sp, 3), new GardenDtos.PlantRequest("TOMATO")));
        assertEquals("INSUFFICIENT_FUNDS", funds.code);
        assertEquals(12L, ((Number) funds.details.get("missing")).longValue());
        assertEquals(3, jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, poor));
        assertEquals(2, jdbc.queryForObject("SELECT count(*) FROM public.garden_planting WHERE user_id = ?", Integer.class, poor));
    }

    @Test
    void concurrentSpendingNeverGoesNegativeAndDoublePlantingIsImpossible() throws Exception {
        long u = newUser();
        var s = state.state(u);
        // use up the starter tomato seeds, then leave exactly enough coins for one purchase
        planting.plant(u, key(), plotId(s, 1), new GardenDtos.PlantRequest("TOMATO"));
        planting.plant(u, key(), plotId(s, 2), new GardenDtos.PlantRequest("TOMATO"));
        jdbc.update("UPDATE public.garden_profile SET coins = 20 WHERE user_id = ?", u); // test-only setup
        ExecutorService pool = Executors.newFixedThreadPool(8);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<String>> results = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            long plot = plotId(s, 3 + (i % 4));
            results.add(pool.submit(() -> {
                go.await();
                try {
                    planting.plant(u, key(), plot, new GardenDtos.PlantRequest("TOMATO"));
                    return "OK";
                } catch (GardenException e) {
                    return e.code;
                }
            }));
        }
        go.countDown();
        List<String> codes = new ArrayList<>();
        for (var r : results) codes.add(r.get());
        pool.shutdown();
        assertEquals(1, codes.stream().filter("OK"::equals).count(), codes.toString());
        assertTrue(codes.stream().allMatch(c -> c.equals("OK") || c.equals("INSUFFICIENT_FUNDS") || c.equals("PLOT_OCCUPIED")), codes.toString());
        assertEquals(5, jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, u));
        Integer perPlot = jdbc.queryForObject("SELECT max(c) FROM (SELECT count(*) c FROM public.garden_planting WHERE user_id = ? AND harvested_at IS NULL GROUP BY plot_id) x", Integer.class, u);
        assertEquals(1, perPlot);
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_planting(user_id, plot_id, crop_code, planted_at, base_seconds) VALUES (?, ?, 'WHEAT', now(), 60)""", u, plotId(s, 1)),
                "the partial unique index forbids a second active planting");
    }

    @Test
    void concurrentHarvestCompletesExactlyOnce() throws Exception {
        long u = newUser();
        var s = state.state(u);
        long pid = planting.plant(u, key(), plotId(s, 1), new GardenDtos.PlantRequest("WHEAT")).plot().planting().id();
        clock.advance(Duration.ofSeconds(61));
        var ch = harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(pid)));
        ExecutorService pool = Executors.newFixedThreadPool(6);
        CountDownLatch go = new CountDownLatch(1);
        UUID sameKey = key();
        List<Callable<String>> work = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            UUID k = i < 3 ? sameKey : key();
            work.add(() -> {
                go.await();
                try {
                    return "OK:" + harvest.complete(u, k, new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(0, 0, 0), false)).challengeId();
                } catch (GardenException e) {
                    return e.code;
                }
            });
        }
        List<Future<String>> fs = new ArrayList<>();
        for (var w : work) fs.add(pool.submit(w));
        go.countDown();
        List<String> codes = new ArrayList<>();
        for (var f : fs) codes.add(f.get());
        pool.shutdown();
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_planting WHERE id = ? AND harvested_at IS NOT NULL", Integer.class, pid));
        assertEquals(1, jdbc.queryForObject("SELECT COALESCE(sum(qty),0) FROM public.garden_inventory WHERE user_id = ? AND item_code = 'CROP:WHEAT'", Integer.class, u));
        assertTrue(codes.stream().filter(c -> c.startsWith("OK")).count() >= 1, codes.toString());
        assertTrue(codes.stream().allMatch(c -> c.startsWith("OK") || c.equals("CHALLENGE_DONE")), codes.toString());
        assertLedgerReconciles(u);
    }

    @Test
    void careLimitsAreEnforced() {
        long u = newUser();
        var s = state.state(u);
        planting.plant(u, key(), plotId(s, 6), new GardenDtos.PlantRequest("WHEAT")); // tutorial wheat out of the way
        long pid = planting.plant(u, key(), plotId(s, 1), new GardenDtos.PlantRequest("TOMATO")).plot().planting().id();
        for (int i = 0; i < 3; i++) planting.boost(u, key(), pid, new GardenDtos.BoostRequest("WATER"));
        assertEquals("BOOST_LIMIT", rejected(() -> planting.boost(u, key(), pid, new GardenDtos.BoostRequest("WATER"))).code);
        planting.boost(u, key(), pid, new GardenDtos.BoostRequest("FERTILIZER"));
        assertEquals("BOOST_LIMIT", rejected(() -> planting.boost(u, key(), pid, new GardenDtos.BoostRequest("FERTILIZER_PREMIUM"))).code);
        long other = planting.plant(u, key(), plotId(s, 2), new GardenDtos.PlantRequest("TOMATO")).plot().planting().id();
        assertEquals("NO_ITEM", rejected(() -> planting.boost(u, key(), other, new GardenDtos.BoostRequest("WATER"))).code);
        double boost = jdbc.queryForObject("SELECT boost_fraction FROM public.garden_planting WHERE id = ?", Double.class, pid);
        assertEquals(0.22, boost, 1e-9);
        assertLedgerReconciles(u);
    }

    @Test
    void offlineGrowthFreshnessAndChallengeExpiryFollowServerTime() throws Exception {
        long u = newUser();
        var s = state.state(u);
        planting.plant(u, key(), plotId(s, 6), new GardenDtos.PlantRequest("WHEAT"));
        long pid = planting.plant(u, key(), plotId(s, 1), new GardenDtos.PlantRequest("TOMATO")).plot().planting().id();
        var growing = state.state(u).plots().stream().filter(p -> p.planting() != null && p.planting().id() == pid).findFirst().orElseThrow().planting();
        assertFalse(growing.ready());
        assertEquals(2700, growing.remainingSeconds(), 1.0);
        clock.advance(Duration.ofDays(2)); // learner away for two days
        long before = jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ?", Long.class, u);
        var back = state.state(u);
        state.state(u);
        assertEquals(before, jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ?", Long.class, u),
                "repeated reads change no balance");
        assertTrue(back.plots().stream().filter(p -> p.planting() != null && p.planting().id() == pid).findFirst().orElseThrow().planting().ready());
        var ch = harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(pid)));
        clock.advance(Duration.ofSeconds(301));
        assertEquals("CHALLENGE_EXPIRED", rejected(() -> harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true))).code);
        var ch2 = harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(pid)));
        var res = harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch2.challengeId(), List.of(), true));
        var c = res.harvests().getFirst().components();
        assertEquals(0, c.recall(), "skipped");
        assertEquals(0, c.fresh(), "two days late is not fresh");
        assertEquals(0, c.care());
        assertEquals("NORMAL", res.harvests().getFirst().tier());
    }

    // ================================================================================ learning rewards

    @Test
    void flashcardReviewsAfterCreationRewardWaterXpGoalAndBlessingOnce() {
        long u = newUser();
        Instant beforeGarden = clock.now.minusSeconds(3600);
        long deId = jdbc.queryForObject("SELECT id FROM public.dictionary_entries WHERE word = 'agree'", Long.class);
        jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', '999:1', ?)",
                u, Timestamp.from(beforeGarden));
        state.state(u);
        clock.advance(Duration.ofMinutes(1));
        Instant t = clock.now;
        for (int i = 1; i <= 20; i++) {
            jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', ?, ?)",
                    u, (1000 + i) + ":1", Timestamp.from(t.plusSeconds(i)));
        }
        // repeated reviews of the same card the same day are not rewarded (R2)
        for (int i = 2; i <= 6; i++) {
            jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', ?, ?)",
                    u, "1001:" + i, Timestamp.from(t.plusSeconds(30 + i)));
        }
        // Card Blast / other activity types are not Phase 1 sources
        jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (?, 'CARD_BLAST_PLAYED', 'cb:1', ?)",
                u, Timestamp.from(t.plusSeconds(50)));
        clock.advance(Duration.ofMinutes(2));
        var s = state.state(u);
        assertEquals(3 + 4, s.inventory().water(), "starter 3 + 20 units / 5");
        assertTrue(s.today().goal().done());
        assertTrue(s.today().blessing());
        assertEquals(40 + 30, s.profile().totalXp(), "2 XP per unit + goal");
        assertTrue(s.rewards().unseen());
        assertEquals(4, s.rewards().water());
        assertEquals(25, s.rewards().reviews());
        var again = state.state(u);
        assertEquals(7, again.inventory().water(), "no second reward for the same events");
        assertEquals(70, again.profile().totalXp());
        assertEquals(0, jdbc.queryForObject("""
                SELECT count(*) FROM public.garden_learning_event e JOIN public.garden_profile p ON p.user_id = e.user_id
                WHERE e.user_id = ? AND e.occurred_at < p.created_at""", Integer.class, u), "history before the garden earns nothing");
        state.rewardsSeen(u, key());
        assertFalse(state.state(u).rewards().unseen());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_event_log WHERE user_id = ? AND type = 'BLESSING'", Integer.class, u));
        assertLedgerReconciles(u);
        assertTrue(deId > 0);
    }

    @Test
    void blessingMultipliesTheSalePrice() throws Exception {
        long u = newUser();
        var s = state.state(u);
        long pid = planting.plant(u, key(), plotId(s, 1), new GardenDtos.PlantRequest("WHEAT")).plot().planting().id();
        clock.advance(Duration.ofSeconds(61));
        var ch = harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(pid)));
        var res = harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
        String tier = res.harvests().getFirst().tier();
        for (int i = 1; i <= 20; i++) {
            jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', ?, ?)",
                    u, (5000 + i) + ":1", Timestamp.from(clock.now.plusMillis(i)));
        }
        clock.advance(Duration.ofSeconds(5));
        var sold = sell.sell(u, key(), new GardenDtos.SellRequest(List.of(new GardenDtos.SellLine("WHEAT", tier, 1))));
        assertTrue(sold.blessing(), "the sale ingests learning first");
        double mult = Map.of("NORMAL", 1.0, "GOOD", 1.15, "PERFECT", 1.35, "GOLDEN", 1.75).get(tier);
        assertEquals((long) Math.floor(15 * mult * 1.5 + 1e-9), sold.coinsGained());
        assertLedgerReconciles(u);
    }

    // ================================================================================ invariants

    @Test
    void ledgerIsAppendOnlyAndOwnersAreRestricted() {
        long u = newUser();
        state.state(u);
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_ledger SET delta = 999 WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_ledger WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.users WHERE id = ?", u), "owner FKs are ON DELETE RESTRICT");
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_profile SET coins = -1 WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_inventory SET qty = -1 WHERE user_id = ?", u));
    }
}
