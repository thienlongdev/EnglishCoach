package com.englishcoach.garden;

import com.englishcoach.garden.domain.EconomySimulator;
import com.englishcoach.garden.domain.EconomySimulator.Economy;
import com.englishcoach.garden.domain.EconomySimulator.Estate;
import com.englishcoach.garden.domain.EconomySimulator.Result;
import com.englishcoach.garden.domain.EstateRules;
import com.englishcoach.garden.domain.FarmEconomyRules;
import com.englishcoach.garden.domain.GardenRules;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3C long-horizon economy: the Phase 3A simulation (ten beds, market, orders) against the same personas with the
 * V83 estate (building levels, three farmland regions up to 24 beds, compost bin, staged pest damage) on the same seeded
 * rules, over 365 days read at days 56, 90, 180 and 365. Results feed docs/echo-garden/PHASE3C_ECONOMY_SIM_RESULTS.md.
 * A deterministic model of scripted personas — not telemetry.
 */
class EconomySimulatorPhase3CTest {

    static final GardenRules RULES = GardenTestRules.seeded();
    static final FarmEconomyRules ECONOMY = GardenTestRules.economy();
    static final EstateRules ESTATE = GardenTestRules.estate();
    static final int[] HORIZONS = {56, 90, 180, 365};
    static final Map<String, Result> BEFORE = new LinkedHashMap<>();
    static final Map<String, Result> AFTER = new LinkedHashMap<>();

    @BeforeAll
    static void simulate() {
        var before = new EconomySimulator(RULES, ECONOMY);
        var after = new EconomySimulator(RULES, ECONOMY, ESTATE);
        for (var p : EconomySimulator.phase3aPersonas()) {
            BEFORE.put(p.code(), before.run(p, 365, EconomySimulator.phase3aPolicy(p)));
            AFTER.put(p.code(), after.run(p, 365, EconomySimulator.phase3aPolicy(p), EconomySimulator.phase3cPolicy(p)));
        }
        System.out.println(report());
    }

    static int levelAt(Result r, int day) {
        return r.days().get(day - 1).level();
    }

    static int plotsAt(Result r, int day) {
        return r.economy().get(day - 1).plots();
    }

    /** Coins spent on Phase 3C sinks (buildings + regional beds) up to a day. */
    static long estateSinks(Result r, int day) {
        return r.estateSum(Estate::sinks, 1, day);
    }

    static long production(Result r, int day) {
        return r.days().stream().filter(d -> d.day() <= day).mapToLong(EconomySimulator.Day::income).sum();
    }

    static String report() {
        StringBuilder sb = new StringBuilder("\n===== PHASE 3C ECONOMY: BEFORE (V80, 10 beds) vs AFTER (V83 estate), days 56 / 90 / 180 / 365 =====\n");
        for (String code : AFTER.keySet()) {
            Result b = BEFORE.get(code), a = AFTER.get(code);
            sb.append(String.format("%s %s%n", code, a.persona().label()));
            sb.append("    coins   ");
            for (int h : HORIZONS) sb.append(String.format("d%d %d->%d (%+.0f%%)  ", h, b.coinsAt(h), a.coinsAt(h),
                    100.0 * (a.coinsAt(h) - b.coinsAt(h)) / Math.max(1, b.coinsAt(h))));
            sb.append(String.format("%n    level   "));
            for (int h : HORIZONS) sb.append(String.format("d%d %d->%d  ", h, levelAt(b, h), levelAt(a, h)));
            sb.append(String.format("| L10 d%d->d%d  L12 d%d  L14 d%d  L16 d%d%n", b.dayReaching(10), a.dayReaching(10), a.dayReaching(12),
                    a.dayReaching(14), a.dayReaching(16)));
            sb.append("    beds    ");
            for (int h : HORIZONS) sb.append(String.format("d%d %d  ", h, plotsAt(a, h)));
            sb.append(String.format("| 10 beds d%d  14 beds d%d  18 beds d%d  24 beds d%d%n", a.dayOwningPlots(10), a.dayOwningPlots(14),
                    a.dayOwningPlots(18), a.dayOwningPlots(24)));
            var last = a.estate().getLast();
            sb.append(String.format("    estate  buildings %s (all level 3 on d%d) | learning days %d | compost batches %d | produce consumed %d%n",
                    last.buildings(), a.dayAllBuildings(3), last.learningDays(), a.estateSum(Estate::compostBatches, 1, 365),
                    a.estateSum(Estate::materials, 1, 365)));
            sb.append("    sinks   ");
            for (int h : HORIZONS) {
                long prod = production(a, h);
                long old = a.sum(Economy::marketSpend, 1, h) + a.sum(Economy::expansionSpend, 1, h);
                sb.append(String.format("d%d estate %d + 3A %d = %.0f%% of %d  ", h, estateSinks(a, h), old,
                        100.0 * (estateSinks(a, h) + old) / Math.max(1, prod), prod));
            }
            sb.append(String.format("%n    income  avg net coins / day d31-56 %.0f->%.0f  d151-180 %.0f->%.0f  d336-365 %.0f->%.0f%n",
                    b.avgIncome(31, 56), a.avgIncome(31, 56), b.avgIncome(151, 180), a.avgIncome(151, 180),
                    b.avgIncome(336, 365), a.avgIncome(336, 365)));
        }
        return sb.toString();
    }

    @Test
    void earlyProgressionIsUnchangedByTheEstate() {
        // the Phase 2 / 3A acceptance windows still hold with the estate in play
        int p1 = AFTER.get("P1").dayReaching(10), p2 = AFTER.get("P2").dayReaching(10);
        assertTrue(p1 >= 21 && p1 <= 35, "P1 level 10 on day " + p1);
        assertTrue(p2 <= 14, "P2 level 10 on day " + p2);
        for (String code : AFTER.keySet()) {
            int before = BEFORE.get(code).dayReaching(10), after = AFTER.get(code).dayReaching(10);
            assertTrue(Math.abs(after - before) <= 5, code + ": level 10 moved from day " + before + " to " + after);
            assertTrue(AFTER.get(code).dayOwningPlots(10) > 0, code + " still opens the four Phase 3A beds");
        }
    }

    @Test
    void theEstateAbsorbsCoinsOverTheWholeYearForEveryPersona() {
        for (String code : AFTER.keySet()) {
            Result b = BEFORE.get(code), a = AFTER.get(code);
            for (int h : new int[]{90, 180, 365}) {
                assertTrue(a.coinsAt(h) <= 0.6 * b.coinsAt(h), code + " day " + h + ": " + a.coinsAt(h) + " vs " + b.coinsAt(h));
            }
            // a balance never runs away within the year: at most ten days of late-game production
            assertTrue(a.coinsAt(365) <= 1_000_000, code + " holds " + a.coinsAt(365) + " coins on day 365");
            assertTrue(a.days().stream().allMatch(d -> d.coins() >= 0), code + ": the balance never goes negative");
        }
    }

    @Test
    void everyPersonaKeepsFarmingAndNobodyIsStarvedBySaving() {
        for (String code : AFTER.keySet()) {
            Result a = AFTER.get(code);
            // production keeps growing with the farm: late income is at least the early income
            assertTrue(a.avgIncome(336, 365) >= a.avgIncome(31, 56), code + ": late income " + a.avgIncome(336, 365));
            // the persona plants on every played day of the last month (it always affords seeds)
            assertTrue(a.days().stream().filter(d -> d.day() > 335 && d.present()).allMatch(d -> d.plantings() > 0), code + " keeps planting");
        }
    }

    @Test
    void aFarmOnlyPlayerAndAReturnerStillExpandWithoutLearning() {
        Result farmOnly = AFTER.get("P0");
        assertEquals(0, farmOnly.estate().getLast().learningDays(), "P0 never studies");
        assertTrue(farmOnly.dayOwningPlots(14) > 0 && farmOnly.dayOwningPlots(14) <= 240, "P0 completes the first region: day " + farmOnly.dayOwningPlots(14));
        assertTrue(plotsAt(farmOnly, 365) >= 16, "P0 owns " + plotsAt(farmOnly, 365) + " beds after a year");
        assertTrue(farmOnly.estate().getLast().buildings().values().stream().mapToInt(Integer::intValue).sum() >= 6);
        Result returner = AFTER.get("P4");
        assertTrue(plotsAt(returner, 365) >= 12, "the returner owns " + plotsAt(returner, 365) + " beds after a year");
        assertTrue(returner.estate().getLast().buildings().size() == 3, "and has built every building");
    }

    @Test
    void learningIsAnAdvantageNotARequirement() {
        // same visit pattern, with and without study: the learner (P1) is ahead of the farm-only player (P0) at every horizon
        for (int h : HORIZONS) {
            assertTrue(plotsAt(AFTER.get("P1"), h) >= plotsAt(AFTER.get("P0"), h), "day " + h);
        }
        assertTrue(AFTER.get("P1").estate().getLast().learningDays() >= 300);
    }

    @Test
    void theFarmStaysWithinItsBoundsAndNoStrategyDominates() {
        for (String code : AFTER.keySet()) {
            Result a = AFTER.get(code);
            assertTrue(a.economy().stream().allMatch(e -> e.plots() <= ESTATE.land().maxPlots()), code + " never exceeds 24 beds");
            assertTrue(a.estate().stream().allMatch(e -> e.buildings().values().stream().allMatch(l -> l <= 3)));
        }
        // maxing every cap and composting (P7) does not beat the plain revenue maximizer (P6)
        Result p6 = AFTER.get("P6"), p7 = AFTER.get("P7");
        assertTrue(plotsAt(p7, 365) <= plotsAt(p6, 365), "P7 beds " + plotsAt(p7, 365) + " vs P6 " + plotsAt(p6, 365));
        assertTrue(production(p7, 365) <= production(p6, 365) * 1.02, "P7 production " + production(p7, 365) + " vs P6 " + production(p6, 365));
        // the heaviest player needs most of a year for the last bed; a normal learner is still building after a year
        assertTrue(AFTER.get("P3").dayOwningPlots(24) >= 300, "P3 owns 24 beds on day " + AFTER.get("P3").dayOwningPlots(24));
        assertTrue(plotsAt(AFTER.get("P1"), 365) < 24 && plotsAt(AFTER.get("P1"), 365) >= 20);
    }
}
