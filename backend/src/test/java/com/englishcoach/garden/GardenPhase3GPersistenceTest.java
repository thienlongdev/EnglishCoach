package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenDtos.BoostRequest;
import com.englishcoach.garden.api.GardenDtos.HarvestCompleteRequest;
import com.englishcoach.garden.api.GardenDtos.HarvestResult;
import com.englishcoach.garden.api.GardenDtos.HarvestStartRequest;
import com.englishcoach.garden.api.GardenDtos.IslandCardView;
import com.englishcoach.garden.api.GardenDtos.IslandView;
import com.englishcoach.garden.api.GardenDtos.PlantRequest;
import com.englishcoach.garden.api.GardenDtos.PlantingView;
import com.englishcoach.garden.api.GardenDtos.TakeReceipt;
import com.englishcoach.garden.api.GardenDtos.TakeView;
import com.englishcoach.garden.api.GardenDtos.TreatRequest;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.HarvestShares;
import com.englishcoach.garden.application.LedgerService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3G on real PostgreSQL 17 + the real migrations through V88: discovery of real, authorized, open gardens only;
 * search and keyset pages; what a visitor is shown and what they can never do; the take that conserves the harvest
 * exactly; every limit and protection; idempotent retries and races (takers against each other, a take against the
 * owner's harvest, two players taking from each other); the owner's notice naming the real taker; isolation of the
 * activity record; and a garden from before V88 that keeps playing unchanged. Each test uses its own user ids.
 */
class GardenPhase3GPersistenceTest {

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static LedgerService ledger;
    static final AtomicLong USERS = new AtomicLong(90_000);
    static final Instant START = Instant.parse("2026-10-09T03:00:00Z"); // 10:00 Vietnam

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(START, "88");
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

    static GardenException rejected(Runnable r) {
        return assertThrows(GardenException.class, r::run);
    }

    /** A real account with a garden at {@code level}, past the tutorial, with its social profile (still new). */
    static long player(GardenTestEnv e, String name, int level) {
        long id = USERS.incrementAndGet();
        e.jdbc.update("INSERT INTO public.users(id, name, email) VALUES (?, ?, ?)", id, name, "private-" + id + "@example.com");
        e.props.getAllowlistUserIds().add(id);
        e.state.state(id);
        e.jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", id);
        long xp = e.ctx.engine().levels().totalXpForLevel(level);
        if (xp > 0) new LedgerService(e.ctx).addXp(id, xp, "TEST_FIXTURE", "TEST", "fixture", null, e.clock.now);
        return id;
    }

    /** A player whose garden joined the social islands long ago (past the introductory protection). */
    static long seasoned(String name) {
        long id = player(env, name, 6);
        Timestamp joined = Timestamp.from(env.clock.now.minus(Duration.ofDays(30)));
        jdbc.update("UPDATE public.garden_social_profile SET created_at = ?, visibility_changed_at = ? WHERE user_id = ?", joined, joined, id);
        return id;
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

    /** A ripe, takeable tomato on {@code slot}: ripened, then past the owner's twenty-minute head start. */
    static long ripeTomato(long user, int slot) {
        long id = plant(user, slot, "TOMATO");
        for (int i = 0; i < 400 && !planting(user, slot).ready(); i++) env.clock.advance(Duration.ofMinutes(30));
        assertTrue(planting(user, slot).ready());
        env.clock.advance(Duration.ofMinutes(45));
        return id;
    }

    static HarvestResult harvest(long user, long plantingId) {
        var ch = env.harvest.start(user, key(), new HarvestStartRequest(List.of(plantingId)));
        return env.harvest.complete(user, key(), new HarvestCompleteRequest(ch.challengeId(), List.of(0, 0, 0), false));
    }

    static TakeReceipt take(long taker, long owner, long plantingId) {
        return env.social.take(taker, key(), handle(owner), plantingId);
    }

    static int qty(long user, String item) {
        return jdbc.queryForObject("SELECT COALESCE(sum(qty), 0) FROM public.garden_inventory WHERE user_id = ? AND item_code = ?",
                Integer.class, user, item);
    }

    static long coins(long user) {
        return jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static long xp(long user) {
        return jdbc.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static int takes() {
        return jdbc.queryForObject("SELECT count(*) FROM public.garden_theft", Integer.class);
    }

    /** Portions of one crop a player holds in every form: whole units count as ten. */
    static int portions(long user, String crop) {
        return qty(user, "CROP:" + crop) * 10 + qty(user, HarvestShares.item(crop));
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

    static List<String> handles(List<IslandCardView> cards) {
        return cards.stream().map(IslandCardView::handle).toList();
    }

    static TakeView takeOf(IslandView island, long plantingId) {
        return island.takes().stream().filter(t -> t.plantingId() == plantingId).findFirst().orElseThrow();
    }

    // ------------------------------------------------------------------ rules and schema

    @Test
    void v88SeedsTheDocumentedRulesAndTheDatabaseRefusesWhatTheServiceNeverDoes() {
        var r = env.ctx.social().rules();
        assertEquals(10, r.portionsPerUnit());
        assertEquals(1000, r.theft().fractionBp());
        assertEquals(List.of(24, 3, 1, 2, 6, 72, 24, 20), List.of(r.theft().windowHours(), r.theft().thiefCap(), r.theft().pairCap(),
                r.theft().victimCap(), r.theft().shieldHours(), r.theft().introHours(), r.theft().reopenHours(), r.theft().ripeGraceMinutes()));
        assertEquals(Set.of("QA_SPROUT", "CRYSTAL_ORCHID"), r.theft().excludedCrops());
        assertEquals(12, r.discovery().pageSize());
        assertEquals(1, env.ctx.social().takeSize(0), "one portion of ten");

        long owner = seasoned("Chủ Vườn Schema");
        long taker = seasoned("Khách Schema");
        long crop = ripeTomato(owner, 1);
        long other = ripeTomato(owner, 2);
        take(taker, owner, crop);
        String insert = "INSERT INTO public.garden_theft(victim_id, thief_id, planting_id, crop_code, portions, unit_portions, op_key, created_at) VALUES (?, ?, ?, 'TOMATO', ?, ?, ?, now())";
        assertThrows(DataAccessException.class, () -> jdbc.update(insert, owner, taker, crop, 1, 10, key()), "a crop is taken from once");
        assertThrows(DataAccessException.class, () -> jdbc.update(insert, owner, taker, other, 2, 10, key()), "never more than a tenth");
        assertThrows(DataAccessException.class, () -> jdbc.update(insert, owner, owner, other, 1, 10, key()), "never from oneself");
        assertThrows(DataAccessException.class, () -> jdbc.update(insert, taker, owner, other, 1, 10, key()), "the planting must be the recorded owner's");
        assertThrows(DataAccessException.class, () -> jdbc.update("UPDATE public.garden_theft SET portions = 1"), "append-only");
        assertThrows(DataAccessException.class, () -> jdbc.update("DELETE FROM public.garden_theft"), "append-only");
        assertThrows(DataAccessException.class, () -> jdbc.update("UPDATE public.garden_social_profile SET handle = 'bad' WHERE user_id = ?", owner));
    }

    // ------------------------------------------------------------------ discovery, search, privacy

    @Test
    void discoveryListsOnlyRealAuthorizedOpenGardensInBoundedPages() {
        long viewer = seasoned("Người Xem");
        List<Long> open = new ArrayList<>();
        for (int i = 0; i < 14; i++) {
            open.add(seasoned("Đảo Mở " + i));
            env.clock.advance(Duration.ofSeconds(1));
        }
        long closed = seasoned("Đảo Đóng");
        env.social.setVisibility(closed, key(), "PRIVATE");
        long noAccess = seasoned("Mất Quyền");
        env.props.getAllowlistUserIds().remove(noAccess);
        long suspended = seasoned("Bị Khóa");
        jdbc.update("UPDATE public.users SET account_status = 'SUSPENDED' WHERE id = ?", suspended);
        long noGarden = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id, name) VALUES (?, 'Không Có Vườn')", noGarden);
        env.props.getAllowlistUserIds().add(noGarden);

        Set<String> expected = new HashSet<>(jdbc.queryForList("""
                SELECT sp.handle FROM public.garden_social_profile sp JOIN public.users u ON u.id = sp.user_id
                WHERE sp.visibility = 'PUBLIC' AND u.account_status = 'ACTIVE' AND sp.user_id <> ? AND sp.user_id = ANY(?)
                """, String.class, viewer, env.props.getAllowlistUserIds().toArray(new Long[0])));
        List<IslandCardView> all = new ArrayList<>();
        String cursor = null;
        int pages = 0;
        do {
            var page = env.social.discover(viewer, cursor, null);
            assertTrue(page.islands().size() <= 12, "a page is bounded");
            assertFalse(page.search());
            all.addAll(page.islands());
            cursor = page.nextCursor();
            pages++;
        } while (cursor != null && pages < 50);
        assertTrue(pages >= 2, "more than one page of islands");
        assertEquals(all.size(), new HashSet<>(handles(all)).size(), "no island twice across pages");
        assertEquals(expected, new HashSet<>(handles(all)), "exactly the open gardens of active accounts with garden access");
        assertTrue(handles(all).containsAll(open.stream().map(GardenPhase3GPersistenceTest::handle).toList()));
        for (long hidden : List.of(viewer, closed, noAccess, suspended)) assertFalse(handles(all).contains(handle(hidden)));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_social_profile WHERE user_id = ?", Integer.class, noGarden),
                "an account that never opened the garden is not a garden player");
        // newest activity first
        assertEquals(handle(open.getLast()), all.stream().filter(c -> open.stream().anyMatch(o -> handle(o).equals(c.handle()))).findFirst().orElseThrow().handle());
        assertEquals(400, rejected(() -> env.social.discover(viewer, "not-a-cursor", null)).status);

        // a player without garden access is told nothing
        assertEquals(404, rejected(() -> env.social.discover(noAccess, null, null)).status);
        assertEquals(404, rejected(() -> env.social.visit(noAccess, handle(open.getFirst()))).status);
    }

    @Test
    void searchFindsByPublicNameOrHandleAndNothingPrivateLeaves() throws Exception {
        long viewer = seasoned("Người Tìm");
        long anh = seasoned("Nguyễn Đức Anh");
        long lan = player(env, "Lan (lan.tran@example.com)", 3);
        long framed = seasoned("tên tài khoản");
        jdbc.update("INSERT INTO public.user_profiles(user_id, display_name) VALUES (?, 'Trà My Vườn Xanh')", framed);
        env.state.state(framed);
        long closed = seasoned("Nguyễn Đức Ẩn");
        env.social.setVisibility(closed, key(), "PRIVATE");

        assertEquals(List.of(handle(anh)), handles(env.social.discover(viewer, null, "nguyen duc").islands()), "folded prefix, the closed island excluded");
        assertEquals(List.of(handle(anh)), handles(env.social.discover(viewer, null, "  NGUYỄN đức a").islands()));
        assertEquals(List.of(handle(framed)), handles(env.social.discover(viewer, null, "tra my").islands()), "the profile display name wins");
        assertTrue(env.social.discover(viewer, null, "ten tai khoan").islands().isEmpty(), "the account name is not searchable once a display name exists");
        assertEquals(List.of(handle(anh)), handles(env.social.discover(viewer, null, "eg-" + handle(anh).toLowerCase()).islands()), "exact handle");
        assertTrue(env.social.discover(viewer, null, handle(closed)).islands().isEmpty(), "a closed island is not found by its handle either");
        assertTrue(env.social.discover(viewer, null, "100% _").islands().isEmpty(), "wildcards are text");
        assertEquals("SEARCH_TOO_SHORT", rejected(() -> env.social.discover(viewer, null, "n")).code);
        assertTrue(env.social.discover(viewer, null, "khong ton tai").islands().isEmpty(), "a real empty result");

        var lanCard = env.social.discover(viewer, null, "lan").islands().stream().filter(c -> c.handle().equals(handle(lan))).findFirst().orElseThrow();
        assertEquals("Lan", lanCard.name(), "an address inside a name never becomes public");
        assertEquals(3, lanCard.level());
        assertEquals(6, lanCard.beds());

        String json = env.json.writeValueAsString(env.social.discover(viewer, null, null))
                + env.json.writeValueAsString(env.social.discover(viewer, null, "lan"))
                + env.json.writeValueAsString(env.social.visit(viewer, handle(anh)))
                + env.json.writeValueAsString(env.social.me(viewer));
        assertFalse(json.contains("@"), "no e-mail address");
        assertFalse(json.contains("example.com"));
        for (String forbidden : List.of("\"userId\"", "\"email\"", "\"coins\"", "\"inventory\"", "\"totalXp\"", "\"word\"", "\"flashcardId\"")) {
            assertFalse(json.contains(forbidden), forbidden + " never leaves the server");
        }
        for (long id : List.of(viewer, anh, lan, framed, closed)) assertFalse(json.contains(":" + id + ",") || json.contains(":" + id + "}"), "no account id");
    }

    // ------------------------------------------------------------------ visiting

    @Test
    void aVisitShowsTheRealIslandAndAVisitorCanChangeNothingOfIt() {
        long owner = seasoned("Chủ Đảo Thăm");
        long visitor = seasoned("Khách Thăm");
        long ripe = ripeTomato(owner, 1);
        long growing = plant(owner, 2, "CORN");
        long ownerCoins = coins(owner);

        IslandView island = env.social.visit(visitor, handle(owner));
        assertEquals("Chủ Đảo Thăm", island.owner().name());
        assertEquals(handle(owner), island.owner().handle());
        assertEquals(6, island.plots().size());
        var bed1 = island.plots().stream().filter(p -> p.slot() == 1).findFirst().orElseThrow();
        assertEquals("TOMATO", bed1.planting().cropCode());
        assertTrue(bed1.planting().ready());
        assertNull(bed1.planting().pestId());
        assertEquals("CORN", island.plots().stream().filter(p -> p.slot() == 2).findFirst().orElseThrow().planting().cropCode());
        assertEquals(2, island.takes().size(), "one entry per planted bed");
        assertTrue(takeOf(island, ripe).eligible());
        assertEquals(1, takeOf(island, ripe).portions());
        assertEquals("NOT_READY", takeOf(island, growing).reason());
        assertNotNull(island.cosmetics(), "what the island wears");
        assertEquals(0, island.monument().era());
        assertFalse(island.protection().active());
        assertTrue(island.standing().canTake());
        assertEquals(1, jdbc.queryForObject("SELECT visits FROM public.garden_visit WHERE visitor_id = ? AND host_id = ?", Integer.class, visitor, owner));
        env.social.visit(visitor, handle(owner));
        assertEquals(2, jdbc.queryForObject("SELECT visits FROM public.garden_visit WHERE visitor_id = ? AND host_id = ?", Integer.class, visitor, owner));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_visit WHERE visitor_id = ?", Integer.class, visitor), "one row per island");
        assertEquals(List.of(handle(owner)), handles(env.social.visited(visitor).islands()));
        assertNotNull(env.social.visited(visitor).islands().getFirst().visitedAt());

        // every existing command acts on the caller's own garden: the owner's ids are simply not found
        long ownerPlot = plotId(owner, 3);
        assertEquals("PLOT_NOT_FOUND", rejected(() -> env.planting.plant(visitor, key(), ownerPlot, new PlantRequest("WHEAT"))).code);
        assertEquals("PLANTING_NOT_FOUND", rejected(() -> env.planting.boost(visitor, key(), growing, new BoostRequest("WATER"))).code);
        assertEquals("PLANTING_NOT_FOUND", rejected(() -> env.farming.treat(visitor, key(), growing, new TreatRequest("WELL_WATER"))).code);
        assertEquals("PLANTING_NOT_FOUND", rejected(() -> env.harvest.start(visitor, key(), new HarvestStartRequest(List.of(ripe)))).code);
        assertNull(planting(owner, 3), "nothing was planted on the owner's bed");
        assertEquals(0, planting(owner, 2).waterCount());
        assertEquals(ownerCoins, coins(owner));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_planting WHERE id = ? AND harvested_at IS NOT NULL", Integer.class, ripe));

        assertEquals("OWN_ISLAND", rejected(() -> env.social.visit(owner, handle(owner))).code);
        assertEquals(404, rejected(() -> env.social.visit(visitor, "ZZZZZZZZ")).status);
        assertEquals(404, rejected(() -> env.social.visit(visitor, "not a handle")).status);
        env.social.setVisibility(owner, key(), "PRIVATE");
        assertEquals("ISLAND_NOT_FOUND", rejected(() -> env.social.visit(visitor, handle(owner))).code, "a closed island looks like no island");
        assertEquals("ISLAND_NOT_FOUND", rejected(() -> take(visitor, owner, ripe)).code);
        assertTrue(env.social.visited(visitor).islands().isEmpty(), "and leaves the visited list while it is closed");
    }

    // ------------------------------------------------------------------ the take

    @Test
    void aTakeMovesOnePortionAndTheOwnersHarvestPaysExactlyTheRest() {
        long owner = seasoned("Chủ Vườn Cà Chua");
        long taker = seasoned("Minh");
        long crop = ripeTomato(owner, 1);
        long ownerCoins = coins(owner);
        long ownerXp = xp(owner);
        long takerCoins = coins(taker);
        long takerXp = xp(taker);
        int ownerBefore = portions(owner, "TOMATO");

        TakeReceipt r = take(taker, owner, crop);
        assertEquals(1, r.portions());
        assertEquals(10, r.unitPortions());
        assertEquals("NORMAL", r.tier(), "the taker answered no recall question");
        assertEquals(1, r.sharesNow());
        assertEquals(0, r.unitsMerged());
        assertEquals(2, r.standing().takesLeft());
        assertTrue(r.protection().active());
        assertEquals("ISLAND_SHIELD", r.protection().reason());
        assertEquals(1, qty(taker, "SHARE:TOMATO"));
        assertEquals(0, qty(taker, "CROP:TOMATO"), "a fragment is not a produce unit");
        assertEquals(takerCoins, coins(taker), "no coins for the taker");
        assertEquals(takerXp, xp(taker), "no XP for the taker");
        assertEquals(ownerCoins, coins(owner), "no coin ever leaves the owner");
        assertEquals(ownerXp, xp(owner));
        assertTrue(planting(owner, 1).ready(), "the crop still stands, still ripe");
        assertEquals(1, env.state.state(owner).social().taken().get(crop), "the owner's own screen knows a little was taken");

        HarvestResult h = harvest(owner, crop);
        var line = h.harvests().getFirst();
        assertEquals(9, line.sharePortions());
        assertEquals(10, line.shareUnit());
        assertTrue(line.coins() > 0, "the owner's harvest bonus is untouched");
        assertEquals(9, qty(owner, "SHARE:TOMATO"));
        assertEquals(ownerBefore + 9, portions(owner, "TOMATO"));
        assertEquals(10, portions(taker, "TOMATO") + portions(owner, "TOMATO") - ownerBefore, "taker + owner = one unit, nothing created, nothing lost");
        assertEquals(line.tier(), jdbc.queryForObject("SELECT tier FROM public.garden_inventory WHERE user_id = ? AND item_code = 'SHARE:TOMATO'", String.class, owner),
                "the owner's rest keeps the quality they earned");
        assertNull(planting(owner, 1), "the bed is free again like after any harvest");
        assertLedgerReconciles(owner);
        assertLedgerReconciles(taker);

        // an untouched crop still pays its whole unit
        long plain = ripeTomato(owner, 2);
        var whole = harvest(owner, plain).harvests().getFirst();
        assertEquals(0, whole.sharePortions());
        assertEquals(ownerBefore + 19, portions(owner, "TOMATO"));
    }

    @Test
    void fragmentsOfOneCropAndQualityBecomeAWholeUnit() {
        long owner = seasoned("Chủ Vườn Gộp");
        long taker = seasoned("Người Gom");
        ledger.addItem(taker, "SHARE:TOMATO", "NORMAL", 9, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        TakeReceipt r = take(taker, owner, ripeTomato(owner, 1));
        assertEquals(1, r.unitsMerged());
        assertEquals(0, r.sharesNow());
        assertEquals(0, qty(taker, "SHARE:TOMATO"));
        assertEquals(1, qty(taker, "CROP:TOMATO"));
        assertLedgerReconciles(taker);
    }

    @Test
    void protectionsOfTheIslandAndOfTheCrop() {
        long owner = player(env, "Đảo Mới Tinh", 6);
        long taker = seasoned("Khách Kiên Nhẫn");
        long first = plant(owner, 1, "WHEAT"); // the very first crop of a garden is its tutorial crop
        for (int i = 0; i < 20 && !planting(owner, 1).ready(); i++) env.clock.advance(Duration.ofMinutes(10));
        env.clock.advance(Duration.ofMinutes(30));
        int before = takes();

        assertEquals("ISLAND_NEW", rejected(() -> take(taker, owner, first)).code, "a garden new to the islands is protected");
        var island = env.social.visit(taker, handle(owner));
        assertTrue(island.protection().active());
        assertEquals("ISLAND_NEW", island.protection().reason());
        assertNotNull(island.protection().until());
        assertEquals("THIEF_NEW", rejected(() -> take(owner, taker, ripeTomato(taker, 1))).code, "and cannot take either");

        env.clock.advance(Duration.ofHours(73));
        assertEquals("CROP_EXCLUDED", rejected(() -> take(taker, owner, first)).code, "the tutorial crop is never taken");
        long growing = plant(owner, 2, "TOMATO");
        assertEquals("NOT_READY", rejected(() -> take(taker, owner, growing)).code);
        for (int i = 0; i < 400 && !planting(owner, 2).ready(); i++) env.clock.advance(Duration.ofMinutes(5));
        var fresh = rejected(() -> take(taker, owner, growing));
        assertEquals("CROP_FRESH", fresh.code, "the owner has a head start on a crop that just ripened");
        assertNotNull(fresh.details.get("availableAt"));
        assertEquals(before, takes(), "a refused attempt records nothing");
        assertEquals(0, qty(taker, "SHARE:TOMATO"), "and earns nothing");
        assertTrue(env.notices.stream().noneMatch(n -> n.ownerId() == owner), "and tells nobody");

        env.clock.advance(Duration.ofMinutes(21));
        assertEquals(1, take(taker, owner, growing).portions());
        assertEquals("PLANTING_NOT_FOUND", rejected(() -> take(taker, owner, 999_999_999L)).code);
        long mine = ripeTomato(taker, 2);
        assertEquals("OWN_ISLAND", rejected(() -> env.social.take(taker, key(), handle(taker), mine)).code);
        // a planting of a third player can never be reached through someone else's island
        assertEquals("PLANTING_NOT_FOUND", rejected(() -> take(seasoned("Người Thứ Ba"), owner, mine)).code);
    }

    @Test
    void dailyLimitsForTheTakerThePairAndTheIsland() {
        long owner = seasoned("Đảo Nhiều Cây");
        long a = seasoned("Khách A");
        long b = seasoned("Khách B");
        long c = seasoned("Khách C");
        long crop1 = ripeTomato(owner, 1);
        long crop2 = ripeTomato(owner, 2);
        long crop3 = ripeTomato(owner, 3);

        take(a, owner, crop1);
        var shield = rejected(() -> take(b, owner, crop2));
        assertEquals("ISLAND_SHIELD", shield.code, "protected right after a take, whoever comes");
        env.clock.advance(Duration.ofHours(7));
        assertEquals("CROP_TAKEN", rejected(() -> take(b, owner, crop1)).code, "the same crop is never taken from twice");
        assertEquals("PAIR_LIMIT", rejected(() -> take(a, owner, crop2)).code, "one take per island a day");
        take(b, owner, crop2);
        env.clock.advance(Duration.ofHours(7));
        var capped = rejected(() -> take(c, owner, crop3));
        assertEquals("VICTIM_LIMIT", capped.code, "an island loses at most two portions a day, however many visitors coordinate");
        assertEquals(2, jdbc.queryForObject("SELECT COALESCE(sum(portions), 0) FROM public.garden_theft WHERE victim_id = ?", Integer.class, owner));
        env.clock.advance(Duration.ofHours(11));
        assertEquals(1, take(c, owner, crop3).portions(), "free again once the oldest take is a day old");

        // a taker's own limit over all islands
        long greedy = seasoned("Khách Tham");
        for (int i = 0; i < 3; i++) {
            long host = seasoned("Đảo Hào Phóng " + i);
            assertEquals(2 - i, take(greedy, host, ripeTomato(host, 1)).standing().takesLeft());
        }
        long fourth = seasoned("Đảo Thứ Tư");
        long ripe = ripeTomato(fourth, 1);
        var limit = rejected(() -> take(greedy, fourth, ripe));
        assertEquals("THIEF_LIMIT", limit.code);
        assertFalse(env.social.me(greedy).standing().canTake());
        assertEquals(0, env.social.me(greedy).standing().takesLeft());
        assertFalse(takeOf(env.social.visit(greedy, handle(fourth)), ripe).eligible());
        assertEquals(3, qty(greedy, "SHARE:TOMATO"));
    }

    @Test
    void aClosedIslandCannotTakeAndAReopenedOneWaits() {
        long owner = seasoned("Đảo Hiền Lành");
        long shy = seasoned("Người Kín Đáo");
        long crop = ripeTomato(owner, 1);
        var closed = env.social.setVisibility(shy, key(), "PRIVATE");
        assertEquals("PRIVATE", closed.visibility());
        assertTrue(closed.protection().active());
        assertEquals("PRIVATE", closed.protection().reason());
        assertFalse(closed.standing().canTake());
        assertEquals("THIEF_PRIVATE", rejected(() -> take(shy, owner, crop)).code);
        assertNotNull(env.social.visit(shy, handle(owner)), "a closed island may still visit");
        env.social.setVisibility(shy, key(), "PUBLIC");
        assertEquals("THIEF_REOPENED", rejected(() -> take(shy, owner, crop)).code, "closing to dodge and reopening to take does not work");
        Instant changed = env.socialRepo.profile(shy).visibilityChangedAt();
        env.social.setVisibility(shy, key(), "PUBLIC");
        assertEquals(changed, env.socialRepo.profile(shy).visibilityChangedAt(), "setting the same visibility again changes nothing");
        env.clock.advance(Duration.ofHours(25));
        assertEquals(1, take(shy, owner, crop).portions());
    }

    // ------------------------------------------------------------------ retries and races

    @Test
    void aRetryNeverTakesTwice() {
        long owner = seasoned("Đảo Thử Lại");
        long taker = seasoned("Khách Mạng Yếu");
        long crop = ripeTomato(owner, 1);
        long other = ripeTomato(owner, 2);
        UUID key = key();
        TakeReceipt first = env.social.take(taker, key, handle(owner), crop);
        TakeReceipt again = env.social.take(taker, key, handle(owner), crop);
        assertEquals(first, again, "the stored result is replayed");
        assertEquals(1, qty(taker, "SHARE:TOMATO"));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_theft WHERE thief_id = ?", Integer.class, taker));
        assertEquals(1, env.notices.stream().filter(n -> n.ownerId() == owner).count(), "one notice per take");
        assertEquals(422, rejected(() -> env.social.take(taker, key, handle(owner), other)).status, "a key belongs to one action");
        assertEquals(400, rejected(() -> env.social.take(taker, null, handle(owner), other)).status);
    }

    @Test
    void manyVisitorsAtOnceTakeOnePortionBetweenThem() throws Exception {
        long owner = seasoned("Đảo Đông Khách");
        long crop = ripeTomato(owner, 1);
        List<Long> visitors = new ArrayList<>();
        for (int i = 0; i < 6; i++) visitors.add(seasoned("Khách Đua " + i));
        String handle = handle(owner);
        List<Callable<TakeReceipt>> calls = new ArrayList<>();
        for (long v : visitors) calls.add(() -> env.social.take(v, key(), handle, crop));
        List<Object> results = race(calls);
        assertEquals(1, results.stream().filter(r -> r instanceof TakeReceipt).count(), "exactly one take succeeds");
        for (Object r : results) {
            if (r instanceof TakeReceipt) continue;
            assertInstanceOf(GardenException.class, r);
            assertTrue(Set.of("ISLAND_SHIELD", "CROP_TAKEN").contains(((GardenException) r).code), ((GardenException) r).code);
        }
        assertEquals(1, visitors.stream().mapToInt(v -> qty(v, "SHARE:TOMATO")).sum(), "one portion in total");
        assertEquals(9, harvest(owner, crop).harvests().getFirst().sharePortions());
    }

    @Test
    void aTakeRacingTheOwnersHarvestSettlesToExactlyOneUnit() throws Exception {
        for (int round = 0; round < 4; round++) {
            long owner = seasoned("Chủ Vườn Nhanh Tay " + round);
            long taker = seasoned("Khách Nhanh Tay " + round);
            long crop = ripeTomato(owner, 1);
            int ownerBefore = portions(owner, "TOMATO");
            var challenge = env.harvest.start(owner, key(), new HarvestStartRequest(List.of(crop)));
            String handle = handle(owner);
            List<Callable<Object>> calls = List.of(
                    () -> env.harvest.complete(owner, key(), new HarvestCompleteRequest(challenge.challengeId(), List.of(0, 0, 0), false)),
                    () -> env.social.take(taker, key(), handle, crop));
            List<Object> results = race(calls);
            assertInstanceOf(HarvestResult.class, results.get(0), "the owner always harvests");
            int taken = portions(taker, "TOMATO");
            int owned = portions(owner, "TOMATO") - ownerBefore;
            assertEquals(10, taken + owned, "one unit, whoever was first");
            if (results.get(1) instanceof TakeReceipt) {
                assertEquals(1, taken);
                assertEquals(9, ((HarvestResult) results.get(0)).harvests().getFirst().sharePortions());
            } else {
                assertEquals("ALREADY_HARVESTED", ((GardenException) results.get(1)).code);
                assertEquals(0, taken);
            }
            assertLedgerReconciles(owner);
            assertLedgerReconciles(taker);
        }
    }

    @Test
    void twoPlayersTakingFromEachOtherAtOnceBothFinish() throws Exception {
        for (int round = 0; round < 3; round++) {
            long x = seasoned("Hàng Xóm X " + round);
            long y = seasoned("Hàng Xóm Y " + round);
            long cropX = ripeTomato(x, 1);
            long cropY = ripeTomato(y, 1);
            String hx = handle(x);
            String hy = handle(y);
            List<Callable<TakeReceipt>> calls = List.of(() -> env.social.take(x, key(), hy, cropY), () -> env.social.take(y, key(), hx, cropX));
            for (Object r : race(calls)) assertInstanceOf(TakeReceipt.class, r, "no deadlock, no lost take");
            assertEquals(1, qty(x, "SHARE:TOMATO"));
            assertEquals(1, qty(y, "SHARE:TOMATO"));
        }
    }

    // ------------------------------------------------------------------ the owner is told

    @Test
    void theOwnerIsToldWhoTookWhatAndWhenAndNobodyElseSeesIt() {
        long owner = seasoned("Chủ Vườn Được Báo");
        long taker = seasoned("Minh Trộm Vặt");
        long stranger = seasoned("Người Dưng");
        long crop = ripeTomato(owner, 1);
        Instant at = env.clock.now;
        TakeReceipt r = take(taker, owner, crop);

        var notices = env.notices.stream().filter(n -> n.ownerId() == owner).toList();
        assertEquals(1, notices.size());
        var notice = notices.getFirst();
        assertEquals("GARDEN_TAKE:" + r.takeId(), notice.dedupeKey());
        assertEquals("/games/echo-garden?social=activity", notice.actionUrl());
        assertTrue(notice.body().contains("Người chơi Minh Trộm Vặt"), notice.body());
        assertTrue(notice.body().contains("EG-" + handle(taker)), "the taker's island reference");
        String tomato = jdbc.queryForObject("SELECT name_vi FROM public.garden_crop_def WHERE code = 'TOMATO'", String.class);
        assertTrue(notice.body().contains("1 phần " + tomato + " chín"), notice.body());
        String time = java.time.format.DateTimeFormatter.ofPattern("HH:mm 'ngày' dd/MM/yyyy").format(at.atZone(java.time.ZoneId.of("Asia/Ho_Chi_Minh")));
        assertTrue(notice.body().contains(time), "the server time of the take, Vietnam time: " + notice.body());
        assertFalse(notice.body().contains("@"));
        assertTrue(env.notices.stream().noneMatch(n -> n.ownerId() == taker || n.ownerId() == stranger), "only the owner is told");

        var mine = env.social.activity(owner, null);
        assertEquals(1, mine.unread());
        var entry = mine.entries().getFirst();
        assertEquals("TAKEN_FROM_ME", entry.kind());
        assertEquals("Minh Trộm Vặt", entry.otherName());
        assertEquals(handle(taker), entry.otherHandle());
        assertEquals("TOMATO", entry.cropCode());
        assertEquals(tomato, entry.nameVi());
        assertEquals(1, entry.portions());
        assertEquals(10, entry.unitPortions());
        assertEquals(at, entry.at());
        assertTrue(entry.unread());
        assertEquals(1, env.state.state(owner).social().unread(), "the garden's own unread mark");

        var theirs = env.social.activity(taker, null);
        assertEquals("I_TOOK", theirs.entries().getFirst().kind());
        assertEquals("Chủ Vườn Được Báo", theirs.entries().getFirst().otherName());
        assertEquals(0, theirs.unread(), "what you took yourself is not news");
        assertTrue(env.social.activity(stranger, null).entries().isEmpty(), "a third player's record is empty");
        assertEquals(0, env.state.state(stranger).social().unread());

        env.social.activitySeen(owner, key());
        assertEquals(0, env.social.activity(owner, null).unread());
        assertFalse(env.social.activity(owner, null).entries().getFirst().unread());
        assertEquals(0, env.state.state(owner).social().unread());

        // the record keeps naming the real taker after they close their island; only the link goes away
        env.social.setVisibility(taker, key(), "PRIVATE");
        var later = env.social.activity(owner, null).entries().getFirst();
        assertEquals("Minh Trộm Vặt", later.otherName());
        assertNull(later.otherHandle());
    }

    @Test
    void theActivityRecordPagesNewestFirst() {
        long taker = seasoned("Khách Chăm Chỉ");
        jdbc.update("UPDATE public.garden_config SET value = jsonb_set(value, '{theft,thiefCap}', '50') WHERE key = 'social'");
        GardenTestEnv roomy = new GardenTestEnv(env, env.clock.now, "88"); // same database, rules loaded again
        try {
            List<Long> ids = new ArrayList<>();
            for (int i = 0; i < 23; i++) {
                long host = seasoned("Đảo Trang " + i);
                long crop = plant(host, 1, "TOMATO");
                for (int t = 0; t < 400 && !planting(host, 1).ready(); t++) env.clock.advance(Duration.ofMinutes(30));
                env.clock.advance(Duration.ofMinutes(45));
                roomy.clock.now = env.clock.now;
                ids.add(roomy.social.take(taker, key(), handle(host), crop).takeId());
            }
            var first = roomy.social.activity(taker, null);
            assertEquals(20, first.entries().size());
            assertNotNull(first.nextBefore());
            assertEquals(ids.getLast(), first.entries().getFirst().id(), "newest first");
            var second = roomy.social.activity(taker, first.nextBefore());
            assertEquals(3, second.entries().size());
            assertNull(second.nextBefore());
            assertEquals(ids.getFirst(), second.entries().getLast().id());
        } finally {
            jdbc.update("UPDATE public.garden_config SET value = jsonb_set(value, '{theft,thiefCap}', '3') WHERE key = 'social'");
        }
    }

    // ------------------------------------------------------------------ a friendly reaction

    @Test
    void aVisitorMayLeaveOnePresetReactionADay() {
        long owner = seasoned("Đảo Hiếu Khách");
        long visitor = seasoned("Khách Lịch Sự");
        env.clock.advance(Duration.ofMinutes(1));
        assertEquals("VISIT_FIRST", rejected(() -> env.social.react(visitor, key(), handle(owner), "GARDEN_BEAUTIFUL")).code);
        env.social.visit(visitor, handle(owner));
        assertEquals(400, rejected(() -> env.social.react(visitor, key(), handle(owner), "FREE_TEXT")).status, "presets only");
        var r = env.social.react(visitor, key(), handle(owner), "GARDEN_BEAUTIFUL");
        assertEquals("GARDEN_BEAUTIFUL", r.code());
        assertEquals("REACTION_COOLDOWN", rejected(() -> env.social.react(visitor, key(), handle(owner), "GOOD_HARVEST")).code);
        assertEquals("GARDEN_BEAUTIFUL", env.social.visit(visitor, handle(owner)).myReaction());
        var page = env.social.activity(owner, null);
        assertEquals(1, page.reactions().size());
        assertEquals("Khách Lịch Sự", page.reactions().getFirst().visitorName());
        assertEquals("GARDEN_BEAUTIFUL", page.reactions().getFirst().code());
        assertEquals(1, page.unread());
        assertTrue(env.social.activity(visitor, null).reactions().isEmpty());
        env.clock.advance(Duration.ofHours(25));
        assertEquals("GOOD_HARVEST", env.social.react(visitor, key(), handle(owner), "GOOD_HARVEST").code());
        assertEquals(1, env.social.activity(owner, null).reactions().size(), "one line per visitor");
    }

    // ------------------------------------------------------------------ a garden from before V88

    @Test
    void aGardenFromBeforeTheSocialIslandsKeepsPlayingUnchanged() {
        try (GardenTestEnv before = new GardenTestEnv(START, "87")) {
            long user = USERS.incrementAndGet();
            before.jdbc.update("INSERT INTO public.users(id, name) VALUES (?, 'Nông Dân Cũ')", user);
            before.props.getAllowlistUserIds().add(user);
            var state = before.state.state(user);
            assertNull(state.social(), "no social islands on a database without V88");
            assertNull(before.ctx.social());
            before.jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", user);
            long plot = state.plots().getFirst().id();
            long tutorial = before.planting.plant(user, key(), plot, new PlantRequest("WHEAT")).plot().planting().id();
            before.clock.advance(Duration.ofMinutes(2));
            var ch = before.harvest.start(user, key(), new HarvestStartRequest(List.of(tutorial)));
            var line = before.harvest.complete(user, key(), new HarvestCompleteRequest(ch.challengeId(), List.of(0, 0, 0), false)).harvests().getFirst();
            assertEquals(0, line.sharePortions(), "a harvest pays its whole unit exactly as before");
            assertEquals(1, before.jdbc.queryForObject("SELECT sum(qty) FROM public.garden_inventory WHERE user_id = ? AND item_code = 'CROP:WHEAT'", Integer.class, user));
            assertEquals("SOCIAL_CLOSED", assertThrows(GardenException.class, () -> before.social.me(user)).code);
            long growing = before.planting.plant(user, key(), plot, new PlantRequest("WHEAT")).plot().planting().id();
            long coinsBefore = before.jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);

            // the release: the same database, migrated to V88
            GardenTestEnv after = new GardenTestEnv(before, before.clock.now, "88");
            after.props.getAllowlistUserIds().add(user);
            var upgraded = after.state.state(user);
            assertEquals(coinsBefore, upgraded.profile().coins(), "balances untouched");
            assertEquals(growing, upgraded.plots().getFirst().planting().id(), "the growing crop is still there");
            assertEquals("PUBLIC", upgraded.social().visibility());
            assertEquals(0, upgraded.social().unread());
            assertTrue(after.social.me(user).protection().active(), "newly on the islands: protected first");
            assertEquals("ISLAND_NEW", after.social.me(user).protection().reason());
            assertEquals("Nông Dân Cũ", after.social.me(user).name());
            for (int i = 0; i < 400 && !after.state.state(user).plots().getFirst().planting().ready(); i++) after.clock.advance(Duration.ofMinutes(30));
            var ch2 = after.harvest.start(user, key(), new HarvestStartRequest(List.of(growing)));
            assertEquals(0, after.harvest.complete(user, key(), new HarvestCompleteRequest(ch2.challengeId(), List.of(0, 0, 0), false))
                    .harvests().getFirst().sharePortions(), "an untouched crop planted before the release pays its whole unit");
            assertEquals(2, after.jdbc.queryForObject("SELECT sum(qty) FROM public.garden_inventory WHERE user_id = ? AND item_code = 'CROP:WHEAT'", Integer.class, user));
        }
    }
}
