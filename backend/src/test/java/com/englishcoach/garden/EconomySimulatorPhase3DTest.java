package com.englishcoach.garden;

import com.englishcoach.garden.domain.EconomySimulator;
import com.englishcoach.garden.domain.EconomySimulator.Farming;
import com.englishcoach.garden.domain.EconomySimulator.Result;
import com.englishcoach.garden.domain.FarmingEngine;
import com.englishcoach.garden.domain.FarmingRules;
import com.englishcoach.garden.domain.GardenRules;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Phase 3D long-horizon economy: the Phase 3C simulation (V83 rules: estate, 24 beds) against the same personas under
 * the V85 farming rules (crop growth profiles, soil moisture, supplies, harvest bonus), plus two new personas — a
 * protection-heavy player and the easiest repeatable coin loop. One 365-day run per persona, read at days 7, 14, 30, 56,
 * 90, 180 and 365. Results feed docs/echo-garden/PHASE3D_ECONOMY_SIM_RESULTS.md. A deterministic model of scripted
 * personas — not telemetry.
 */
class EconomySimulatorPhase3DTest {

    static final GardenRules OLD = GardenTestRules.seeded();
    static final GardenRules RULES = GardenTestRules.phase3d();
    static final FarmingRules FARMING = GardenTestRules.farming();
    static final int[] HORIZONS = {7, 14, 30, 56, 90, 180, 365};
    static final Map<String, Result> BEFORE = new LinkedHashMap<>();
    static final Map<String, Result> AFTER = new LinkedHashMap<>();

    @BeforeAll
    static void simulate() {
        var before = new EconomySimulator(OLD, GardenTestRules.economy(), GardenTestRules.estate());
        var after = new EconomySimulator(RULES, GardenTestRules.economy3d(), GardenTestRules.estate(), FARMING);
        for (var p : EconomySimulator.phase3dPersonas()) {
            BEFORE.put(p.code(), before.run(p, 365, EconomySimulator.phase3aPolicy(p), EconomySimulator.phase3cPolicy(p)));
            AFTER.put(p.code(), after.run(p, 365, EconomySimulator.phase3aPolicy(p), EconomySimulator.phase3cPolicy(p),
                    EconomySimulator.phase3dPolicy(p)));
        }
        // the same learner (P1) and the same perfectionist (P6) under four care policies: is care worth it, is it mandatory?
        for (String code : new String[]{"P1", "P6"}) {
            var p = EconomySimulator.phase3dPersonas().stream().filter(x -> x.code().equals(code)).findFirst().orElseThrow();
            CARE.put(code + " ignores the soil", after.run(p, 365, EconomySimulator.phase3aPolicy(p), EconomySimulator.phase3cPolicy(p),
                    new EconomySimulator.FarmingPolicy(false, false, -1, false)));
            CARE.put(code + " waters only", after.run(p, 365, EconomySimulator.phase3aPolicy(p), EconomySimulator.phase3cPolicy(p),
                    new EconomySimulator.FarmingPolicy(true, true, -1, false)));
            CARE.put(code + " protects valuable crops", after.run(p, 365, EconomySimulator.phase3aPolicy(p), EconomySimulator.phase3cPolicy(p),
                    new EconomySimulator.FarmingPolicy(true, true, 200, true)));
            CARE.put(code + " protects every crop", after.run(p, 365, EconomySimulator.phase3aPolicy(p), EconomySimulator.phase3cPolicy(p),
                    new EconomySimulator.FarmingPolicy(true, true, 0, true)));
        }
        System.out.println(report());
    }

    static final Map<String, Result> CARE = new LinkedHashMap<>();

    static long production(Result r, int from, int to) {
        return r.days().stream().filter(d -> d.day() >= from && d.day() <= to).mapToLong(EconomySimulator.Day::income).sum();
    }

    static int plotsAt(Result r, int day) {
        return r.economy().get(day - 1).plots();
    }

    static String report() {
        StringBuilder sb = new StringBuilder("\n===== PHASE 3D ECONOMY (before = V83 rules, after = V85 rules) =====\n");
        var engine = new FarmingEngine(RULES, FARMING);
        sb.append("crop | hours | seed | sell | profit/h | bonus | thirst\n");
        for (CropDef c : RULES.crops().values().stream().sorted(java.util.Comparator.comparingInt(CropDef::sortOrder)).toList()) {
            if (c.qaOnly()) continue;
            double h = c.baseSeconds() / 3600.0;
            sb.append(String.format("%s | %.1f | %d | %d | %.1f | %d | %.1f%n", c.code(), h, c.seedPrice(), c.sellPrice(),
                    (c.sellPrice() - c.seedPrice()) / h, engine.harvestBonus(c), FARMING.thirstOf(c.code())));
        }
        for (var e : AFTER.entrySet()) {
            Result a = e.getValue();
            Result b = BEFORE.get(e.getKey());
            sb.append("\n").append(a.persona().code()).append(" ").append(a.persona().label()).append("\n");
            sb.append("  level 10 day: ").append(b.dayReaching(10)).append(" -> ").append(a.dayReaching(10))
                    .append(" | level 5 day: ").append(b.dayReaching(5)).append(" -> ").append(a.dayReaching(5)).append("\n");
            int prev = 0;
            for (int h : HORIZONS) {
                int from = prev + 1;
                double days = h - prev;
                sb.append(String.format("  d%-3d coins %,d -> %,d | level %d -> %d | beds %d -> %d | net/day %,.0f -> %,.0f"
                                + " | bonus/day %.0f | supplies/day %.0f (%d used) | harvests/day %.1f stressed %.0f%% | dry %d wet %d%n",
                        h, b.coinsAt(h), a.coinsAt(h), b.days().get(h - 1).level(), a.days().get(h - 1).level(), plotsAt(b, h), plotsAt(a, h),
                        production(b, from, h) / days, production(a, from, h) / days,
                        a.farmingSum(Farming::bonusCoins, from, h) / days, a.farmingSum(Farming::supplySpend, from, h) / days,
                        a.farmingSum(Farming::suppliesUsed, from, h), a.farmingSum(Farming::harvests, from, h) / days,
                        100.0 * a.farmingSum(Farming::stressedHarvests, from, h) / Math.max(1, a.farmingSum(Farming::harvests, from, h)),
                        a.farmingSum(Farming::dryFinds, from, h), a.farmingSum(Farming::wetFinds, from, h)));
                prev = h;
            }
            sb.append("  planted d1-90: ").append(a.plantedCounts(1, 90)).append("\n");
            sb.append("  planted d271-365: ").append(a.plantedCounts(271, 365)).append("\n");
            sb.append("  tiers d1-365: ").append(a.tierCounts(1, 365)).append("\n");
            sb.append("  year: sales ").append(String.format("%,d", a.days().stream().mapToLong(EconomySimulator.Day::sales).sum()))
                    .append(" orders ").append(String.format("%,d", a.sum(EconomySimulator.Economy::orderCoins, 1, 365)))
                    .append(" bonus ").append(String.format("%,d", a.farmingSum(Farming::bonusCoins, 1, 365)))
                    .append(" seeds ").append(String.format("%,d", a.sum(EconomySimulator.Economy::seedSpend, 1, 365)))
                    .append(" supplies ").append(String.format("%,d", a.farmingSum(Farming::supplySpend, 1, 365)))
                    .append(" market ").append(String.format("%,d", a.sum(EconomySimulator.Economy::marketSpend, 1, 365)))
                    .append(" estate ").append(String.format("%,d", a.estateSum(EconomySimulator.Estate::sinks, 1, 365)))
                    .append(" | buildings ").append(a.estate().get(364).buildings()).append("\n");
        }
        sb.append("\n----- care policies (365 days; net = sales + orders + bonus - seeds - packs - supplies) -----\n");
        for (var e : CARE.entrySet()) {
            Result a = e.getValue();
            long harvests = a.farmingSum(Farming::harvests, 1, 365);
            sb.append(String.format("%s: net %,d | supplies %,d (%d used) | harvests %,d stressed %.1f%% | tiers %s | beds %d | level %d%n",
                    e.getKey(), production(a, 1, 365), a.farmingSum(Farming::supplySpend, 1, 365), a.farmingSum(Farming::suppliesUsed, 1, 365),
                    harvests, 100.0 * a.farmingSum(Farming::stressedHarvests, 1, 365) / Math.max(1, harvests), a.tierCounts(1, 365),
                    plotsAt(a, 365), a.days().get(364).level()));
        }
        return sb.toString();
    }

    @Test
    void tenPersonasRunAFullYearAndTheFarmStaysBounded() {
        assertEquals(10, AFTER.size());
        for (Result r : AFTER.values()) {
            assertEquals(365, r.days().size());
            assertTrue(plotsAt(r, 365) <= 24, r.persona().code() + " never owns more than 24 beds");
            assertTrue(r.days().stream().allMatch(d -> d.coins() >= 0), r.persona().code() + " never goes below zero");
        }
    }

    @Test
    void earlyProgressionStaysAccessible() {
        for (String code : new String[]{"P0", "P1", "P2", "P3", "P5"}) {
            Result b = BEFORE.get(code), a = AFTER.get(code);
            assertTrue(a.dayReaching(5) <= b.dayReaching(5) + 1, code + " level 5: " + b.dayReaching(5) + " -> " + a.dayReaching(5));
            assertTrue(a.dayReaching(10) <= b.dayReaching(10) + 3, code + " level 10: " + b.dayReaching(10) + " -> " + a.dayReaching(10));
        }
    }

    @Test
    void noFarmingLoopLosesMoneyAndEveryoneKeepsEarning() {
        for (Result r : AFTER.values()) {
            for (int from = 1; from <= 331; from += 30) {
                assertTrue(production(r, from, from + 29) > 0, r.persona().code() + " earns in days " + from + "+");
            }
        }
        // a farming-only player keeps a viable path: it still expands and still upgrades buildings within the year
        Result p0 = AFTER.get("P0");
        assertTrue(plotsAt(p0, 365) >= 14, "farm-only beds after a year: " + plotsAt(p0, 365));
    }

    @Test
    void dailyCoinGenerationIsLowerThanBeforeForRegularPlayers() {
        for (String code : new String[]{"P1", "P2", "P3", "P6", "P7"}) {
            double before = production(BEFORE.get(code), 336, 365), after = production(AFTER.get(code), 336, 365);
            assertTrue(after <= 0.75 * before, code + " late-year income " + before + " -> " + after);
            assertTrue(after >= 0.40 * before, code + " is not starved: " + before + " -> " + after);
        }
    }

    @Test
    void anAbsentPlayerIsNotPunished() {
        Result b = BEFORE.get("P4"), a = AFTER.get("P4");
        assertTrue(production(a, 1, 365) >= 0.9 * production(b, 1, 365), "a returner earns at least what it earned before");
        assertTrue(plotsAt(a, 365) >= plotsAt(b, 365) - 1);
        // every crop it left alone was still harvested: nothing died while it was away
        assertTrue(a.farmingSum(Farming::harvests, 1, 365) > 2000);
    }

    @Test
    void theEasiestRepeatableLoopIsNotTheBestStrategy() {
        long loop = production(AFTER.get("P9"), 1, 365);
        assertTrue(loop < 0.6 * production(AFTER.get("P1"), 1, 365), "an hourly Common-crop loop earns far less than an ordinary learner");
        assertTrue(loop < production(AFTER.get("P0"), 1, 365), "and less than relaxed farming with three visits a day");
    }

    @Test
    void noSingleCropDominatesARelaxedPlayerAndLongCropsAreWorthTheirTime() {
        for (String code : new String[]{"P0", "P1", "P2", "P5", "P8"}) {
            var planted = AFTER.get(code).plantedCounts(271, 365);
            long total = planted.values().stream().mapToLong(Integer::longValue).sum();
            assertTrue(planted.size() >= 4, code + " grows several species: " + planted);
            assertTrue(planted.values().stream().allMatch(v -> v < 0.5 * total), code + ": no crop is half of the plantings " + planted);
        }
        var crops = RULES.crops().values().stream().filter(c -> !c.qaOnly() && c.purchasable())
                .sorted(java.util.Comparator.comparingInt(CropDef::baseSeconds)).toList();
        for (int i = 1; i < crops.size(); i++) {
            CropDef slow = crops.get(i), fast = crops.get(i - 1);
            assertTrue(slow.sellPrice() - slow.seedPrice() > fast.sellPrice() - fast.seedPrice(),
                    slow.code() + " is worth more per harvest than " + fast.code());
        }
        for (CropDef c : crops) {
            double perHour = (c.sellPrice() - c.seedPrice()) / (c.baseSeconds() / 3600.0);
            assertTrue(perHour >= 14 && perHour <= 24, c.code() + " profit per hour " + perHour);
        }
    }

    @Test
    void theHarvestBonusIsSmallAndCappedEveryDay() {
        for (Result r : AFTER.values()) {
            assertTrue(r.farming().stream().allMatch(f -> f.bonusCoins() <= FARMING.harvestBonus().dailyCap()),
                    r.persona().code() + ": the daily cap holds");
            long bonus = r.farmingSum(Farming::bonusCoins, 1, 365);
            long gross = r.days().stream().mapToLong(EconomySimulator.Day::sales).sum() + r.sum(EconomySimulator.Economy::orderCoins, 1, 365) + bonus;
            assertTrue(bonus > 0 && bonus <= 0.08 * gross, r.persona().code() + " bonus share " + bonus + " / " + gross);
        }
    }

    @Test
    void careIsWorthItNeverMandatoryAndBlindSpendingLoses() {
        for (String code : new String[]{"P1", "P6"}) {
            long ignores = production(CARE.get(code + " ignores the soil"), 1, 365);
            long waters = production(CARE.get(code + " waters only"), 1, 365);
            long careful = production(CARE.get(code + " protects valuable crops"), 1, 365);
            long blanket = production(CARE.get(code + " protects every crop"), 1, 365);
            assertTrue(waters >= ignores, code + ": tending the soil never earns less than ignoring it");
            assertTrue(careful > waters, code + ": supplies bought when the forecast calls for them pay for themselves");
            assertTrue(ignores >= 0.93 * careful, code + ": ignoring the soil costs a few percent, not the game");
            assertTrue(blanket < careful, code + ": covering every crop blindly is a waste");
        }
    }
}
