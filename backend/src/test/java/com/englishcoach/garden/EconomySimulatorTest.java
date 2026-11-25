package com.englishcoach.garden;

import com.englishcoach.garden.domain.EconomySimulator;
import com.englishcoach.garden.domain.EconomySimulator.Result;
import com.englishcoach.garden.domain.GardenRules;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 2 economy acceptance on the exact Phase 2 rules ({@link GardenTestRules#phase2()} = V77 + V78; the current
 * V80 chain and the Phase 3A economy are asserted by EconomySimulatorPhase3Test). Phase 2 reality:
 * flashcards + skill lessons + games, weather, Knowledge Trees, essence, pests, Epic seeds, seven personas including a
 * returner and a revenue maximizer. Results feed docs/echo-garden/PHASE2_ECONOMY_SIM_RESULTS.md.
 */
class EconomySimulatorTest {

    static final GardenRules RULES = GardenTestRules.phase2();
    static final int DAYS = 56;
    static final Map<String, Result> RUNS = new LinkedHashMap<>();

    @BeforeAll
    static void simulate() {
        RUNS.putAll(runAll(RULES, DAYS));
        System.out.println(report("BEFORE: Phase 2 systems on V77 balance", runAll(GardenTestRules.uncalibrated(), DAYS)));
        System.out.println(report("AFTER: PHASE 2 (V77 + V78)", RUNS));
    }

    static Map<String, Result> runAll(GardenRules rules, int days) {
        var sim = new EconomySimulator(rules);
        Map<String, Result> runs = new LinkedHashMap<>();
        for (var p : EconomySimulator.standardPersonas()) runs.put(p.code(), sim.run(p, days));
        return runs;
    }

    static double income(Map<String, Result> runs, String p) {
        return runs.get(p).avgIncome(8, 30);
    }

    static String report(String title, Map<String, Result> runs) {
        StringBuilder sb = new StringBuilder("\n===== ").append(title).append(" =====\n");
        double p1 = income(runs, "P1");
        sb.append(String.format("A1 P2/P1 income %.3f (<= 2.5) | A2 P0/P1 %.3f (<= 0.6) | A3 P3/P1 %.3f (<= 1.8)%n",
                income(runs, "P2") / p1, income(runs, "P0") / p1, income(runs, "P3") / p1));
        sb.append(String.format("A4 P1 L5 day %d (<= 5), L10 day %d (21..35) | A5 P2 L10 day %d (<= 14)%n",
                runs.get("P1").dayReaching(5), runs.get("P1").dayReaching(10), runs.get("P2").dayReaching(10)));
        var r1 = runs.get("P1");
        sb.append(String.format("A8 P1 free water/day %.2f vs usable %.2f%n", r1.avg(EconomySimulator.Day::freeWater, 8, 30),
                3 * r1.avg(EconomySimulator.Day::plantings, 8, 30)));
        for (var e : runs.entrySet()) {
            var r = e.getValue();
            var last = r.days().getLast();
            var x14 = r.xpUntil(14);
            sb.append(String.format("%s %-48s L5 d%-3d L10 d%-3d L15 d%-3d | d%d level %d coins %d essence %d | income d8-30 %.0f%n",
                    e.getKey(), r.persona().label(), r.dayReaching(5), r.dayReaching(10), r.dayReaching(15), last.day(),
                    last.level(), last.coins(), last.essence(), r.avgIncome(8, 30)));
            sb.append(String.format("    XP d1-14 total %d = harvest %d · codex %d · cards %d · goal %d · skills %d · games %d · graduation %d · pests %d%n",
                    x14.total(), x14.harvest(), x14.codex(), x14.cards(), x14.goal(), x14.skills(), x14.games(),
                    x14.graduation(), x14.pests()));
            sb.append(String.format("    graduations %d · pests %d · essence gained %d · fertilizer gained %d · crops d8-56 %s · tiers %s%n",
                    r.days().stream().mapToInt(EconomySimulator.Day::graduations).sum(),
                    r.days().stream().mapToInt(EconomySimulator.Day::pests).sum(),
                    r.days().stream().mapToInt(EconomySimulator.Day::essenceGained).sum(),
                    r.days().stream().mapToInt(EconomySimulator.Day::fertilizerGained).sum(),
                    r.plantedCounts(8, DAYS), r.tierCounts(8, DAYS)));
        }
        return sb.toString();
    }

    @Test
    void criteriaHoldOnTheSeededRules() {
        double p1 = income(RUNS, "P1");
        assertTrue(income(RUNS, "P2") / p1 <= 2.5, "A1");
        assertTrue(income(RUNS, "P0") / p1 <= 0.6, "A2");
        assertTrue(income(RUNS, "P3") / p1 <= 1.8, "A3");
        int l5 = RUNS.get("P1").dayReaching(5);
        assertTrue(l5 > 0 && l5 <= 5, "A4 first half: P1 level 5 within 5 days (" + l5 + ")");
        int l10 = RUNS.get("P1").dayReaching(10);
        assertTrue(l10 >= 21 && l10 <= 35, "A4: P1 level 10 in days 21..35 (" + l10 + ")");
        int p2l10 = RUNS.get("P2").dayReaching(10);
        assertTrue(p2l10 > 0 && p2l10 <= 14, "A5: P2 level 10 within 14 days (" + p2l10 + ")");
        var r1 = RUNS.get("P1");
        assertTrue(r1.avg(EconomySimulator.Day::freeWater, 8, 30) < 0.5 * 3 * r1.avg(EconomySimulator.Day::plantings, 8, 30), "A8");
    }

    @Test
    void noPersonaEverDeadEndsAndReturnersLoseNothing() {
        RUNS.values().forEach(r -> r.days().forEach(d -> {
            assertTrue(d.coins() >= 0, r.persona().code() + " day " + d.day());
            assertTrue(d.essence() >= 0, r.persona().code() + " essence day " + d.day());
            if (d.present()) assertTrue(d.plantings() > 0 || d.day() > 1, r.persona().code() + " plants (day " + d.day() + ")");
        }));
        // a returner (2 of every 5 days) still levels up and never goes backwards
        var p4 = RUNS.get("P4");
        for (int i = 1; i < p4.days().size(); i++) assertTrue(p4.days().get(i).totalXp() >= p4.days().get(i - 1).totalXp());
        assertTrue(p4.dayReaching(5) > 0, "returner reaches level 5");
    }

    /** Choices vary: no single crop is planted by the strategic personas in every season. */
    @Test
    void noSingleCropDominatesEverySeason() {
        for (String code : new String[]{"P1", "P3", "P6"}) {
            var r = RUNS.get(code);
            var weeks = new java.util.ArrayList<Map<String, Integer>>();
            for (int w = 1; w < DAYS / 7; w++) weeks.add(r.plantedCounts(w * 7 + 1, w * 7 + 7));
            long distinctTop = weeks.stream().map(m -> m.entrySet().stream().max(Map.Entry.comparingByValue())
                    .map(Map.Entry::getKey).orElse("")).distinct().count();
            assertTrue(distinctTop >= 2, code + " plants the same top crop every week: " + weeks);
        }
    }

    @Test
    void knowledgeTreesGraduateAndEssenceUnlocksEpicSeeds() {
        var p2 = RUNS.get("P2");
        assertTrue(p2.days().stream().mapToInt(EconomySimulator.Day::graduations).sum() >= 2, "P2 graduates trees");
        assertTrue(p2.days().stream().mapToInt(EconomySimulator.Day::essenceGained).sum() > 0, "essence accrues");
        var p0 = RUNS.get("P0");
        assertEquals(0, p0.days().stream().mapToInt(EconomySimulator.Day::graduations).sum(), "no learning, no graduation");
    }

    @Test
    void a6CareItemsBoughtWithCoinsNeverPayForThemselves() {
        for (CropDef c : RULES.crops().values()) {
            if (c.qaOnly()) continue;
            double profitWithBlessing = c.sellPrice() * RULES.blessingSellMultiplier() - c.seedPrice();
            for (var b : RULES.boosts().values()) {
                double saved = b.fraction() * profitWithBlessing;
                assertTrue(saved < b.coinPrice(), c.code() + " " + b.code() + " saves " + saved + " >= " + b.coinPrice());
            }
        }
    }
}
