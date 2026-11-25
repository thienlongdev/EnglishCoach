package com.englishcoach.garden;

import com.englishcoach.garden.domain.EchoGuide;
import com.englishcoach.garden.domain.EstateEngine;
import com.englishcoach.garden.domain.EstateEngine.Perks;
import com.englishcoach.garden.domain.EstateEngine.PestStage;
import com.englishcoach.garden.domain.EstateRules;
import com.englishcoach.garden.domain.GardenRules;
import com.englishcoach.garden.domain.GardenRules.Season;
import com.englishcoach.garden.domain.GrowthCalculator;
import com.englishcoach.garden.domain.GrowthCalculator.PlantingFacts;
import com.englishcoach.garden.domain.MarketEngine;
import com.englishcoach.garden.domain.PestPlanner.Host;
import com.englishcoach.garden.domain.PestPlanner.PestFacts;
import com.englishcoach.garden.domain.QualityCalculator;
import com.englishcoach.garden.domain.WeatherCalendar;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3C pure rules on the V83 seed fixture: building perks, the market stall as a building shows it, farmland
 * regions (gates, order, learning discount, cells), staged Forgotten Pest damage (warning, leaf damage, wilting, bounds,
 * review, care, long absence) and the contribution caps.
 */
class GardenPhase3CDomainTest {

    static final GardenRules RULES = GardenTestRules.withoutWeather(GardenTestRules.seeded());
    static final EstateRules ESTATE = GardenTestRules.estate();
    static final EstateEngine ENGINE = new EstateEngine(ESTATE);
    static final Instant T0 = Instant.parse("2026-10-09T03:00:00Z");

    static PestFacts pest(Instant spawned, Instant reviewed) {
        return new PestFacts(1, 7, Host.CROP, 3L, null, spawned, reviewed, null);
    }

    // ================================================================================ buildings

    @Nested
    class Buildings {

        @Test
        void aGardenWithoutBuildingsHasNoPerkAndEveryLevelIsBounded() {
            assertEquals(Perks.NONE, ENGINE.perks(Map.of()));
            Perks top = ENGINE.perks(Map.of("COTTAGE", 3, "WAREHOUSE", 3, "MARKET", 3));
            assertEquals(new Perks(1.0, 3, 6, 2, 2, 2, 1), top);
            // a level beyond the catalogue (corrupt data) can never give more than the top level
            assertEquals(top, ENGINE.perks(Map.of("COTTAGE", 9, "WAREHOUSE", 9, "MARKET", 9)));
            assertEquals(new Perks(0.25, 1, 0, 0, 0, 0, 0), ENGINE.perks(Map.of("COTTAGE", 1)));
            assertEquals(new Perks(0, 0, 4, 1, 0, 0, 0), ENGINE.perks(Map.of("WAREHOUSE", 2)));
        }

        @Test
        void levelsAreBoughtInOrderAndCostMoreEachTime() {
            for (var b : ESTATE.buildings().values()) {
                assertEquals(3, b.maxLevel());
                long previous = 0;
                int previousLevel = 0;
                for (var l : b.levels()) {
                    assertTrue(l.coins() > previous, b.code() + " level " + l.level() + " costs more than the one before");
                    assertTrue(l.minLevel() > previousLevel);
                    assertFalse(l.materials().isEmpty(), "every level also consumes produce");
                    l.materials().keySet().forEach(c -> assertFalse(RULES.crop(c).qaOnly()));
                    previous = l.coins();
                    previousLevel = l.minLevel();
                }
                assertEquals(1, ENGINE.nextLevel(b.code(), 0).orElseThrow().level());
                assertTrue(ENGINE.nextLevel(b.code(), 3).isEmpty(), "nothing after the top level");
            }
            assertTrue(ENGINE.nextLevel("UNKNOWN", 0).isEmpty());
        }

        @Test
        void aHigherStallShowsMoreOfTheSameRankingAndNeverChangesAPrice() {
            var market = new MarketEngine(RULES, GardenTestRules.economy());
            LocalDate day = LocalDate.parse("2026-10-09");
            var base = market.offers(day);
            var top = market.offers(day, ENGINE.perks(Map.of("MARKET", 3)));
            assertEquals(base.size() + 2, top.size(), "two more featured packs at level 3");
            for (int i = 0; i < base.size(); i++) {
                assertEquals(base.get(i).code(), top.get(i).code(), "the day's ranking is unchanged");
                assertEquals(base.get(i).price(), top.get(i).price(), "no price is ever changed");
                assertEquals(base.get(i).unitQty(), top.get(i).unitQty());
                assertTrue(top.get(i).dailyCap() >= base.get(i).dailyCap() && top.get(i).dailyCap() <= base.get(i).dailyCap() + 2,
                        "caps rise by a bounded step");
            }
            assertTrue(top.stream().noneMatch(o -> "WATER".equals(o.item())), "water is never sold, whatever the stall level");
            assertEquals(base, market.offers(day, Perks.NONE));
        }

        @Test
        void theCottageKeepsCropsFreshLongerAndTheAlmanacNeverRevealsARainbow() {
            var q = new QualityCalculator(RULES);
            Instant ready = T0;
            assertTrue(q.fresh(1200, ready, ready.plus(Duration.ofHours(2)), 0));
            assertFalse(q.fresh(1200, ready, ready.plus(Duration.ofHours(3)), 0));
            assertTrue(q.fresh(1200, ready, ready.plus(Duration.ofHours(3)), 0.5), "+50 %: 2 h becomes 3 h");
            assertTrue(q.fresh(1200, ready, ready.plus(Duration.ofHours(4)), 1.0));
            assertFalse(q.fresh(1200, ready, ready.plus(Duration.ofHours(4)).plusSeconds(1), 1.0), "bounded: never more than twice");
            assertEquals(q.fresh(1200, ready, ready.plus(Duration.ofHours(2))), q.fresh(1200, ready, ready.plus(Duration.ofHours(2)), -3),
                    "a negative bonus is ignored");
            var weather = new WeatherCalendar(GardenTestRules.seeded());
            for (int d = 0; d < 60; d++) {
                Instant now = T0.plus(Duration.ofHours(d * 7L));
                var base = weather.forecast(now);
                var more = weather.forecast(now, 3);
                assertEquals(base.size() + 3, more.size());
                assertEquals(base, more.subList(0, base.size()), "the base forecast is a prefix");
                assertTrue(more.stream().skip(1).noneMatch(w -> w.weather() == WeatherCalendar.Weather.RAINBOW),
                        "a coming rainbow is never revealed");
            }
        }
    }

    // ================================================================================ land

    @Nested
    class Land {

        @Test
        void regionsUseDistinctReservedCellsBeyondTheFirstTenBedsAndStayBounded() {
            Set<String> taken = new HashSet<>();
            RULES.starter().plots().forEach(c -> taken.add(c.x() + "," + c.y()));
            GardenTestRules.economy().expansion().plots().forEach(p -> taken.add(p.gx() + "," + p.gy()));
            Set<Integer> slots = new HashSet<>();
            int beds = 0;
            for (var r : ESTATE.land().regions()) {
                int previous = 0;
                for (var p : r.plots()) {
                    assertTrue(taken.add(p.gx() + "," + p.gy()), "cell " + p.gx() + "," + p.gy() + " is used once");
                    assertTrue(slots.add(p.slot()) && p.slot() > 10, "slots continue after the V80 beds");
                    assertTrue(p.slot() > previous, "beds of a region are ordered");
                    assertTrue(p.gx() >= 4 && p.gx() <= 12 && p.gy() >= 16 && p.gy() <= 23, "inside the fenced farm");
                    assertFalse(p.materials().isEmpty());
                    previous = p.slot();
                    beds++;
                }
            }
            assertEquals(14, beds);
            assertEquals(24, ESTATE.land().maxPlots(), "6 starter + 4 expansion + 14 regional beds: the bound the scene is built for");
            assertEquals(10 + beds, ESTATE.land().maxPlots());
        }

        @Test
        void aRegionOpensOnFarmFactsOnlyAndItsBedsAreBoughtInOrder() {
            var west = ESTATE.land().regions().getFirst();
            assertFalse(ENGINE.gate(west, 11, 10, 10, 150).open(), "farm level");
            assertFalse(ENGINE.gate(west, 12, 9, 10, 150).open(), "the ten earlier beds");
            assertFalse(ENGINE.gate(west, 12, 10, 9, 150).open(), "delivered orders");
            assertFalse(ENGINE.gate(west, 12, 10, 10, 149).open(), "closed harvests");
            assertTrue(ENGINE.gate(west, 12, 10, 10, 150).open(), "no learning fact is part of a gate");
            assertEquals(11, ENGINE.nextPlot(west, Set.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)).orElseThrow().slot());
            assertEquals(13, ENGINE.nextPlot(west, Set.of(11, 12)).orElseThrow().slot());
            assertTrue(ENGINE.nextPlot(west, Set.of(11, 12, 13, 14)).isEmpty());
            // gates rise from region to region
            int level = 0;
            for (var r : ESTATE.land().regions()) {
                assertTrue(r.gate().level() > level);
                level = r.gate().level();
            }
        }

        @Test
        void learningLowersThePriceButIsNeverRequired() {
            var plot = ESTATE.land().plot(11).orElseThrow();
            assertEquals(90_000, ENGINE.landPrice(plot, 0), "a farm-only player pays the listed price and can still buy");
            assertEquals(90_000, ENGINE.landPrice(plot, 20));
            assertEquals(85_500, ENGINE.landPrice(plot, 21));
            assertEquals(81_000, ENGINE.landPrice(plot, 75));
            assertEquals(76_500, ENGINE.landPrice(plot, 180));
            assertEquals(72_000, ENGINE.landPrice(plot, 365));
            assertEquals(72_000, ENGINE.landPrice(plot, 5000), "the discount is capped at its last row");
            assertEquals(0.20, ENGINE.learningDiscount(Integer.MAX_VALUE), 1e-9);
            for (var r : ESTATE.land().regions()) {
                for (var p : r.plots()) assertTrue(ENGINE.landPrice(p, 365) > 0);
            }
        }
    }

    // ================================================================================ pests

    @Nested
    class Pests {

        @Test
        void damageProgressesFromAWarningToLeafDamageToWiltingAndAReviewResolvesIt() {
            var p = pest(T0, null);
            assertEquals(PestStage.WARNING, ENGINE.stage(p, T0));
            assertEquals(PestStage.WARNING, ENGINE.stage(p, T0.plus(Duration.ofHours(6)).minusSeconds(1)));
            assertEquals(PestStage.LEAF, ENGINE.stage(p, T0.plus(Duration.ofHours(6))));
            assertEquals(PestStage.LEAF, ENGINE.stage(p, T0.plus(Duration.ofHours(24)).minusSeconds(1)));
            assertEquals(PestStage.WILT, ENGINE.stage(p, T0.plus(Duration.ofHours(24))));
            assertEquals(PestStage.WILT, ENGINE.stage(p, T0.plus(Duration.ofDays(400))), "wilting is the last stage: nothing worse follows");
            assertEquals(T0.plus(Duration.ofHours(6)), ENGINE.nextStageAt(p, T0));
            assertEquals(T0.plus(Duration.ofHours(24)), ENGINE.nextStageAt(p, T0.plus(Duration.ofHours(7))));
            assertNull(ENGINE.nextStageAt(p, T0.plus(Duration.ofHours(30))));
            var reviewed = pest(T0, T0.plus(Duration.ofHours(30)));
            assertEquals(PestStage.RESOLVED, ENGINE.stage(reviewed, T0.plus(Duration.ofDays(3))), "the review resolves any stage");
        }

        @Test
        void aWarningCostsNothingAndTheGrowthPenaltyIsStrictlyBounded() {
            var open = ENGINE.slowdowns(List.of(pest(T0, null)), List.of());
            assertEquals(2, open.size());
            assertEquals(T0.plus(Duration.ofHours(6)), open.get(0).start(), "nothing during the warning");
            assertEquals(T0.plus(Duration.ofHours(24)), open.get(0).end());
            assertEquals(0.85, open.get(0).factor(), 1e-9);
            assertEquals(T0.plus(Duration.ofHours(24)), open.get(1).start());
            assertEquals(T0.plus(Duration.ofHours(36)), open.get(1).end(), "the wilting penalty stops by itself");
            assertEquals(0.7, open.get(1).factor(), 1e-9);
            assertEquals(T0.plus(Duration.ofHours(36)), ENGINE.effectEndsAt(pest(T0, null)));
            // the worst case for any crop: 18 h x 0.15 + 12 h x 0.3 = 6.3 hours of growth
            assertEquals(6.3 * 3600, ENGINE.maxGrowthLossSeconds(), 1e-6);
            // a review during the warning: no window at all
            assertTrue(ENGINE.slowdowns(List.of(pest(T0, T0.plus(Duration.ofHours(2)))), List.of()).isEmpty());
            // a review during leaf damage: the slowdown ends at that instant, wilting never starts
            var early = ENGINE.slowdowns(List.of(pest(T0, T0.plus(Duration.ofHours(10)))), List.of());
            assertEquals(1, early.size());
            assertEquals(T0.plus(Duration.ofHours(10)), early.getFirst().end());
            // tree pests never slow a crop
            assertTrue(ENGINE.slowdowns(List.of(new PestFacts(2, 8, Host.TREE, null, 4L, T0, null, null)), List.of()).isEmpty());
        }

        @Test
        void aCropAlwaysRipensAndNeverUnripensWhateverThePestDoes() {
            var growth = new GrowthCalculator(RULES);
            Instant plant = T0;
            Instant spawn = plant.plus(Duration.ofMinutes(40));
            for (int base : new int[]{1200, 5400, 21600, 36000, 64800}) {
                var clean = new PlantingFacts(plant, base, 0, Season.ALL);
                var infested = new PlantingFacts(plant, base, 0, Season.ALL, ENGINE.slowdowns(List.of(pest(spawn, null)), List.of()));
                Instant cleanReady = growth.evaluate(clean, plant.plus(Duration.ofDays(30))).readyAt();
                var after = growth.evaluate(infested, plant.plus(Duration.ofDays(30)));
                assertTrue(after.ready(), "an unreviewed pest never blocks ripening (base " + base + ")");
                long lost = Duration.between(cleanReady, after.readyAt()).getSeconds();
                assertTrue(lost >= 0 && lost <= ENGINE.maxGrowthLossSeconds() / 0.7 + 1, "delay " + lost + " s is bounded");
                // monotonic: once ripe, ripe at every later instant
                boolean ripe = false;
                for (int h = 0; h <= 24 * 20; h++) {
                    boolean now = growth.evaluate(infested, plant.plus(Duration.ofHours(h))).ready();
                    assertFalse(ripe && !now, "a ripe crop never becomes unripe");
                    ripe = now;
                }
                // a review can only help: the reviewed crop ripens no later than the unreviewed one
                var rescued = new PlantingFacts(plant, base, 0, Season.ALL,
                        ENGINE.slowdowns(List.of(pest(spawn, spawn.plus(Duration.ofHours(8)))), List.of()));
                assertFalse(growth.evaluate(rescued, plant.plus(Duration.ofDays(30))).readyAt().isAfter(after.readyAt()));
            }
        }

        @Test
        void caringForTheCropHalvesTheRemainingPenaltyButNeverResolvesThePest() {
            Instant care = T0.plus(Duration.ofHours(12));
            var tended = ENGINE.slowdowns(List.of(pest(T0, null)), List.of(care));
            assertEquals(3, tended.size());
            assertEquals(0.85, tended.get(0).factor(), 1e-9);
            assertEquals(care, tended.get(0).end());
            assertEquals(0.925, tended.get(1).factor(), 1e-9, "leaf damage softened from the care instant");
            assertEquals(0.85, tended.get(2).factor(), 1e-9, "wilting softened too");
            // care given BEFORE the pest appeared does not count
            assertEquals(ENGINE.slowdowns(List.of(pest(T0, null)), List.of()), ENGINE.slowdowns(List.of(pest(T0, null)), List.of(T0.minusSeconds(60))));
            // the pest is still unresolved: the harvest score follows its stage, care or not
            assertEquals(0, ENGINE.harvestPestScore(List.of(pest(T0, null)), T0.plus(Duration.ofHours(30)), 25));
            assertEquals(PestStage.WILT, ENGINE.stage(pest(T0, null), T0.plus(Duration.ofHours(30))));
        }

        @Test
        void theHarvestScoreFollowsTheWorstUnresolvedStageAndAReviewRestoresItFully() {
            assertEquals(25, ENGINE.harvestPestScore(List.of(), T0, 25));
            assertEquals(25, ENGINE.harvestPestScore(List.of(pest(T0, null)), T0.plus(Duration.ofHours(5)), 25), "warning: no penalty");
            assertEquals(10, ENGINE.harvestPestScore(List.of(pest(T0, null)), T0.plus(Duration.ofHours(7)), 25), "leaf damage");
            assertEquals(0, ENGINE.harvestPestScore(List.of(pest(T0, null)), T0.plus(Duration.ofHours(25)), 25), "wilting");
            // reviewed before the harvest, even at the wilting stage: clean
            assertEquals(25, ENGINE.harvestPestScore(List.of(pest(T0, T0.plus(Duration.ofHours(40)))), T0.plus(Duration.ofHours(41)), 25));
            // a review recorded after the harvest instant does not count for that harvest
            assertEquals(0, ENGINE.harvestPestScore(List.of(pest(T0, T0.plus(Duration.ofHours(40)))), T0.plus(Duration.ofHours(30)), 25));
            // quality: the wilting penalty costs at most the pest part, never the whole harvest
            var q = new QualityCalculator(RULES);
            var in = new QualityCalculator.Input(3, false, false, QualityCalculator.SeasonFit.ALL_SEASON, true, true);
            assertEquals(q.score(in, 25).total() - 25, q.score(in, 0).total());
            assertTrue(q.score(in, 0).total() >= 50, "a wilted crop tended and answered well is still Good");
            assertEquals(q.score(in, 25).total(), q.score(in, 999).total(), "bounded above by the clean score");
            assertEquals(q.score(in, 0).total(), q.score(in, -5).total(), "bounded below by zero");
        }

        @Test
        void echoPointsAtTheMostDamagedCropAndStaysSilentForALearnerWithNothingToDo() {
            var guide = new EchoGuide();
            var hint = guide.pick(new EchoGuide.Facts(null, 9L, 2, 3, null, 0, 0, null, 4, false, null, 0, 0, 3));
            assertEquals("RESCUE", hint.code());
            assertEquals(3, hint.params().get("stage"));
            assertEquals(2, hint.params().get("count"));
            // the Phase 3B shape still works and carries no stage
            assertFalse(guide.pick(new EchoGuide.Facts(null, 9L, 1, 0, null, 0, 0, null, 0, false, null, 0, 0)).params().containsKey("stage"));
            assertEquals("IDLE", guide.pick(new EchoGuide.Facts(null, null, 0, 0, null, 0, 0, null, 0, true, null, 0, 0, 0)).code());
        }
    }

    // ================================================================================ contribution

    @Nested
    class Contribution {

        @Test
        void repeatableSourcesAreCutByTheDayWeekAndMonthCaps() {
            assertEquals(10, ENGINE.nominal("LEARNING_DAY", 1));
            assertEquals(10, ENGINE.granted("LEARNING_DAY", 10, 0, 0, 0));
            assertEquals(5, ENGINE.granted("LEARNING_DAY", 10, 55, 55, 55), "the day cap leaves 5");
            assertEquals(0, ENGINE.granted("LEARNING_DAY", 10, 60, 60, 60));
            assertEquals(3, ENGINE.granted("GRADUATION", 40, 0, 197, 300), "the week cap leaves 3");
            assertEquals(0, ENGINE.granted("GRADUATION", 40, 0, 100, 600), "the month cap is full");
            assertEquals(0, ENGINE.granted("WEEKLY_ORDER", 15, 70, 70, 70), "over a cap never goes negative");
            assertEquals(0, ENGINE.granted("UNKNOWN", 500, 0, 0, 0), "an unknown source is worth nothing");
            assertEquals(0, ENGINE.granted("LEARNING_DAY", -10, 0, 0, 0));
        }

        @Test
        void milestonesAreOneTimeFiniteAndNotCapped() {
            assertEquals(100, ENGINE.nominal("ERA", 1));
            assertEquals(400, ENGINE.nominal("ERA", 4));
            assertEquals(400, ENGINE.nominal("ERA", 9), "a tier beyond the list takes the last value");
            assertEquals(400, ENGINE.granted("ERA", 400, 60, 200, 600), "caps do not cut a milestone");
            assertEquals(0, ENGINE.nominal("MASTERY", 1), "the first mastery tiers are worth nothing");
            assertEquals(50, ENGINE.nominal("MASTERY", 5));
            // the whole one-time pool is finite: eras + five branches + lanterns
            int pool = 100 + 200 + 300 + 400 + 5 * (10 + 30 + 60) + (20 + 40 + 80);
            assertEquals(1640, pool);
            var c = ESTATE.contribution();
            assertTrue(c.dayCap() <= c.weekCap() && c.weekCap() <= c.monthCap());
            assertTrue(c.sources().values().stream().filter(EstateRules.Source::capped).allMatch(s -> s.pointsFor(1) <= c.dayCap()),
                    "no single repeatable fact exceeds a day");
        }
    }
}
