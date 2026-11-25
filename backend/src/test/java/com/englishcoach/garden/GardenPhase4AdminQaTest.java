package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenDtos.AnimalHouseView;
import com.englishcoach.garden.api.GardenDtos.CosmeticBuyRequest;
import com.englishcoach.garden.api.GardenDtos.CosmeticEquipRequest;
import com.englishcoach.garden.api.GardenDtos.CosmeticItemView;
import com.englishcoach.garden.api.GardenDtos.DecorPlaceRequest;
import com.englishcoach.garden.api.GardenDtos.PlantRequest;
import com.englishcoach.garden.api.GardenDtos.SkinEquipRequest;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.LedgerService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 4 on real PostgreSQL 17 + the real migrations through V90: the official administrator's QA access. Only the
 * one account the identity check confirms may use it, on its own garden; it reaches every cosmetic, every cultivar,
 * every animal house, species and guardian without a coin, an order, a level or an achievement; everything it grants
 * says ADMIN_QA and can be taken back; and an ordinary player keeps every lock, whatever they send.
 *
 * <p>There is ONE administrator id, so the tests that change the administrator's garden run in a fixed order.</p>
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class GardenPhase4AdminQaTest {

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static LedgerService ledger;
    static final long ADMIN = GardenTestEnv.ADMIN;
    static final AtomicLong USERS = new AtomicLong(160_000);

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(Instant.parse("2026-10-09T03:00:00Z"), "90");
        jdbc = env.jdbc;
        ledger = new LedgerService(env.ctx);
        // the administrator's garden: level 1, the starter balance — QA must need neither level nor coins
        jdbc.update("INSERT INTO public.users(id, name, email) VALUES (?, 'Administrator', 'admin@example.test')", ADMIN);
        env.state.state(ADMIN);
        jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", ADMIN);
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

    /** An ordinary player at {@code level} with {@code coins} more Đồng Echo. */
    static long player(int level, long coins) {
        long id = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id, name, email) VALUES (?, ?, ?)", id, "Learner " + id, "private-" + id + "@example.com");
        env.state.state(id);
        jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", id);
        long xp = env.ctx.engine().levels().totalXpForLevel(level);
        if (xp > 0) ledger.addXp(id, xp, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        if (coins > 0) ledger.addCoins(id, coins, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        return id;
    }

    static long coins(long user) {
        return jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static int count(String sql, Object... args) {
        return jdbc.queryForObject(sql, Integer.class, args);
    }

    static void assertLedgerReconciles(long user) {
        assertEquals(coins(user), jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND asset = 'COIN'",
                Long.class, user), "coins reconcile with the ledger");
        assertEquals(0, count("""
                SELECT count(*) FROM (SELECT asset, tier, sum(delta) s FROM public.garden_ledger WHERE user_id = ? AND asset NOT IN ('COIN','XP','ESSENCE')
                GROUP BY asset, tier) l LEFT JOIN public.garden_inventory i ON i.user_id = ? AND i.item_code = l.asset AND i.tier = l.tier
                WHERE COALESCE(i.qty, 0) <> l.s""", user, user), "inventory reconciles with the ledger");
    }

    static CosmeticItemView item(long user, String code) {
        return env.cosmetics.shop(user).items().stream().filter(i -> i.code().equals(code)).findFirst().orElseThrow();
    }

    // ================================================================================ who may use it

    @Test
    @Order(1)
    void theSchemaRecordsAQaGrantAsItsOwnSourceAndNeverAsAPayment() {
        assertTrue(env.adminQa.available(ADMIN));
        assertEquals(2, count("""
                SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'source'
                  AND table_name IN ('garden_animal', 'garden_animal_house')"""));
        assertEquals(0, count("SELECT count(*) FROM public.garden_animal WHERE source <> 'PLAYER'"), "every existing row is a player's");
        // a QA cultivar can never carry a price, and no table accepts an invented source
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_skin_owned(user_id, skin_code, source, coins_paid, op_key, acquired_at)
                VALUES (?, 'WHEAT_BLOSSOM', 'ADMIN_QA', 100, ?, now())""", ADMIN, key()));
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_animal_house(user_id, code, built_at, watered_until, source) VALUES (?, 'COOP', now(), now(), 'GIFT')""", ADMIN));
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_cosmetic_acquisition(user_id, cosmetic_code, unit_no, source, coins_paid, op_key, created_at)
                VALUES (?, 'HOUSE_FROST', 1, 'FREE', 0, ?, now())""", ADMIN, key()));
    }

    @Test
    @Order(2)
    void anOrdinaryPlayerIsRefusedByEveryQaCommandAndNothingIsWritten() {
        long u = player(20, 500_000); // rich and high level: still not the administrator
        assertFalse(env.adminQa.available(u));
        List<Runnable> attempts = List.of(
                () -> env.adminQa.status(u),
                () -> env.adminQa.unlockCosmetics(u, key()),
                () -> env.adminQa.revokeCosmetics(u, key()),
                () -> env.adminQa.provisionAnimals(u, key()),
                () -> env.adminQa.advanceAnimals(u, key(), 24));
        for (Runnable attempt : attempts) {
            GardenException e = rejected(attempt);
            assertEquals(403, e.status);
            assertEquals("ADMIN_QA_FORBIDDEN", e.code);
        }
        assertEquals(0, count("SELECT count(*) FROM public.garden_cosmetic_owned WHERE user_id = ?", u));
        assertEquals(0, count("SELECT count(*) FROM public.garden_skin_owned WHERE user_id = ? AND source = 'ADMIN_QA'", u));
        assertEquals(0, count("SELECT count(*) FROM public.garden_animal WHERE user_id = ?", u));
        assertEquals(0, count("SELECT count(*) FROM public.garden_animal_house WHERE user_id = ?", u));
        assertEquals(0, count("SELECT count(*) FROM public.garden_operation WHERE user_id = ? AND op_type LIKE 'ADMIN_QA%'", u));
        assertEquals(0, count("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'ADMIN_QA'", u));
        // the ordinary rules still bind this player: an earned item stays locked, an unowned one cannot be worn
        CosmeticItemView earned = env.cosmetics.shop(u).items().stream().filter(i -> !"COIN".equals(i.unlockKind())).findFirst().orElseThrow();
        assertEquals("LOCKED", earned.status());
        assertEquals("COSMETIC_LOCKED", rejected(() -> env.cosmetics.buy(u, key(), new CosmeticBuyRequest(earned.code()))).code);
        assertEquals(404, rejected(() -> env.cosmetics.equip(u, key(), new CosmeticEquipRequest("HOUSE", "HOUSE_FROST"))).status);
        // a garden without access at all (feature closed for the account) is not an administrator either
        assertFalse(env.adminQa.available(987_654_321L));
    }

    // ================================================================================ cosmetics

    @Test
    @Order(3)
    void theAdministratorUnlocksEveryCosmeticWithoutCoinsOrdersLevelsOrAchievements() {
        long coinsBefore = coins(ADMIN);
        long xpBefore = jdbc.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, ADMIN);
        var before = env.cosmetics.shop(ADMIN);
        assertEquals(0, before.itemsOwned());
        long earnedOnly = before.items().stream().filter(i -> !"COIN".equals(i.unlockKind())).count()
                + before.skins().stream().filter(s -> !"COIN".equals(s.unlockKind())).count();
        assertEquals(115, before.itemsTotal(), "the Phase 3E catalogue");
        assertEquals(26, earnedOnly, "of which 26 are earned and never sold");

        UUID k = key();
        var receipt = env.adminQa.unlockCosmetics(ADMIN, k);
        assertEquals("UNLOCK", receipt.action());
        var shop = receipt.shop();
        assertEquals(115, shop.itemsTotal());
        assertEquals(115, shop.itemsOwned(), "every one of the 115 products is usable");
        assertTrue(shop.items().stream().allMatch(i -> "OWNED".equals(i.status()) && i.owned() == i.maxOwned()));
        assertTrue(shop.skins().stream().allMatch(s -> "OWNED".equals(s.status())));
        assertTrue(receipt.status().admin());
        assertEquals(receipt.units(), receipt.status().qaUnits());
        assertEquals(receipt.skins(), receipt.status().qaSkins());

        // nothing was paid, earned or invented
        assertEquals(coinsBefore, coins(ADMIN), "no Đồng Echo moved");
        assertEquals(xpBefore, jdbc.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, ADMIN));
        assertEquals(0, count("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason IN ('COSMETIC_BUY','SKIN_BUY')", ADMIN));
        assertEquals(0, count("SELECT count(*) FROM public.garden_cosmetic_order WHERE user_id = ?", ADMIN), "no order, paid or pending");
        assertEquals(0, count("SELECT count(*) FROM public.garden_cosmetic_acquisition WHERE user_id = ? AND (source <> 'ADMIN_QA' OR coins_paid <> 0 OR order_id IS NOT NULL)", ADMIN));
        assertEquals(0, count("SELECT count(*) FROM public.garden_skin_owned WHERE user_id = ? AND (source <> 'ADMIN_QA' OR coins_paid <> 0)", ADMIN));
        assertEquals(0, count("SELECT count(*) FROM public.garden_crop_mastery WHERE user_id = ? AND harvests > 0", ADMIN), "no harvest fact");
        assertEquals(0, count("SELECT count(*) FROM public.garden_monument_day WHERE user_id = ?", ADMIN), "no learning day");
        // the catalogue itself is untouched: an earned item is still not for sale to anyone
        assertEquals(0, count("SELECT count(*) FROM public.garden_cosmetic_def WHERE unlock_kind <> 'COIN' AND coin_price <> 0"));
        assertEquals(0, count("""
                SELECT count(*) FROM public.garden_cosmetic_sku s JOIN public.garden_cosmetic_def d ON d.code = s.item_code
                WHERE s.item_kind = 'COSMETIC' AND d.unlock_kind <> 'COIN'"""), "no VND SKU for an earned item");

        // a retry replays the receipt; pressing again grants nothing more
        assertEquals(receipt.units(), env.adminQa.unlockCosmetics(ADMIN, k).units());
        var again = env.adminQa.unlockCosmetics(ADMIN, key());
        assertEquals(0, again.units());
        assertEquals(0, again.skins());
        assertLedgerReconciles(ADMIN);
    }

    @Test
    @Order(4)
    void theAdministratorWearsPlacesAndPlantsQaItemsThroughTheOrdinaryCommandsAndTheySurviveAReload() {
        // an earned-only house, an earned decoration and a mastery cultivar: the ordinary equip / place / plant commands
        CosmeticItemView house = env.cosmetics.shop(ADMIN).items().stream()
                .filter(i -> "HOUSE".equals(i.category())).findFirst().orElseThrow();
        env.cosmetics.equip(ADMIN, key(), new CosmeticEquipRequest("HOUSE", house.code()));
        var region = env.cosmetics.shop(ADMIN).state().regions().getFirst();
        double snap = env.cosmetics.shop(ADMIN).state().snap();
        double gx = Math.ceil(region.x0() / snap) * snap + snap;
        double gy = Math.ceil(region.y0() / snap) * snap + snap;
        CosmeticItemView decor = env.cosmetics.shop(ADMIN).items().stream().filter(i -> "DECOR".equals(i.category())).findFirst().orElseThrow();
        var placed = env.cosmetics.place(ADMIN, key(), new DecorPlaceRequest(decor.code(), gx, gy));
        assertNotNull(placed.decor());
        String skin = env.cosmetics.shop(ADMIN).skins().stream()
                .filter(s -> "WHEAT".equals(s.cropCode()) && !"COIN".equals(s.unlockKind())).findFirst().orElseThrow().code();
        env.collection.equip(ADMIN, key(), new SkinEquipRequest("WHEAT", skin));
        var s = env.state.state(ADMIN);
        long plot = s.plots().stream().filter(p -> p.slot() == 1).findFirst().orElseThrow().id();
        var planted = env.planting.plant(ADMIN, key(), plot, new PlantRequest("WHEAT")).plot().planting();
        assertEquals(skin, planted.skinCode(), "the crop grows with the QA cultivar (its four stage sprites)");

        // reload: the selection is the administrator's stored state
        var reload = env.state.state(ADMIN).cosmetics();
        assertEquals(house.code(), reload.equippedCodes().get("HOUSE"));
        assertEquals(1, reload.decor().size());
        assertEquals(decor.code(), reload.decor().getFirst().code());
        assertEquals(skin, env.state.state(ADMIN).plots().stream().filter(p -> p.id() == plot).findFirst().orElseThrow().planting().skinCode());
    }

    @Test
    @Order(5)
    void turningQaOffTakesBackExactlyTheQaOwnershipAndKeepsWhatWasReallyBought() {
        // a second account path is impossible (one administrator), so the "real" purchase is made by the administrator
        // AFTER QA is switched off once, then QA is switched on and off again around it
        var off = env.adminQa.revokeCosmetics(ADMIN, key());
        assertEquals("REVOKE", off.action());
        assertEquals(0, off.shop().itemsOwned(), "nothing but QA was held");
        assertEquals(0, off.status().qaUnits());
        assertEquals(0, off.status().qaSkins());
        var cleared = env.state.state(ADMIN);
        assertTrue(cleared.cosmetics().equippedCodes().isEmpty(), "the island wears its own look again");
        assertTrue(cleared.cosmetics().decor().isEmpty());
        assertNull(cleared.plots().stream().filter(p -> p.slot() == 1).findFirst().orElseThrow().planting().skinCode(),
                "a crop planted with a QA cultivar falls back to the crop's own look");
        assertEquals(0, count("SELECT count(*) FROM public.garden_cosmetic_owned WHERE user_id = ?", ADMIN));
        assertTrue(count("SELECT count(*) FROM public.garden_cosmetic_acquisition WHERE user_id = ? AND reversed_at IS NOT NULL", ADMIN) > 0,
                "the history of the QA grant is kept, marked reversed");
        // with QA off the administrator is an ordinary buyer again: locks and prices apply
        CosmeticItemView earned = env.cosmetics.shop(ADMIN).items().stream().filter(i -> !"COIN".equals(i.unlockKind())).findFirst().orElseThrow();
        assertEquals("LOCKED", earned.status());
        assertEquals("COSMETIC_LOCKED", rejected(() -> env.cosmetics.buy(ADMIN, key(), new CosmeticBuyRequest(earned.code()))).code);

        // a real purchase with real coins
        ledger.addCoins(ADMIN, 400_000, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        long price = item(ADMIN, "HOUSE_FROST").coinPrice();
        long coinsBefore = coins(ADMIN);
        env.cosmetics.buy(ADMIN, key(), new CosmeticBuyRequest("HOUSE_FROST"));
        env.cosmetics.buy(ADMIN, key(), new CosmeticBuyRequest("DECOR_LANTERN_STONE"));
        long paid = coinsBefore - coins(ADMIN);
        assertTrue(paid > price - 1);
        env.cosmetics.equip(ADMIN, key(), new CosmeticEquipRequest("HOUSE", "HOUSE_FROST"));

        // QA on again: only the missing units are QA; QA off again: the bought ones stay, still equipped
        var on = env.adminQa.unlockCosmetics(ADMIN, key());
        assertEquals(115, on.shop().itemsOwned());
        assertEquals(1, count("SELECT count(*) FROM public.garden_cosmetic_acquisition WHERE user_id = ? AND cosmetic_code = 'HOUSE_FROST' AND reversed_at IS NULL AND source = 'COIN'", ADMIN));
        int stoneMax = item(ADMIN, "DECOR_LANTERN_STONE").maxOwned();
        assertEquals(stoneMax, item(ADMIN, "DECOR_LANTERN_STONE").owned());
        var offAgain = env.adminQa.revokeCosmetics(ADMIN, key());
        assertEquals(1, item(ADMIN, "HOUSE_FROST").owned(), "the house that was bought stays");
        assertEquals(1, item(ADMIN, "DECOR_LANTERN_STONE").owned(), "exactly the one bought unit stays");
        assertEquals("HOUSE_FROST", env.state.state(ADMIN).cosmetics().equippedCodes().get("HOUSE"), "and stays worn");
        assertEquals(2, offAgain.shop().itemsOwned());
        assertEquals(coinsBefore - paid, coins(ADMIN), "QA on / off never moved a coin");
        assertLedgerReconciles(ADMIN);
        // leave QA on for the administrator, as in use
        env.adminQa.unlockCosmetics(ADMIN, key());
    }

    // ================================================================================ animals

    @Test
    @Order(6)
    void theAdministratorProvisionsEveryHouseSpeciesAndGuardianWithoutLevelsOrCoins() {
        int level = env.ctx.engine().levels().level(jdbc.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, ADMIN));
        assertTrue(level < 4, "below the level of even the first house: " + level);
        long coinsBefore = coins(ADMIN);
        assertEquals("HOUSE_LEVEL", rejected(() -> env.animals.buildHouse(ADMIN, key(), "COOP")).code, "the ordinary command still asks for the level");

        UUID k = key();
        var r = env.adminQa.provisionAnimals(ADMIN, k);
        assertEquals("PROVISION", r.action());
        assertEquals(4, r.houses());
        assertEquals(12, r.livestock(), "three places in each of the four houses");
        assertEquals(3, r.guardians());
        assertEquals(coinsBefore, coins(ADMIN), "no Đồng Echo moved");
        assertEquals(0, count("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason IN ('ANIMAL_HOUSE','ANIMAL_BUY')", ADMIN));
        var view = r.animals();
        assertEquals(List.of("CHICKEN", "DUCK", "PIG", "SHEEP"), view.houses().stream().map(AnimalHouseView::species).sorted().toList());
        assertTrue(view.houses().stream().allMatch(h -> h.built() && h.animals().size() == h.capacity()));
        assertTrue(view.houses().stream().flatMap(h -> h.animals().stream()).allMatch(a -> "BABY".equals(a.stage())), "bought young");
        assertEquals(List.of("CAT", "DOG", "GOOSE"), view.guardians().stream().filter(GardenDtos.GuardianView::owned)
                .map(GardenDtos.GuardianView::species).sorted().toList());
        assertEquals(60, view.feed());
        assertEquals(12, view.water());
        assertEquals(16, count("SELECT count(*) FROM public.garden_animal WHERE user_id = ? AND source = 'ADMIN_QA'", ADMIN) + count(
                "SELECT count(*) FROM public.garden_animal_house WHERE user_id = ? AND source = 'ADMIN_QA'", ADMIN) - 3, "4 houses + 12 livestock (+ 3 guardians)");
        assertEquals(2, count("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'ADMIN_QA'", ADMIN), "feed and water, through the ledger");

        // idempotent: a retry replays, a second press finds nothing missing; capacity and one-guardian rules hold
        assertEquals(12, env.adminQa.provisionAnimals(ADMIN, k).livestock());
        var again = env.adminQa.provisionAnimals(ADMIN, key());
        assertEquals(0, again.houses() + again.livestock() + again.guardians());
        assertTrue(again.supplies().isEmpty());
        assertEquals(12, count("SELECT count(*) FROM public.garden_animal WHERE user_id = ? AND kind = 'LIVESTOCK'", ADMIN));
        assertEquals(3, count("SELECT count(*) FROM public.garden_animal WHERE user_id = ? AND kind = 'GUARDIAN'", ADMIN));
        assertEquals("HOUSE_FULL", rejected(() -> env.animals.buy(ADMIN, key(), "CHICKEN")).code);
        assertEquals("GUARDIAN_OWNED", rejected(() -> env.animals.buy(ADMIN, key(), "DOG")).code);
        assertLedgerReconciles(ADMIN);
    }

    @Test
    @Order(7)
    void theAdministratorFeedsWatersAdvancesAndCollectsThroughTheRealAnimalRules() {
        // ordinary care commands on the QA animals
        var fed = env.animals.feedHouse(ADMIN, key(), "COOP");
        assertTrue(fed.animals().feed() < 60, "the ration was taken from the feed bin");
        var watered = env.animals.water(ADMIN, key(), "COOP");
        assertTrue(watered.animals().houses().stream().filter(h -> h.code().equals("COOP")).findFirst().orElseThrow().watered());
        env.animals.feedGuardian(ADMIN, key(), "DOG");
        assertNotEquals("HUNGRY", env.state.state(ADMIN).animals().guardians().stream().filter(g -> g.species().equals("DOG"))
                .findFirst().orElseThrow().status(), "a fed guardian is on duty");

        // QA time: 12 h is not enough for a chicken (24 h), 72 h is enough for every species and fills the stores
        var half = env.adminQa.advanceAnimals(ADMIN, key(), 12);
        var coop = half.animals().houses().stream().filter(h -> h.code().equals("COOP")).findFirst().orElseThrow();
        assertTrue(coop.animals().stream().allMatch(a -> !"ADULT".equals(a.stage()) && a.growth() >= 0.49), "half grown: " + coop.animals());
        UUID k = key();
        var full = env.adminQa.advanceAnimals(ADMIN, k, 72);
        assertEquals(12, full.livestock());
        assertTrue(full.animals().houses().stream().flatMap(h -> h.animals().stream()).allMatch(a -> "ADULT".equals(a.stage())), "young and adult states are both reachable");
        assertEquals(full.animals().houses().size(), env.adminQa.advanceAnimals(ADMIN, k, 72).animals().houses().size(), "replay");
        var ripe = env.adminQa.advanceAnimals(ADMIN, key(), 72);
        for (AnimalHouseView h : ripe.animals().houses()) {
            assertTrue(h.ready() > 0, h.code() + " has products to collect");
            assertTrue(h.animals().stream().allMatch(a -> a.ready() <= a.storeCap()), "never more than the animal's small store");
        }
        long coinsBefore = coins(ADMIN);
        var collected = env.animals.collect(ADMIN, key(), "COOP");
        assertTrue(collected.gained().getOrDefault("EGG", 0) > 0, "collection is the ordinary command: " + collected.gained());
        assertEquals(coinsBefore, coins(ADMIN));
        // the span is bounded and the clock of the server is nobody's to move
        assertEquals(400, rejected(() -> env.adminQa.advanceAnimals(ADMIN, key(), 0)).status);
        assertEquals(400, rejected(() -> env.adminQa.advanceAnimals(ADMIN, key(), 73)).status);
        assertLedgerReconciles(ADMIN);
    }

    @Test
    @Order(8)
    void qaCommandsNeverTouchAnotherGarden() {
        long neighbour = player(12, 80_000);
        env.animals.buildHouse(neighbour, key(), "COOP");
        env.animals.buy(neighbour, key(), "CHICKEN");
        env.cosmetics.buy(neighbour, key(), new CosmeticBuyRequest("HOUSE_BLOSSOM"));
        String animalsBefore = jdbc.queryForList("SELECT id, growth_seconds, product_seconds, progress_at, source FROM public.garden_animal WHERE user_id = ? ORDER BY id", neighbour).toString();
        String ownedBefore = jdbc.queryForList("SELECT cosmetic_code, quantity FROM public.garden_cosmetic_owned WHERE user_id = ? ORDER BY 1", neighbour).toString();
        long coinsBefore = coins(neighbour);
        env.clock.advance(Duration.ofMinutes(1));

        env.adminQa.unlockCosmetics(ADMIN, key());
        env.adminQa.provisionAnimals(ADMIN, key());
        env.adminQa.advanceAnimals(ADMIN, key(), 48);
        env.adminQa.revokeCosmetics(ADMIN, key());
        env.adminQa.unlockCosmetics(ADMIN, key());

        assertEquals(animalsBefore, jdbc.queryForList("SELECT id, growth_seconds, product_seconds, progress_at, source FROM public.garden_animal WHERE user_id = ? ORDER BY id", neighbour).toString());
        assertEquals(ownedBefore, jdbc.queryForList("SELECT cosmetic_code, quantity FROM public.garden_cosmetic_owned WHERE user_id = ? ORDER BY 1", neighbour).toString());
        assertEquals(coinsBefore, coins(neighbour));
        assertEquals(0, count("SELECT count(*) FROM public.garden_animal WHERE user_id <> ? AND source = 'ADMIN_QA'", ADMIN));
        assertEquals(0, count("SELECT count(*) FROM public.garden_skin_owned WHERE user_id <> ? AND source = 'ADMIN_QA'", ADMIN));
        assertEquals(0, count("SELECT count(*) FROM public.garden_cosmetic_acquisition WHERE user_id <> ? AND source = 'ADMIN_QA'", ADMIN));
        // the neighbour's own animal is still a player's, and the neighbour still pays for everything
        assertEquals("PLAYER", jdbc.queryForObject("SELECT source FROM public.garden_animal WHERE user_id = ?", String.class, neighbour));
        assertEquals("LOCKED", env.cosmetics.shop(neighbour).items().stream().filter(i -> !"COIN".equals(i.unlockKind())).findFirst().orElseThrow().status());
    }
}
