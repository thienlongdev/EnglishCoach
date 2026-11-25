package com.englishcoach.garden;

import com.englishcoach.garden.domain.EconomySimulator;
import com.englishcoach.garden.domain.EconomySimulator.Economy;
import com.englishcoach.garden.domain.EconomySimulator.Result;
import com.englishcoach.garden.domain.FarmEconomyRules;
import com.englishcoach.garden.domain.GardenRules;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3A economy acceptance: the Phase 2 simulation (six beds, no market / orders) against the same personas with the
 * V80 farm economy (market, delivery board, four expansion beds) on the same seeded rules, over 56 days plus a 90-day
 * sensitivity run. Results feed docs/echo-garden/PHASE3A_ECONOMY_SIM_RESULTS.md.
 */
class EconomySimulatorPhase3Test {

    static final GardenRules RULES = GardenTestRules.seeded();
    static final FarmEconomyRules ECONOMY = GardenTestRules.economy();
    static final Map<String, Result> BEFORE = new LinkedHashMap<>();
    static final Map<String, Result> AFTER = new LinkedHashMap<>();
    static final Map<String, Result> AFTER90 = new LinkedHashMap<>();

    @BeforeAll
    static void simulate() {
        var sim = new EconomySimulator(RULES, ECONOMY);
        for (var p : EconomySimulator.phase3aPersonas()) {
            BEFORE.put(p.code(), sim.run(p, 56));
            AFTER.put(p.code(), sim.run(p, 56, EconomySimulator.phase3aPolicy(p)));
            AFTER90.put(p.code(), sim.run(p, 90, EconomySimulator.phase3aPolicy(p)));
        }
        System.out.println(report());
    }

    static String report() {
        StringBuilder sb = new StringBuilder("\n===== PHASE 3A ECONOMY: BEFORE (Phase 2, 6 beds) vs AFTER (V80) =====\n");
        double p1b = BEFORE.get("P1").avgIncome(8, 30);
        double p1a = AFTER.get("P1").avgIncome(8, 30);
        sb.append(String.format("A1 P2/P1 income before %.3f after %.3f | A2 P0/P1 %.3f -> %.3f | A3 P3/P1 %.3f -> %.3f%n",
                BEFORE.get("P2").avgIncome(8, 30) / p1b, AFTER.get("P2").avgIncome(8, 30) / p1a,
                BEFORE.get("P0").avgIncome(8, 30) / p1b, AFTER.get("P0").avgIncome(8, 30) / p1a,
                BEFORE.get("P3").avgIncome(8, 30) / p1b, AFTER.get("P3").avgIncome(8, 30) / p1a));
        for (String code : AFTER.keySet()) {
            Result b = BEFORE.get(code), a = AFTER.get(code), a90 = AFTER90.get(code);
            sb.append(String.format("%s %-52s%n", code, a.persona().label()));
            sb.append(String.format("    levels  L5 d%d->d%d  L10 d%d->d%d  L15 d%d->d%d | d56 level %d->%d | d90 level %d%n",
                    b.dayReaching(5), a.dayReaching(5), b.dayReaching(10), a.dayReaching(10), b.dayReaching(15),
                    a.dayReaching(15), b.days().getLast().level(), a.days().getLast().level(), a90.days().getLast().level()));
            sb.append(String.format("    coins   d7 %d->%d  d14 %d->%d  d30 %d->%d  d56 %d->%d | d90 %d%n",
                    b.coinsAt(7), a.coinsAt(7), b.coinsAt(14), a.coinsAt(14), b.coinsAt(30), a.coinsAt(30),
                    b.coinsAt(56), a.coinsAt(56), a90.coinsAt(90)));
            long production = a.days().stream().mapToLong(EconomySimulator.Day::income).sum();
            long market = a.sum(Economy::marketSpend, 1, 56), expansion = a.sum(Economy::expansionSpend, 1, 56);
            long orderCoins = a.sum(Economy::orderCoins, 1, 56);
            long opened = a.sum(Economy::ordersOpened, 1, 56), filled = a.sum(Economy::ordersFilled, 1, 56);
            long expired = a.sum(Economy::ordersExpired, 1, 56);
            sb.append(String.format("    beds    7:d%d 8:d%d 9:d%d 10:d%d | d90 beds %d%n", a.dayOwningPlots(7),
                    a.dayOwningPlots(8), a.dayOwningPlots(9), a.dayOwningPlots(10), a90.economy().getLast().plots()));
            sb.append(String.format("    flows   net production %d (orders %d) | sinks market %d + beds %d = %.1f%% of production | income d8-30 %.0f->%.0f%n",
                    production, orderCoins, market, expansion, 100.0 * (market + expansion) / Math.max(1, production),
                    b.avgIncome(8, 30), a.avgIncome(8, 30)));
            sb.append(String.format("    orders  opened %d filled %d expired %d (fill %.0f%%) | fert %d premium %d packs %d | compost %d | delivered %s%n",
                    opened, filled, expired, 100.0 * filled / Math.max(1, opened), a.sum(Economy::fertilizerBought, 1, 56),
                    a.sum(Economy::premiumBought, 1, 56), a.sum(Economy::packsBought, 1, 56), a.sum(Economy::compost, 1, 56),
                    deliveredTotals(a)));
            var x = a.xpUntil(14);
            sb.append(String.format("    XP d1-14 %d (before %d) = harvest %d codex %d cards %d goal %d skills %d games %d grad %d pests %d%n",
                    x.total(), b.xpUntil(14).total(), x.harvest(), x.codex(), x.cards(), x.goal(), x.skills(), x.games(),
                    x.graduation(), x.pests()));
            sb.append(String.format("    crops d8-56 %s%n", a.plantedCounts(8, 56)));
        }
        return sb.toString();
    }

    static Map<String, Integer> deliveredTotals(Result r) {
        Map<String, Integer> out = new LinkedHashMap<>();
        r.economy().forEach(e -> e.delivered().forEach((k, v) -> out.merge(k, v, Integer::sum)));
        return out;
    }

    static double income(Map<String, Result> runs, String p) {
        return runs.get(p).avgIncome(8, 30);
    }

    /** The Phase 2 acceptance criteria still hold with the farm economy switched on (current V80 rules). */
    @Test
    void phase2CriteriaHoldWithTheFarmEconomy() {
        double p1 = income(AFTER, "P1");
        assertTrue(income(AFTER, "P2") / p1 <= 2.5, "A1");
        assertTrue(income(AFTER, "P0") / p1 <= 0.6, "A2");
        assertTrue(income(AFTER, "P3") / p1 <= 1.8, "A3");
        int l5 = AFTER.get("P1").dayReaching(5);
        assertTrue(l5 > 0 && l5 <= 5, "A4 first half: P1 level 5 within 5 days (" + l5 + ")");
        int l10 = AFTER.get("P1").dayReaching(10);
        assertTrue(l10 >= 21 && l10 <= 35, "A4: P1 level 10 in days 21..35 (" + l10 + ")");
        int p2l10 = AFTER.get("P2").dayReaching(10);
        assertTrue(p2l10 > 0 && p2l10 <= 14, "A5: P2 level 10 within 14 days (" + p2l10 + ")");
        var r1 = AFTER.get("P1");
        assertTrue(r1.avg(EconomySimulator.Day::freeWater, 8, 30) < 0.5 * 3 * r1.avg(EconomySimulator.Day::plantings, 8, 30), "A8");
    }

    @Test
    void nobodyDeadEndsAndEveryoneCanExpand() {
        AFTER90.values().forEach(r -> r.days().forEach(d -> {
            assertTrue(d.coins() >= 0, r.persona().code() + " coins day " + d.day());
            assertTrue(d.essence() >= 0, r.persona().code() + " essence day " + d.day());
            if (d.present()) assertTrue(d.plantings() > 0 || d.day() > 1, r.persona().code() + " plants (day " + d.day() + ")");
        }));
        var p4 = AFTER.get("P4");
        for (int i = 1; i < p4.days().size(); i++) assertTrue(p4.days().get(i).totalXp() >= p4.days().get(i - 1).totalXp());
        assertTrue(p4.dayReaching(5) > 0, "returner reaches level 5");
        assertTrue(p4.dayOwningPlots(8) > 0, "returner (2 days in 5) opens at least two beds within 56 days");
        assertTrue(AFTER90.get("P4").dayOwningPlots(10) > 0, "returner owns every bed within 90 days");
        assertTrue(AFTER.get("P0").dayOwningPlots(10) > 0, "farm-only player can open all four beds without learning");
        assertTrue(AFTER.get("P5").dayOwningPlots(10) > 0, "a player who never shops still expands");
    }

    /** Orders are a real choice for every persona, capped by construction, and never a dominant coin source. */
    @Test
    void ordersMatterButStayBounded() {
        int maxOpened = 56 * ECONOMY.orders().dailySlots() + 8 * ECONOMY.orders().weeklySlots();
        for (var e : AFTER.entrySet()) {
            Result r = e.getValue();
            long opened = r.sum(Economy::ordersOpened, 1, 56), filled = r.sum(Economy::ordersFilled, 1, 56);
            assertTrue(opened <= maxOpened, e.getKey() + " opened " + opened);
            assertTrue(filled <= opened, e.getKey() + " filled more than opened");
            assertTrue(r.economy().stream().allMatch(x -> x.ordersFilled() <= ECONOMY.orders().slots()), e.getKey() + " fills per day");
        }
        for (String code : new String[]{"P0", "P1", "P2", "P3"}) {
            Result r = AFTER.get(code);
            double fill = (double) r.sum(Economy::ordersFilled, 1, 56) / Math.max(1, r.sum(Economy::ordersOpened, 1, 56));
            assertTrue(fill >= 0.2 && fill < 1.0, code + " fill rate " + fill);
        }
    }

    /** Market caps hold even for the maximizer; care items never pay for themselves (A6 on the actual staple prices). */
    @Test
    void marketIsCappedAndNeverProfitable() {
        int dailyUnits = ECONOMY.market().staples().stream().mapToInt(FarmEconomyRules.Staple::dailyCap).sum();
        Result p7 = AFTER.get("P7");
        assertTrue(p7.economy().stream().allMatch(e -> e.fertilizerBought() + e.premiumBought() <= dailyUnits));
        assertTrue(p7.economy().stream().allMatch(e -> e.packsBought() <= ECONOMY.market().featuredSlots() * ECONOMY.market().packDailyCap()));
        for (var c : RULES.crops().values()) {
            if (c.qaOnly()) continue;
            double profitWithBlessing = c.sellPrice() * RULES.blessingSellMultiplier() - c.seedPrice();
            for (var s : ECONOMY.market().staples()) {
                double saved = RULES.boosts().get(s.item()).fraction() * profitWithBlessing;
                assertTrue(saved < s.price(), c.code() + " " + s.item() + " saves " + saved + " >= " + s.price());
            }
        }
    }

    /** No order / market / fast-crop strategy beats playing more often: the exploit maximizer ≈ the revenue maximizer. */
    @Test
    void noExploitBeatsTheRevenueMaximizer() {
        long p6 = AFTER.get("P6").days().stream().mapToLong(EconomySimulator.Day::income).sum();
        long p7 = AFTER.get("P7").days().stream().mapToLong(EconomySimulator.Day::income).sum();
        assertTrue(p7 <= 1.10 * p6, "P7 net production " + p7 + " vs P6 " + p6);
        assertTrue(AFTER.get("P7").coinsAt(56) <= 1.10 * AFTER.get("P6").coinsAt(56), "P7 balance vs P6");
        for (String code : new String[]{"P1", "P3", "P6"}) {
            var r = AFTER.get(code);
            var weeks = new java.util.ArrayList<Map<String, Integer>>();
            for (int w = 1; w < 8; w++) weeks.add(r.plantedCounts(w * 7 + 1, w * 7 + 7));
            long distinctTop = weeks.stream().map(m -> m.entrySet().stream().max(Map.Entry.comparingByValue())
                    .map(Map.Entry::getKey).orElse("")).distinct().count();
            assertTrue(distinctTop >= 2, code + " plants the same top crop every week: " + weeks);
        }
    }

    /**
     * Sinks are real (≥ 20 % of a normal learner's net production over 56 days) and reduce the learner's balance versus
     * Phase 2; the frequent visitor is not asserted to drop (coin accumulation is reduced, not solved — see report).
     */
    @Test
    void sinksReduceAccumulationForOrdinaryPlayers() {
        for (String code : new String[]{"P0", "P1", "P2"}) {
            Result a = AFTER.get(code);
            long production = a.days().stream().mapToLong(EconomySimulator.Day::income).sum();
            long sinks = a.sum(Economy::sinks, 1, 56);
            assertTrue(sinks >= 0.2 * production, code + " sinks " + sinks + " vs production " + production);
            assertTrue(a.coinsAt(56) < BEFORE.get(code).coinsAt(56), code + " day-56 balance not reduced");
        }
    }
}
