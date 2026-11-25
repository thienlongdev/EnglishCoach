package com.englishcoach.echolife;

import com.englishcoach.echolife.EchoLifeGameDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The real V130 schema on PostgreSQL 17 (after V94, V110, V129), through the least-privilege application role: the game's
 * economy is the server's (unique rewards once each, missions after their prerequisites, repeatable earnings capped,
 * catalogue prices, idempotent purchases, ownership), the narrative save is bound to its learner, and nothing survives only
 * in memory.
 */
class EchoLifeGamePostgresTest {

    private static PostgreSQLContainer<?> pg;
    private static TransactionTemplate tx;
    private static EchoLifeGameService games;
    private static JdbcTemplate jdbc;
    private static DriverManagerDataSource app;
    private static final ObjectMapper JSON = new ObjectMapper();

    @BeforeAll
    static void start() throws Exception {
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        DriverManagerDataSource raw = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Connection c = raw.getConnection(); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL);"
                    + "INSERT INTO public.users SELECT g, 'Learner ' || g FROM generate_series(1, 25) g;");
            for (String v : List.of("V94__database_runtime_least_privilege.sql", "V110__study_space.sql", "V129__echo_life_world.sql", "V130__echo_life_game.sql","V131__echo_life_progression.sql")) {
                st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            }
            st.execute("ALTER ROLE english_coach_app PASSWORD 'echo-life-test-only'");
        }
        app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "echo-life-test-only");
        tx = new TransactionTemplate(new DataSourceTransactionManager(app));
        jdbc = new JdbcTemplate(app);
        games = service(jdbc);
    }

    private static EchoLifeGameService service(JdbcTemplate j) throws Exception {
        return new EchoLifeGameService(new EchoLifeGameRepository(j, JSON), new EchoLifeEconomy(JSON), JSON);
    }

    private static <T> T inTx(Supplier<T> work) {
        return tx.execute(s -> work.get());
    }

    private static EchoLifeException refused(Runnable call) {
        try {
            tx.executeWithoutResult(s -> call.run());
        } catch (EchoLifeException e) {
            return e;
        }
        return null;
    }

    private static ClaimResult claim(long user, List<String> uniques, int credits, Map<String, Integer> xp) {
        return inTx(() -> games.claim(user, new ClaimRequest(List.of(new ClaimBatch("test", uniques, credits, xp,
                List.of(), java.util.UUID.randomUUID().toString())))));
    }

    private static ObjectNode doc(String owner, String... ownedIds) {
        ObjectNode save = JSON.createObjectNode().put("version", 4).put("owner", owner);
        ArrayNode owned = save.putObject("progression").putArray("ownedObjects");
        for (String id : ownedIds) owned.addObject().put("instanceId", id).put("ownerAccountId", owner);
        ObjectNode d = JSON.createObjectNode().put("v", 1).put("save", save.toString());
        d.putObject("places").putObject("linh").put("x", 12.5).put("z", -30.25);
        return d;
    }

    @Test
    void aNewLearnerStartsWithV3sStartingBalanceAndNoGame() {
        Game g = inTx(() -> games.get(9));
        assertThat(g.revision()).isZero();
        assertThat(g.doc()).isNull();
        assertThat(g.wallet().credits()).isEqualTo(120);
        assertThat(g.wallet().skills()).containsKeys("technology", "cooking", "diy_design", "business", "social", "mobility");
    }

    @Test
    void uniqueRewardsAreGrantedOnceFromTheServerTableAndMissionsNeedTheirPrerequisites() {
        ClaimResult early = claim(1, List.of("mission:breakfast"), 45, Map.of("cooking", 35));
        assertThat(early.refused()).containsEntry("mission:breakfast", "PREREQUISITE");
        assertThat(early.wallet().credits()).isEqualTo(120);

        // The client reports more than V3 gave: the server grants its own amounts only.
        ClaimResult tidy = claim(1, List.of("mission:tidy"), 9999, Map.of("diy_design", 9999));
        assertThat(tidy.granted()).containsExactly("mission:tidy");
        assertThat(tidy.wallet().credits()).isEqualTo(120 + 45 + 150); // reward + the per-report cap on the rest
        assertThat(tidy.wallet().skills().get("diy_design")).isEqualTo(35 + 70);

        ClaimResult again = claim(1, List.of("mission:tidy"), 45, Map.of("diy_design", 35));
        assertThat(again.refused()).containsEntry("mission:tidy", "ALREADY_CLAIMED");
        assertThat(again.wallet().credits()).isEqualTo(tidy.wallet().credits());

        ClaimResult breakfast = claim(1, List.of("mission:breakfast", "not:a-key", "landmark:lm_lantern_garden"), 45 + 45, Map.of());
        assertThat(breakfast.granted()).containsExactly("mission:breakfast", "landmark:lm_lantern_garden");
        assertThat(breakfast.refused()).containsKey("not:a-key");
        assertThat(breakfast.wallet().claimed()).contains("mission:tidy", "mission:breakfast", "landmark:lm_lantern_garden");
    }

    @Test
    void repeatableEarningsAreCappedPerReportAndPerDay() {
        int before = inTx(() -> games.get(2)).wallet().credits();
        int last = before;
        for (int i = 0; i < 9; i++) last = claim(2, List.of(), 500, Map.of("technology", 500)).wallet().credits();
        assertThat(last - before).isEqualTo(900);
        Wallet w = inTx(() -> games.get(2)).wallet();
        assertThat(w.dailyCredits()).isEqualTo(900);
        assertThat(w.dailyXp()).isEqualTo(9 * 70);
    }

    @Test
    void purchasesUseCataloguePricesAreIdempotentAndOwnershipIsTheServers() {
        PurchaseResult eggs = inTx(() -> games.purchase(3, new PurchaseRequest("market", "sku_food_eggs", "req-eggs-0001")));
        assertThat(eggs.price()).isEqualTo(2);
        assertThat(eggs.wallet().credits()).isEqualTo(118);
        PurchaseResult retry = inTx(() -> games.purchase(3, new PurchaseRequest("market", "sku_food_eggs", "req-eggs-0001")));
        assertThat(retry.instanceId()).isEqualTo(eggs.instanceId());
        assertThat(retry.wallet().credits()).isEqualTo(118);

        assertThat(refused(() -> games.purchase(3, new PurchaseRequest("market", "sku_not_real", "req-bad-00001"))).code).isEqualTo("UNKNOWN_ITEM");
        PurchaseResult cooker = inTx(() -> games.purchase(3, new PurchaseRequest("home_center", "sku_rice_cooker_smart", "req-cooker-001")));
        assertThat(cooker.wallet().credits()).isEqualTo(118 - 115);
        assertThat(refused(() -> games.purchase(3, new PurchaseRequest("furniture_shop", "sku_coffee_table_engawa", "req-table-0001"))).code)
                .isEqualTo("INSUFFICIENT_CREDITS");

        // The narrative save may hold the bought object; another learner's save may not.
        assertThat(inTx(() -> games.save(3, new SaveGameRequest(doc("u3", "obj_starter_sofa", cooker.instanceId()), 0L))).revision()).isPositive();
        assertThat(refused(() -> games.save(4, new SaveGameRequest(doc("u4", cooker.instanceId()), 0L))).code).isEqualTo("OWNERSHIP_VIOLATION");
        assertThat(refused(() -> games.sell(4, new SaleRequest(cooker.instanceId()))).code).isEqualTo("OWNERSHIP_VIOLATION");

        SaleResult sold = inTx(() -> games.sell(3, new SaleRequest(cooker.instanceId())));
        assertThat(sold.refund()).isEqualTo((int) Math.floor(115 * .6));
        assertThat(sold.wallet().owned()).noneMatch(o -> o.instanceId().equals(cooker.instanceId()));
        assertThat(refused(() -> games.sell(3, new SaleRequest(cooker.instanceId()))).code).isEqualTo("NOT_FOUND");
        long rev = inTx(() -> games.get(3)).revision();
        assertThat(refused(() -> games.save(3, new SaveGameRequest(doc("u3", cooker.instanceId()), rev))).code).isEqualTo("OWNERSHIP_VIOLATION");
    }

    @Test
    void theNarrativeSaveIsTheLearnersOwnAndRevisioned() {
        Game first = inTx(() -> games.save(5, new SaveGameRequest(doc("u5"), 0L)));
        assertThat(first.revision()).isPositive();
        EchoLifeException stale = refused(() -> games.save(5, new SaveGameRequest(doc("u5"), 0L)));
        assertThat(stale.status).isEqualTo(409);
        assertThat(stale.currentGame.revision()).isEqualTo(first.revision());
        assertThat(refused(() -> games.save(5, new SaveGameRequest(doc("u6"), first.revision()))).code).isEqualTo("OWNERSHIP_VIOLATION");
        assertThat(refused(() -> games.save(5, new SaveGameRequest(doc("u5", "obj_999"), first.revision()))).code).isEqualTo("OWNERSHIP_VIOLATION");
        ObjectNode bad = doc("u5");
        bad.put("extra", 1);
        assertThat(refused(() -> games.save(5, new SaveGameRequest(bad, first.revision()))).code).isEqualTo("INVALID_GAME");
        Game second = inTx(() -> games.save(5, new SaveGameRequest(doc("u5"), first.revision())));
        assertThat(second.revision()).isGreaterThan(first.revision());
        assertThat(inTx(() -> games.get(6)).revision()).isZero(); // another learner sees nothing of it
    }

    @Test
    void selectingAnOwnedRidePersistsItsInstanceWithoutASecondCharge() {
        long learner = 20;
        var select = JSON.createObjectNode().put("type", "select_vehicle").put("instanceId", "obj_starter_bike");
        inTx(() -> games.configure(learner, new WorkshopRequest("ride-starter-001", 0L, select)));
        // Qualify this disposable learner for the two motorbikes and the business-gated Lotus.
        jdbc.update("UPDATE public.echo_life_games SET credits=40000, skills=skills || '{\"mobility\":5000,\"business\":5000}'::jsonb WHERE user_id=?", learner);
        var first = inTx(() -> games.purchase(learner, new PurchaseRequest("vehicle_dealer", "sku_veh_vesper", "ride-purchase-001")));
        var second = inTx(() -> games.purchase(learner, new PurchaseRequest("vehicle_dealer", "sku_veh_cafe_racer", "ride-purchase-002")));
        assertThat(second.wallet().workshop().path("activeVehicleId").asText()).isEqualTo(second.instanceId());
        select.put("instanceId", first.instanceId());
        var request = new WorkshopRequest("ride-select-001", second.wallet().workshopRevision(), select);
        var result = inTx(() -> games.configure(learner, request));
        assertThat(result.ok()).isTrue();
        assertThat(result.wallet().credits()).isEqualTo(second.wallet().credits());
        assertThat(inTx(() -> games.configure(learner, request)).wallet().workshopRevision()).isEqualTo(result.wallet().workshopRevision());
        assertThat(inTx(() -> games.get(learner)).wallet().workshop().path("activeVehicleId").asText()).isEqualTo(first.instanceId());
        var roadster = inTx(() -> games.purchase(learner, new PurchaseRequest("vehicle_dealer", "sku_car_lotus", "car-purchase-001")));
        select.put("instanceId", roadster.instanceId());
        var carRequest = new WorkshopRequest("car-select-001", roadster.wallet().workshopRevision(), select);
        var garage = inTx(() -> games.configure(learner, carRequest));
        assertThat(garage.ok()).isTrue();
        assertThat(garage.wallet().credits()).isEqualTo(roadster.wallet().credits());
        var restored = inTx(() -> games.get(learner)).wallet().workshop();
        assertThat(restored.path("activeCarId").asText()).isEqualTo(roadster.instanceId());
        assertThat(restored.path("activeVehicleId").asText()).isEqualTo(first.instanceId());
    }

    @Test
    void buildHistoryAndRoomStylesFollowTheServerOwnedWorkshop() {
        long user = 19;
        var finish = JSON.createObjectNode().put("type","customize_material")
                .put("instanceId","obj_starter_sofa").put("finishId","matte_graphite");
        var first = inTx(()->games.configure(user,new WorkshopRequest("test-finish-0001",0L,finish)));
        assertThat(first.ok()).isTrue();
        var undo = JSON.createObjectNode().put("type","undo_build");
        var back = inTx(()->games.configure(user,new WorkshopRequest("test-undo-0002",first.wallet().workshopRevision(),undo)));
        assertThat(back.ok()).isTrue();
        assertThat(back.wallet().workshop().path("redoStack").size()).isEqualTo(1);
        var redo = JSON.createObjectNode().put("type","redo_build");
        var again = inTx(()->games.configure(user,new WorkshopRequest("test-redo-0003",back.wallet().workshopRevision(),redo)));
        assertThat(again.ok()).isTrue();
        assertThat(again.wallet().skills()).isEqualTo(first.wallet().skills());
        // Fund only this learner in the disposable test database.
        jdbc.update("UPDATE public.echo_life_games SET credits=1000, workshop=jsonb_set(workshop,'{materials}', workshop->'materials' || '{\"wood\":10,\"fabric\":10}'::jsonb) WHERE user_id=?",user);
        var style = JSON.createObjectNode().put("type","apply_room_style").put("zoneId","living").put("styleId","cozy");
        var styled = inTx(()->games.configure(user,new WorkshopRequest("test-style-0004",again.wallet().workshopRevision(),style)));
        assertThat(styled.ok()).isTrue();
        assertThat(styled.wallet().workshop().at("/roomStyles/living").asText()).isEqualTo("cozy");
        assertThat(styled.wallet().credits()).isLessThan(1000);
        var budget = style.deepCopy().put("styleId","budget_student");
        var switched = inTx(()->games.configure(user,new WorkshopRequest("test-style-0005",styled.wallet().workshopRevision(),budget)));
        assertThat(switched.ok()).isTrue();
        var returned = inTx(()->games.configure(user,new WorkshopRequest("test-style-0006",switched.wallet().workshopRevision(),style)));
        assertThat(returned.ok()).isTrue();
        assertThat(returned.wallet().skills()).isEqualTo(switched.wallet().skills());
        assertThat(returned.wallet().credits()).isEqualTo(styled.wallet().credits());
        assertThat(inTx(()->games.get(user)).wallet().workshop().at("/roomStyles/living").asText()).isEqualTo("cozy");
    }

    @Test
    void theWorkshopRunsTheCatalogueAndUsesSeparateRevisionedReceipts() {
        var move=JSON.createObjectNode().put("type","buy_switch_property").put("propertyId","prop_student_flat");
        var request=new WorkshopRequest("workshop-test-01",0L,move);
        var first=inTx(()->games.configure(8,request));
        assertThat(first.ok()).isTrue();
        assertThat(first.wallet().workshop().path("ownedObjects")).hasSize(6);
        assertThat(inTx(()->games.configure(8,request)).wallet().workshopRevision()).isEqualTo(first.wallet().workshopRevision());
        assertThat(refused(()->games.configure(8,new WorkshopRequest("workshop-test-02",0L,move))).code).isEqualTo("STALE_REVISION");
        var costly=JSON.createObjectNode().put("type","buy_switch_property").put("propertyId","prop_grand_palais");
        assertThat(inTx(()->games.configure(8,new WorkshopRequest("workshop-test-03",1L,costly))).ok()).isFalse();
        var batch=new ClaimBatch("ride",List.of(),5,Map.of("mobility",8),List.of(),"reward-test-001");
        var claims=new ClaimRequest(List.of(batch));
        var once=inTx(()->games.claim(8,claims));
        var twice=inTx(()->games.claim(8,claims));
        assertThat(twice.wallet().credits()).isEqualTo(once.wallet().credits());
        assertThat(twice.wallet().skills()).isEqualTo(once.wallet().skills());
        assertThat(inTx(()->games.get(6)).wallet().workshop()).isNull();
    }

    @Test
    void legacyRewardsKeepTheirIdentityWhileUnidentifiedRepeatableEffectsAreRefused() {
        var batch = new ClaimBatch("legacy", List.of("mission:tidy"), 90, Map.of("business", 30),
                List.of(new Spend("market", List.of("rice"), false)));
        var request = new ClaimRequest(List.of(batch));
        var first = inTx(() -> games.claim(17, request));
        assertThat(first.granted()).containsExactly("mission:tidy");
        assertThat(first.refused()).containsEntry("activity:legacy", "REQUEST_ID_REQUIRED");
        assertThat(first.wallet().credits()).isEqualTo(165);
        assertThat(first.wallet().skills().get("business")).isZero();
        var retry = inTx(() -> games.claim(17, request));
        assertThat(retry.wallet()).isEqualTo(first.wallet());
        assertThat(retry.granted()).isEmpty();
    }

    @Test
    void shopDiscountUsesTheBusinessLevelEarnedInTheLedger() {
        claim(16, List.of(), 0, Map.of("business", 60));
        var request = new PurchaseRequest("home_center", "sku_rice_cooker_smart", "discounted-cooker");
        var result = inTx(() -> games.purchase(16, request));
        assertThat(result.price()).isEqualTo(109);
        assertThat(result.wallet().credits()).isEqualTo(11);
        var retry = inTx(() -> games.purchase(16, request));
        assertThat(retry.instanceId()).isEqualTo(result.instanceId());
        assertThat(retry.wallet().credits()).isEqualTo(11);
    }

    @Test
    void simultaneousPurchasesCannotSpendTheSameBalance() throws Exception {
        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var results = new java.util.ArrayList<java.util.concurrent.Future<String>>();
            for (String id : List.of("cooker-request-a", "cooker-request-b")) {
                results.add(workers.submit(() -> {
                    ready.countDown();
                    if (!start.await(10, TimeUnit.SECONDS)) throw new AssertionError("missing second buyer");
                    var denied = refused(() -> games.purchase(11, new PurchaseRequest("home_center", "sku_rice_cooker_smart", id)));
                    return denied == null ? "PURCHASED" : denied.code;
                }));
            }
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(List.of(results.get(0).get(30, TimeUnit.SECONDS), results.get(1).get(30, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder("PURCHASED", "INSUFFICIENT_CREDITS");
        }
        var wallet = inTx(() -> games.get(11)).wallet();
        assertThat(wallet.credits()).isEqualTo(5);
        assertThat(wallet.owned()).hasSize(1);
    }

    @Test
    void producePricesUseTheSavedCalendarAtBothEdgesOfTheSale() throws Exception {
        long[] minutes = { 600, 1440+599, 1440+600, 1440+899, 1440+900, 3*1440+600 };
        int[] prices = { 9, 9, 7, 7, 9, 7 };
        long revision = 0;
        int balance = 120;
        for (int i = 0; i < minutes.length; i++) {
            ObjectNode document = doc("u12");
            ObjectNode state = (ObjectNode) JSON.readTree(document.path("save").asText());
            document.put("save", state.put("clock", minutes[i]).toString());
            var save = new SaveGameRequest(document, revision);
            revision = inTx(() -> games.save(12, save)).revision();
            var spend = new Spend("market", List.of("rice"), prices[i] == 9);
            var request = new ClaimRequest(List.of(new ClaimBatch("checkout", List.of(), 0, Map.of(),
                    List.of(spend), "calendar-checkout-" + i)));
            balance -= prices[i];
            assertThat(inTx(() -> games.claim(12, request)).wallet().credits()).isEqualTo(balance);
            assertThat(inTx(() -> games.claim(12, request)).wallet().credits()).isEqualTo(balance);
        }
    }

    @Test
    void completedMarketShiftSurvivesReloadAndSettlesOnce() throws Exception {
        var stations = List.of("market_shift", "shelf", "tea", "till");
        WorkshopRequest last = null;
        for (int i=0; i<stations.size(); i++) {
            if (i>0) Thread.sleep(1550);
            var current = inTx(() -> games.get(21)).wallet();
            var action = JSON.createObjectNode().put("type","job_step").put("jobId","market")
                    .put("station",stations.get(i)).put("zoneId","market");
            var request = new WorkshopRequest("market-shift-regression-"+i,current.workshopRevision(),action);
            var reply = inTx(() -> games.configure(21,request));
            assertThat(reply.ok()).isTrue();
            assertThat(reply.wallet().credits()).isEqualTo(i==3?165:120);
            last=request;
        }
        var replay=last;
        assertThat(inTx(() -> games.configure(21,replay)).wallet().credits()).isEqualTo(165);
        var finished=inTx(() -> games.get(21)).wallet();
        assertThat(finished.dailyCredits()).isEqualTo(45);
        assertThat(finished.workshop().has("activeShift")).isFalse();
    }

    @Test
    void bistroMealCommitsInventoryAndTwelveCreditReceiptTogether() throws Exception {
        var document=doc("u22");
        var story=(ObjectNode) JSON.readTree(document.path("save").asText());
        story.put("clock",2040).putObject("bag").put("matcha_crepe",1);
        document.put("save",story.toString());
        var batch=new ClaimBatch("checkout",List.of(),0,Map.of(),
                List.of(new Spend("bistro",List.of("matcha_crepe"),false)),"bistro-meal-checkout");
        var request=new ClaimRequest(List.of(batch),new SaveGameRequest(document,0L));
        assertThat(inTx(() -> games.claim(22,request)).wallet().credits()).isEqualTo(108);
        assertThat(inTx(() -> games.claim(22,request)).wallet().credits()).isEqualTo(108);
        assertThat(inTx(() -> games.get(22)).doc()).isEqualTo(document);
    }

    @Test
    void multiItemWillowBistroMenuAndPersistedDistrictStandingDiscountRespectServerCeiling() throws Exception {
        // Learner 23 saves a document with verified persisted bistro & market district standing (85 -> 10% standing discount).
        ObjectNode initial = doc("u23");
        ObjectNode story = (ObjectNode) JSON.readTree(initial.path("save").asText());
        story.put("clock", 1800);
        ObjectNode worldV3 = story.putObject("worldV3");
        worldV3.putObject("npcSim").putObject("rep").put("bistro", 85).put("market", 85);
        worldV3.putObject("lifeMeta").put("v", 2).put("lastComfort", 72).put("karma", 30);
        initial.put("save", story.toString());
        long rev = inTx(() -> games.save(23, new SaveGameRequest(initial, 0L))).revision();

        // Multi-item Willow Bistro order: iced_matcha (9) + truffle_ramen (18) + jasmine_tea_set (14) = 41 -> 10% off = 37
        ObjectNode afterOrder = doc("u23");
        ObjectNode orderStory = (ObjectNode) JSON.readTree(afterOrder.path("save").asText());
        orderStory.put("clock", 1810).putObject("bag").put("iced_matcha", 1).put("truffle_ramen", 1).put("jasmine_tea_set", 1);
        afterOrder.put("save", orderStory.toString());
        var bistroBatch = new ClaimBatch("checkout", List.of(), 0, Map.of(),
                List.of(new Spend("bistro", List.of("iced_matcha", "truffle_ramen", "jasmine_tea_set"), false)),
                "bistro-multi-menu-001");
        var bistroResult = inTx(() -> games.claim(23, new ClaimRequest(List.of(bistroBatch), new SaveGameRequest(afterOrder, rev))));
        assertThat(bistroResult.wallet().credits()).isEqualTo(120 - 37);

        // Unknown bistro item is refused
        var badBatch = new ClaimBatch("checkout", List.of(), 0, Map.of(),
                List.of(new Spend("bistro", List.of("diamond_caviar"), false)), "bistro-bad-item-001");
        assertThat(refused(() -> games.claim(23, new ClaimRequest(List.of(badBatch), new SaveGameRequest(afterOrder, bistroResult.revision())))).code)
                .isEqualTo("INVALID_GAME");

        // Learner 24: Business Lv 8 (15%) + persisted market standing 95 (10%) -> combined shop discount capped at 15% ceiling!
        ObjectNode doc24 = doc("u24");
        ObjectNode s24 = (ObjectNode) JSON.readTree(doc24.path("save").asText());
        s24.putObject("worldV3").putObject("npcSim").putObject("rep").put("market", 95);
        doc24.put("save", s24.toString());
        inTx(() -> games.save(24, new SaveGameRequest(doc24, 0L)));
        jdbc.update("UPDATE public.echo_life_games SET credits=1000, skills=skills || '{\"business\":3000}'::jsonb WHERE user_id=24");
        // sku_rice_cooker_smart base=115; capped 15% discount -> round(115 * 0.85) = 98 (never 25% = 86!)
        var bought = inTx(() -> games.purchase(24, new PurchaseRequest("home_center", "sku_rice_cooker_smart", "standing-cap-001")));
        assertThat(bought.price()).isEqualTo(98);
    }

    @Test
    void rainyBuskerShiftInAtelierWithPerfectQualitySettlesInPostgres() throws Exception {
        List<String> stations = List.of("atelier_acoustic", "atelier_easel_a", "atelier_acoustic");
        for (int i = 0; i < stations.size(); i++) {
            if (i > 0) Thread.sleep(1550);
            int stepIdx = i;
            var current = inTx(() -> games.get(25)).wallet();
            var action = JSON.createObjectNode()
                    .put("type", "job_step")
                    .put("jobId", "busker")
                    .put("zoneId", "atelier")
                    .put("station", stations.get(i));
            if (i == stations.size() - 1) action.put("quality", "perfect");
            var reply = inTx(() -> games.configure(25, new WorkshopRequest("busker-rain-" + stepIdx, current.workshopRevision(), action)));
            assertThat(reply.ok()).isTrue();
            assertThat(reply.wallet().credits()).isEqualTo(i == 2 ? 120 + 75 : 120);
        }
        var done = inTx(() -> games.get(25)).wallet();
        assertThat(done.workshop().at("/careerTiers/busker/shifts").asInt()).isEqualTo(1);
        assertThat(done.workshop().at("/careerTiers/busker/bestQuality").asText()).isEqualTo("perfect");
    }

    @Test
    void marketInventoryAndRewardCommitOnceAndStaleOrUnaffordableBasketsRollBack() throws Exception {
        var document = doc("u14");
        var narrative = (ObjectNode) JSON.readTree(document.path("save").asText());
        narrative.put("clock", 1440 + 600).putObject("bag").put("rice", 1);
        document.put("save", narrative.toString());
        var batch = new ClaimBatch("checkout", List.of("mission:tidy"), 45, Map.of("diy_design",35),
                List.of(new Spend("market", List.of("rice"), true)), "atomic-market-tidy");
        var purchase = new ClaimRequest(List.of(batch), new SaveGameRequest(document, 0L));
        var result = inTx(() -> games.claim(14, purchase));
        assertThat(result.wallet().credits()).isEqualTo(120 + 45 - 7);
        assertThat(result.granted()).containsExactly("mission:tidy");
        assertThat(inTx(() -> games.claim(14, purchase)).revision()).isEqualTo(result.revision());
        var stale = new ClaimBatch("checkout", List.of(), 0, Map.of(), batch.spent(), "atomic-market-stale");
        assertThat(refused(() -> games.claim(14, new ClaimRequest(List.of(stale), purchase.checkout()))).code)
                .isEqualTo("STALE_REVISION");
        var next = inTx(() -> games.get(14));
        assertThat(next.wallet().credits()).isEqualTo(result.wallet().credits());
        assertThat(next.doc()).isEqualTo(document);
        inTx(() -> games.purchase(15, new PurchaseRequest("home_center", "sku_rice_cooker_smart", "atomic-market-cooker")));
        var other = doc("u15");
        var expensive = new ClaimBatch("checkout", List.of("mission:tidy"), 45, Map.of(), List.of(
                new Spend("market", List.of("rice"), false)), "atomic-market-funds");
        var denied = new ClaimRequest(List.of(expensive), new SaveGameRequest(other, 0L));
        assertThat(refused(() -> games.claim(15, denied)).code).isEqualTo("INSUFFICIENT_CREDITS");
        var unchanged = inTx(() -> games.get(15));
        assertThat(unchanged.doc()).isNull();
        assertThat(unchanged.wallet().claimed()).isEmpty();
        assertThat(unchanged.wallet().credits()).isEqualTo(5);
    }

    @Test
    void alternateChoicesAndReplayedMaterialRewardsAreNotGrantedTwice() {
        String choice = "choice:ch2_huy_pact:co_op_sound_crew";
        String other = "choice:ch2_huy_pact:friendly_bet";
        var first = claim(13, List.of(choice, "side:sq_threads_identity"), 0, Map.of());
        int fabric = first.wallet().workshop().path("materials").path("fabric").asInt();
        assertThat(fabric).isEqualTo(5);
        var replay = claim(13, List.of(other, "side:sq_threads_identity"), 0, Map.of());
        assertThat(replay.refused()).containsEntry(other, "CHOICE_ALREADY_MADE");
        assertThat(replay.wallet().credits()).isEqualTo(first.wallet().credits());
        var purchase = inTx(() -> games.purchase(13, new PurchaseRequest("market", "sku_food_eggs", "another-projection")));
        assertThat(purchase.wallet().workshop().path("materials").path("fabric").asInt()).isEqualTo(fabric);
        assertThat(purchase.wallet().claimed()).containsExactlyInAnyOrder(choice, "side:sq_threads_identity");
    }

    @Test
    void theGameSurvivesARestartAndTheApplicationRoleHasNoDdl() throws Exception {
        claim(7, List.of("relic:col_street_postcard"), 25, Map.of("social", 20));
        EchoLifeGameService restarted = service(new JdbcTemplate(new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "echo-life-test-only")));
        Wallet w = tx.execute(s -> restarted.get(7)).wallet();
        assertThat(w.claimed()).containsExactly("relic:col_street_postcard");
        assertThat(w.credits()).isEqualTo(145);
        assertThatThrownBy(() -> jdbc.execute("ALTER TABLE public.echo_life_games ADD COLUMN hack INT")).isInstanceOf(Exception.class);
    }
}
