package com.englishcoach.garden;

import com.englishcoach.garden.domain.EchoGuide;
import com.englishcoach.garden.domain.GardenRules.Rarity;
import com.englishcoach.garden.domain.LivingEngine;
import com.englishcoach.garden.domain.LivingRules;
import com.englishcoach.garden.domain.LivingRules.Family;
import com.englishcoach.garden.domain.MasteryEngine;
import com.englishcoach.garden.domain.MonumentEngine;
import com.englishcoach.garden.domain.MonumentEngine.Counters;
import com.englishcoach.garden.domain.ProgressionSimulator;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3B pure rules (no Spring, no database, no clock): the monument's eras / branches / rings, crop mastery, skin
 * eligibility and Echo's single-hint priority, on the V82 seed fixture.
 */
class GardenPhase3BDomainTest {

    static final LivingRules RULES = GardenTestRules.living();
    static final LivingEngine LIVING = LivingEngine.of(RULES);
    static final MonumentEngine MONUMENT = LIVING.monument();
    static final MasteryEngine MASTERY = LIVING.mastery();

    static Counters c(int days, int vocab, int listening, int speaking, int writing, int exam, int graduations) {
        return MonumentEngine.counters(days, vocab, listening, speaking, writing, exam, graduations);
    }

    @Nested
    class Monument {
        @Test
        void branchAndMemoryTiersFollowTheSeededThresholds() {
            assertEquals(0, MONUMENT.branchTier(2));
            assertEquals(1, MONUMENT.branchTier(3));
            assertEquals(2, MONUMENT.branchTier(20));
            assertEquals(3, MONUMENT.branchTier(60));
            assertEquals(3, MONUMENT.branchTier(5000), "a branch is bounded: three tiers, whatever the history");
            assertEquals(20, MONUMENT.nextBranchAt(3).orElseThrow());
            assertTrue(MONUMENT.nextBranchAt(60).isEmpty());
            assertEquals(List.of(0, 1, 2, 3), List.of(MONUMENT.memoryTier(0), MONUMENT.memoryTier(1), MONUMENT.memoryTier(5), MONUMENT.memoryTier(15)));
        }

        @Test
        void anEraNeedsDaysGraduationsAndBranchesTogether() {
            assertEquals(0, MONUMENT.era(c(20, 20, 0, 0, 0, 0, 0)), "20 days are not 21");
            assertEquals(1, MONUMENT.era(c(21, 21, 0, 0, 0, 0, 0)));
            assertEquals(0, MONUMENT.era(c(21, 0, 0, 0, 0, 0, 0)), "days without any branch tier (games only) are not an era");
            // a whole year of days alone never passes era 1: graduations and branch breadth are required
            assertEquals(1, MONUMENT.era(c(365, 365, 0, 0, 0, 0, 0)));
            assertEquals(1, MONUMENT.era(c(365, 365, 0, 0, 0, 0, 2)), "two graduations are not three");
            assertEquals(2, MONUMENT.era(c(75, 75, 0, 0, 0, 0, 3)), "vocabulary alone reaches era 2 (tier 3 = three branch tiers)");
            assertEquals(2, MONUMENT.era(c(365, 365, 0, 0, 0, 0, 40)), "era 3 asks for five branch tiers: one family tops out at three");
            assertEquals(3, MONUMENT.era(c(180, 170, 3, 3, 0, 0, 10)));
            assertEquals(3, MONUMENT.era(c(400, 400, 3, 3, 0, 0, 24)));
            assertEquals(4, MONUMENT.era(c(365, 300, 20, 20, 3, 0, 25)));
            // graduations alone, or one easy activity, are never an era
            assertEquals(0, MONUMENT.era(c(1, 1, 0, 0, 0, 0, 50)));
        }

        @Test
        void theNextEraListsExactlyWhatIsMissing() {
            var next = MONUMENT.next(1, c(40, 40, 0, 0, 0, 0, 1)).orElseThrow();
            assertEquals(2, next.era());
            assertEquals(Map.of("DAYS", "40/75", "GRADUATIONS", "1/3", "BRANCHES", "2/3"),
                    Map.of(next.requirements().get(0).code(), next.requirements().get(0).have() + "/" + next.requirements().get(0).need(),
                            next.requirements().get(1).code(), next.requirements().get(1).have() + "/" + next.requirements().get(1).need(),
                            next.requirements().get(2).code(), next.requirements().get(2).have() + "/" + next.requirements().get(2).need()));
            assertTrue(next.requirements().stream().noneMatch(MonumentEngine.Requirement::met));
            assertTrue(MONUMENT.next(4, c(999, 999, 99, 99, 99, 99, 99)).isEmpty(), "no era after the last one");
        }

        @Test
        void progressContinuesAfterTheFinalEraWithoutGrowingTheScene() {
            Counters done = c(365, 300, 20, 20, 3, 0, 25);
            assertEquals(0, MONUMENT.rings(4, done));
            assertEquals(100, MONUMENT.daysToNextRing(4, done).orElseThrow());
            assertEquals(3, MONUMENT.rings(4, c(700, 600, 60, 60, 60, 60, 80)));
            assertEquals(0, MONUMENT.rings(3, c(700, 600, 60, 60, 60, 60, 80)), "rings start after the final era");
            // ten years of history: the visible state is still five branches x three tiers + three lantern tiers
            Counters decade = c(3650, 3650, 3650, 3650, 3650, 3650, 900);
            assertEquals(15, MONUMENT.branchTierSum(decade));
            assertEquals(3, MONUMENT.memoryTier(900));
            assertEquals(4, MONUMENT.era(decade));
        }

        @Test
        void milestonesAreEveryStepReachedOnceEach() {
            var ms = MONUMENT.milestones(1, c(21, 21, 3, 0, 0, 0, 1));
            assertTrue(ms.contains(new MonumentEngine.Milestone("ERA", "ERA", 1)));
            assertTrue(ms.contains(new MonumentEngine.Milestone("BRANCH", "VOCABULARY", 2)));
            assertTrue(ms.contains(new MonumentEngine.Milestone("BRANCH", "LISTENING", 1)));
            assertTrue(ms.contains(new MonumentEngine.Milestone("MEMORY", "MEMORY", 1)));
            assertEquals(ms.size(), ms.stream().distinct().count());
            assertTrue(MONUMENT.milestones(0, c(0, 0, 0, 0, 0, 0, 0)).isEmpty());
        }

        @Test
        void aGraduatedTreeCountsOnlyWhenEnoughOfItsWordsAreNew() {
            assertTrue(MONUMENT.credits(5));
            assertTrue(MONUMENT.credits(3));
            assertFalse(MONUMENT.credits(2));
            assertFalse(MONUMENT.credits(0), "the same five words again never mint a second credit");
        }
    }

    @Nested
    class Mastery {
        static final LivingRules.MasteryTier T3 = RULES.mastery().tiers().get(2);

        @Test
        void tiersComeFromRecordedHarvestsQualitySeasonsAndForms() {
            assertEquals(0, MASTERY.tier(Rarity.COMMON, new MasteryEngine.Facts(0, 0, 0, 0)));
            assertEquals(1, MASTERY.tier(Rarity.COMMON, new MasteryEngine.Facts(1, 0, 1, 1)));
            assertEquals(2, MASTERY.tier(Rarity.COMMON, new MasteryEngine.Facts(29, 3, 4, 7)), "29 harvests are not 30");
            assertEquals(2, MASTERY.tier(Rarity.COMMON, new MasteryEngine.Facts(500, 1, 4, 7)), "volume alone never passes tier 2: tier 3 asks for a Perfect harvest");
            assertEquals(3, MASTERY.tier(Rarity.COMMON, new MasteryEngine.Facts(30, 2, 1, 2)));
            assertEquals(4, MASTERY.tier(Rarity.COMMON, new MasteryEngine.Facts(75, 2, 3, 2)));
            assertEquals(5, MASTERY.tier(Rarity.COMMON, new MasteryEngine.Facts(150, 2, 4, 5)));
        }

        @Test
        void slowCropsNeedFewerHarvestsButNeverNone() {
            assertEquals(30, MASTERY.harvestsNeeded(Rarity.COMMON, T3));
            assertEquals(18, MASTERY.harvestsNeeded(Rarity.RARE, T3));
            assertEquals(9, MASTERY.harvestsNeeded(Rarity.EPIC, T3));
            assertEquals(3, MASTERY.harvestsNeeded(Rarity.LEGENDARY, T3));
            assertEquals(1, MASTERY.harvestsNeeded(Rarity.LEGENDARY, RULES.mastery().tiers().getFirst()));
            assertEquals(3, MASTERY.tier(Rarity.RARE, new MasteryEngine.Facts(18, 2, 1, 1)));
        }

        @Test
        void theNextTierListsItsRequirements() {
            var next = MASTERY.next(Rarity.COMMON, 2, new MasteryEngine.Facts(12, 1, 1, 1)).orElseThrow();
            assertEquals(3, next.tier());
            assertEquals(List.of("HARVESTS", "QUALITY"), next.requirements().stream().map(MonumentEngine.Requirement::code).toList());
            assertTrue(MASTERY.next(Rarity.COMMON, 5, new MasteryEngine.Facts(999, 3, 4, 7)).isEmpty());
        }
    }

    @Nested
    class Skins {
        @Test
        void theCatalogueShipsEveryUnlockPath() {
            // six V82 cultivars + the one REWARD cultivar of V83 (delivered only by an Echo Reward)
            assertEquals(7, RULES.skins().size());
            assertEquals(1, RULES.skins().values().stream().filter(s -> s.unlockKind().equals("REWARD")).count());
            assertTrue(RULES.skins().values().stream().anyMatch(s -> s.unlockKind().equals("MASTERY")));
            assertTrue(RULES.skins().values().stream().anyMatch(s -> s.unlockKind().equals("COIN")));
            assertTrue(RULES.skins().values().stream().anyMatch(s -> s.unlockKind().equals("LEARNING")));
            // a price exists exactly for the coin path
            RULES.skins().values().forEach(s -> assertEquals(s.unlockKind().equals("COIN"), s.coinPrice() > 0, s.code()));
        }

        @Test
        void eligibilityIsMasteryLearningAndCoins() {
            var amber = RULES.skin("TOMATO_AMBER");
            assertFalse(LIVING.check(amber, 0, 0, 99_999).ok(), "never grown: not for sale yet");
            assertFalse(LIVING.check(amber, 1, 0, 23_999).ok());
            var ok = LIVING.check(amber, 1, 0, 24_000);
            assertTrue(ok.ok());
            assertEquals(24_000, ok.price());
            var dusk = RULES.skin("WHEAT_DUSK");
            assertFalse(LIVING.check(dusk, 3, 999, 999_999).ok(), "an earned skin cannot be bought");
            assertEquals(0, LIVING.check(dusk, 4, 0, 0).price());
            assertTrue(LIVING.check(dusk, 4, 0, 0).ok());
            var gem = RULES.skin("CORN_GEM");
            assertFalse(LIVING.check(gem, 1, 20, 0).ok());
            assertTrue(LIVING.check(gem, 1, 21, 0).ok());
        }
    }

    @Nested
    class Echo {
        static final EchoGuide GUIDE = new EchoGuide();

        static EchoGuide.Facts facts(Integer grad, Long pest, int ready, Long order, int unseen, String claim, long due,
                                     boolean learned, String branch) {
            return new EchoGuide.Facts(grad, pest, pest == null ? 0 : 1, ready, order, order == null ? 0 : 1, unseen, claim, due,
                    learned, branch, 2, 1);
        }

        @Test
        void exactlyOneHintByFixedPriority() {
            assertEquals("GRADUATE", GUIDE.pick(facts(2, 7L, 3, 9L, 1, "WHEAT_DUSK", 12, false, "VOCABULARY")).code());
            assertEquals("RESCUE", GUIDE.pick(facts(null, 7L, 3, 9L, 1, "WHEAT_DUSK", 12, false, "VOCABULARY")).code());
            assertEquals("HARVEST", GUIDE.pick(facts(null, null, 3, 9L, 1, "WHEAT_DUSK", 12, false, "VOCABULARY")).code());
            assertEquals("DELIVER", GUIDE.pick(facts(null, null, 0, 9L, 1, "WHEAT_DUSK", 12, false, "VOCABULARY")).code());
            assertEquals("MILESTONE", GUIDE.pick(facts(null, null, 0, null, 1, "WHEAT_DUSK", 12, false, "VOCABULARY")).code());
            assertEquals("CLAIM_SKIN", GUIDE.pick(facts(null, null, 0, null, 0, "WHEAT_DUSK", 12, false, "VOCABULARY")).code());
            assertEquals("REVIEW_DUE", GUIDE.pick(facts(null, null, 0, null, 0, null, 12, false, "VOCABULARY")).code());
            assertEquals("BRANCH", GUIDE.pick(facts(null, null, 0, null, 0, null, 0, false, "LISTENING")).code());
            assertEquals("IDLE", GUIDE.pick(facts(null, null, 0, null, 0, null, 0, false, null)).code());
        }

        @Test
        void echoNeverNagsALearnerWhoAlreadyStudiedTodayAndCarriesOnlyFacts() {
            assertEquals("IDLE", GUIDE.pick(facts(null, null, 0, null, 0, null, 30, true, "VOCABULARY")).code(),
                    "today is already a verified learning day: no more study nudges");
            var hint = GUIDE.pick(facts(null, 7L, 0, null, 0, null, 0, false, null));
            assertEquals(7L, hint.params().get("pestId"));
            assertEquals(Map.of("due", 12L), GUIDE.pick(facts(null, null, 0, null, 0, null, 12, false, null)).params());
        }
    }

    @Nested
    class Simulation {
        static final ProgressionSimulator SIM = new ProgressionSimulator(RULES, 14, 3);

        static ProgressionSimulator.Result run(String code, int days) {
            return SIM.run(ProgressionSimulator.personas().stream().filter(p -> p.code().equals(code)).findFirst().orElseThrow(), days);
        }

        @Test
        void noLearningEvidenceMeansNoProgress() {
            var farm = run("L0", 365);
            assertEquals(0, farm.at(365).learningDays());
            assertEquals(0, farm.at(365).era());
            assertEquals(-1, farm.firstOrnamentDay());
        }

        @Test
        void aNormalLearnerSeesProgressInTheFirstWeekAndAnEraWithinAMonth() {
            var normal = run("L2", 365);
            assertTrue(normal.firstOrnamentDay() > 0 && normal.firstOrnamentDay() <= 7, "first ornament day " + normal.firstOrnamentDay());
            assertTrue(normal.dayReachingEra(1) >= 21 && normal.dayReachingEra(1) <= 35, "era 1 day " + normal.dayReachingEra(1));
            assertTrue(normal.dayReachingEra(2) > normal.dayReachingEra(1));
        }

        @Test
        void repeatingTheSameWordsOrTheMinimumNeverUnlocksTheLaterEras() {
            var exploit = run("L7", 730);
            assertEquals(730, exploit.at(730).learningDays(), "at most one verified day per calendar day");
            assertEquals(1, exploit.at(730).graduations(), "the same five words are credited once");
            assertTrue(exploit.at(730).forest() > 20, "the trees still join the forest: history is kept, credit is not minted");
            assertEquals(1, exploit.at(730).era());
        }

        @Test
        void progressIsNeverLostDuringAnAbsence() {
            var returner = run("L5", 365);
            for (int d = 2; d <= 365; d++) {
                var a = returner.at(d - 1);
                var b = returner.at(d);
                assertTrue(b.era() >= a.era() && b.learningDays() >= a.learningDays() && b.graduations() >= a.graduations()
                        && b.branchTiers() >= a.branchTiers(), "day " + d);
            }
            assertEquals(returner.at(21).learningDays(), returner.at(81).learningDays(), "sixty days away add nothing and take nothing");
            assertEquals(returner.at(21).era(), returner.at(81).era());
        }

        @Test
        void theActiveLearnerReachesTheFinalEraAndKeepsGoing() {
            var active = run("L3", 730);
            int final4 = active.dayReachingEra(4);
            assertTrue(final4 >= 365 && final4 <= 420, "era 4 day " + final4);
            assertTrue(active.at(730).rings() >= 3, "rings continue after the final era");
            assertTrue(active.at(730).branchTiers() <= 15);
        }
    }
}
