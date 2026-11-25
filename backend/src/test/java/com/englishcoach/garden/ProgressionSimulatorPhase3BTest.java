package com.englishcoach.garden;

import com.englishcoach.garden.domain.EconomySimulator;
import com.englishcoach.garden.domain.FarmEconomyRules;
import com.englishcoach.garden.domain.GardenRules;
import com.englishcoach.garden.domain.LivingRules;
import com.englishcoach.garden.domain.LivingRules.Family;
import com.englishcoach.garden.domain.LivingRules.SkinDef;
import com.englishcoach.garden.domain.MasteryEngine;
import com.englishcoach.garden.domain.ProgressionSimulator;
import com.englishcoach.garden.domain.ProgressionSimulator.Result;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3B long-horizon acceptance: ten scripted learners over 7 / 14 / 30 / 56 / 90 / 180 / 365 simulated days (and two
 * years for the active learner) on the V82 monument rules, plus what the crop skins cost against the Phase 3A economy
 * simulation (coins) and the harvest volume (mastery). Deterministic: a re-run prints the same tables. Results feed
 * docs/echo-garden/PHASE3B_PROGRESSION_SIM_RESULTS.md — scripted scenarios, never telemetry.
 */
class ProgressionSimulatorPhase3BTest {

    static final GardenRules RULES = GardenTestRules.seeded();
    static final FarmEconomyRules ECONOMY = GardenTestRules.economy();
    static final LivingRules LIVING = GardenTestRules.living();
    static final MasteryEngine MASTERY = new MasteryEngine(LIVING);
    static final int[] DAYS = {7, 14, 30, 56, 90, 180, 365};
    static final Map<String, Result> RUNS = new LinkedHashMap<>();
    static final Map<String, EconomySimulator.Result> FARM = new LinkedHashMap<>();
    static Result twoYears;

    @BeforeAll
    static void simulate() {
        var g = RULES.knowledge().graduation();
        // a tree can graduate at the minimum age once its words were reviewed on enough different days
        var sim = new ProgressionSimulator(LIVING, g.minAgeDays(), RULES.knowledge().evidenceCap());
        for (var p : ProgressionSimulator.personas()) RUNS.put(p.code(), sim.run(p, 365));
        twoYears = sim.run(ProgressionSimulator.personas().stream().filter(p -> p.code().equals("L3")).findFirst().orElseThrow(), 730);
        var farm = new EconomySimulator(RULES, ECONOMY);
        for (var p : EconomySimulator.phase3aPersonas()) FARM.put(p.code(), farm.run(p, 90, EconomySimulator.phase3aPolicy(p)));
        System.out.println(report());
    }

    static String snapshot(ProgressionSimulator.Snapshot s) {
        return String.format("era %d | %3d days | V%d L%d S%d W%d E%d | tiers %2d | grads %2d (forest %2d)", s.era(), s.learningDays(),
                s.familyDays().get(Family.VOCABULARY), s.familyDays().get(Family.LISTENING), s.familyDays().get(Family.SPEAKING),
                s.familyDays().get(Family.WRITING), s.familyDays().get(Family.EXAM), s.branchTiers(), s.graduations(), s.forest());
    }

    /** First day the persona holds {@code cumulativePrice} coins (this skin plus the cheaper ones before it), or -1 in 90 days. */
    static int affordDay(EconomySimulator.Result r, long cumulativePrice) {
        for (int d = 1; d <= 90; d++) if (r.coinsAt(d) >= cumulativePrice) return d;
        return -1;
    }

    /**
     * First day the cumulative plantings of a crop reach {@code harvests} in at least {@code seasons} different theme
     * weeks (a planting is harvested within the same visit cycle; the simulated calendar turns every seven days), or -1.
     */
    static int harvestDay(EconomySimulator.Result r, String crop, int harvests, int seasons) {
        Set<Integer> seen = new HashSet<>();
        int total = 0;
        for (int d = 1; d <= 90; d++) {
            int today = r.plantedCounts(d, d).getOrDefault(crop, 0);
            if (today > 0) seen.add(((d - 1) / 7) % 4);
            total += today;
            if (total >= harvests && seen.size() >= seasons) return d;
        }
        return -1;
    }

    static int masteryDay(EconomySimulator.Result r, SkinDef s) {
        var tier = LIVING.mastery().tiers().get(s.masteryTier() - 1);
        return harvestDay(r, s.cropCode(), MASTERY.harvestsNeeded(RULES.crop(s.cropCode()).rarity(), tier), tier.seasons());
    }

    static String report() {
        StringBuilder sb = new StringBuilder("\n===== PHASE 3B PROGRESSION (V82 monument rules) =====\n");
        sb.append("gates: ").append(LIVING.monument().eras()).append(" | branch tiers ").append(LIVING.monument().branchTiers())
                .append(" | memory tiers ").append(LIVING.monument().memoryTiers()).append(" | ring every ")
                .append(LIVING.monument().ringEveryDays()).append(" days\n");
        for (var r : RUNS.values()) {
            sb.append(String.format("%s %s%n    first ornament day %d | era 1 day %d | era 2 day %d | era 3 day %d | era 4 day %d%n",
                    r.persona().code(), r.persona().label(), r.firstOrnamentDay(), r.dayReachingEra(1), r.dayReachingEra(2),
                    r.dayReachingEra(3), r.dayReachingEra(4)));
            for (int d : DAYS) sb.append(String.format("    d%-3d %s%n", d, snapshot(r.at(d))));
        }
        sb.append(String.format("L3 over two years: era 4 day %d | d730 %s | rings %d%n", twoYears.dayReachingEra(4),
                snapshot(twoYears.at(730)), twoYears.at(730).rings()));

        sb.append("\n===== CROP SKINS against the Phase 3A economy (90 days, phase3a policy) =====\n");
        List<SkinDef> coin = LIVING.skins().values().stream().filter(s -> s.unlockKind().equals("COIN"))
                .sorted(Comparator.comparingLong(SkinDef::coinPrice)).toList();
        long all = coin.stream().mapToLong(SkinDef::coinPrice).sum();
        for (var e : FARM.entrySet()) {
            var r = e.getValue();
            StringBuilder line = new StringBuilder(String.format("%s coins d30 %7d d56 %7d d90 %7d |", e.getKey(), r.coinsAt(30), r.coinsAt(56),
                    r.coinsAt(90)));
            long spent = 0;
            for (SkinDef s : coin) {
                spent += s.coinPrice();
                line.append(String.format(" %s %d: d%d", s.code(), s.coinPrice(), affordDay(r, spent)));
            }
            line.append(String.format(" | all three = %.0f%% of the d90 balance", 100.0 * all / Math.max(1, r.coinsAt(90))));
            sb.append(line).append(System.lineSeparator());
            StringBuilder m = new StringBuilder("    mastery skins reached on day:");
            for (SkinDef s : LIVING.skins().values()) {
                if (!s.unlockKind().equals("MASTERY")) continue;
                var tier = LIVING.mastery().tiers().get(s.masteryTier() - 1);
                m.append(String.format(" %s (%d %s harvests in %d seasons): d%d |", s.code(),
                        MASTERY.harvestsNeeded(RULES.crop(s.cropCode()).rarity(), tier), s.cropCode(), tier.seasons(), masteryDay(r, s)));
            }
            sb.append(m).append(System.lineSeparator());
        }
        return sb.toString();
    }

    @Test
    void earlyProgressIsVisibleButAnEraTakesWeeks() {
        for (String code : List.of("L1", "L2", "L3", "L8")) {
            Result r = RUNS.get(code);
            assertTrue(r.firstOrnamentDay() > 0 && r.firstOrnamentDay() <= 14, code + " first ornament day " + r.firstOrnamentDay());
            assertTrue(r.dayReachingEra(1) >= 21, code + " an era is never a one-week reward");
        }
        assertTrue(RUNS.get("L2").dayReachingEra(1) <= 35);
        assertTrue(RUNS.get("L3").dayReachingEra(1) <= 21 + 3);
    }

    @Test
    void laterErasNeedMonthsGraduationsAndBreadth() {
        Result normal = RUNS.get("L2"), active = RUNS.get("L3");
        assertTrue(normal.dayReachingEra(2) >= 75 && normal.dayReachingEra(2) <= 120, "normal era 2 day " + normal.dayReachingEra(2));
        assertTrue(active.dayReachingEra(2) >= 75 && active.dayReachingEra(2) <= 90);
        assertTrue(active.dayReachingEra(3) >= 180 && active.dayReachingEra(3) <= 200);
        assertTrue(normal.dayReachingEra(3) >= 180 && normal.dayReachingEra(3) <= 365, "normal era 3 day " + normal.dayReachingEra(3));
        assertEquals(-1, normal.dayReachingEra(4), "six days a week is not 365 verified days in one year");
        assertTrue(twoYears.dayReachingEra(4) >= 365 && twoYears.dayReachingEra(4) <= 380);
        assertTrue(twoYears.at(730).rings() >= 3, "progress continues after the final era");
    }

    @Test
    void noEvidenceNoProgressAndNoExploitPath() {
        assertEquals(0, RUNS.get("L0").at(365).era(), "a farm-only player keeps the original tree: honest, not punished");
        assertEquals(0, RUNS.get("L0").at(365).learningDays());
        Result exploit = RUNS.get("L7");
        assertEquals(365, exploit.at(365).learningDays());
        assertEquals(1, exploit.at(365).era(), "minimum reviews of the same five words never pass era 1");
        assertEquals(1, exploit.at(365).graduations());
        // the minimum-effort harvest-focused learner still moves, slowly
        Result harvest = RUNS.get("L6");
        assertTrue(harvest.dayReachingEra(1) > 60, "two minimal days a week reach era 1 only after months: " + harvest.dayReachingEra(1));
    }

    @Test
    void absenceAndInfrequencyKeepEverything() {
        Result returner = RUNS.get("L5");
        assertEquals(returner.at(21).era(), returner.at(81).era());
        assertEquals(returner.at(21).learningDays(), returner.at(81).learningDays());
        assertTrue(returner.at(365).learningDays() > returner.at(81).learningDays(), "the returner simply continues");
        Result infrequent = RUNS.get("L4");
        assertEquals(52, infrequent.at(365).learningDays(), 1);
        assertTrue(infrequent.at(365).era() >= 1, "one day a week still earns the first era within a year");
    }

    @Test
    void oneSkillLearnersAreBoundedByDesignAndTheReportSaysSo() {
        // vocabulary only (mastered deck, new words in trees): era 2 is reachable, era 3 needs two tiers from another skill
        Result mastered = RUNS.get("L8");
        assertTrue(mastered.dayReachingEra(2) > 0 && mastered.dayReachingEra(2) <= 90);
        assertEquals(-1, mastered.dayReachingEra(3));
        assertEquals(3, mastered.at(365).branchTiers());
        // writing only, no flashcards: the branch grows, but trees (graduations) need real cards
        Result writer = RUNS.get("L9");
        assertEquals(1, writer.at(365).era());
        assertEquals(3, writer.at(365).branchTiers());
        assertEquals(0, writer.at(365).graduations());
    }

    @Test
    void skinsAreALongTermSinkNeverAFaucetAndNeverOutOfReach() {
        long all = LIVING.skins().values().stream().mapToLong(SkinDef::coinPrice).sum();
        assertEquals(234_000, all);
        // every farming persona can afford the first coin skin within two months; the full set is a long goal
        for (var e : FARM.entrySet()) {
            int first = affordDay(e.getValue(), 24_000);
            assertTrue(first > 0 && first <= 60, e.getKey() + " first coin skin day " + first);
        }
        assertTrue(affordDay(FARM.get("P1"), all) > 30, "the full coin collection is not a first-month purchase");
        // a mastery skin is a specialisation: a crop the persona farms reaches it, but never inside two weeks (three seasons)
        int rose = masteryDay(FARM.get("P1"), LIVING.skin("ROSE_MOON"));
        assertTrue(rose >= 15 && rose <= 90, "normal learner, rose mastery tier 4 day " + rose);
        // ... and a crop a profit-seeking persona stops growing is never reached by accident: it is a deliberate choice
        assertEquals(-1, masteryDay(FARM.get("P6"), LIVING.skin("WHEAT_DUSK")));
    }
}
