package com.englishcoach.garden;

import com.englishcoach.garden.domain.ChallengeGenerator;
import com.englishcoach.garden.domain.ChallengeGenerator.Direction;
import com.englishcoach.garden.domain.ChallengeGenerator.Word;
import com.englishcoach.garden.domain.DeterministicRandom;
import com.englishcoach.garden.domain.GardenCalendar;
import com.englishcoach.garden.domain.GardenRules;
import com.englishcoach.garden.domain.GardenRules.Season;
import com.englishcoach.garden.domain.GrowthCalculator;
import com.englishcoach.garden.domain.GrowthCalculator.PlantingFacts;
import com.englishcoach.garden.domain.LevelCurve;
import com.englishcoach.garden.domain.QualityCalculator;
import com.englishcoach.garden.domain.QualityCalculator.Input;
import com.englishcoach.garden.domain.QualityCalculator.SeasonFit;
import com.englishcoach.garden.domain.RewardEngine;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.*;

/** Pure Echo Garden rules (no Spring, no DB, explicit instants instead of the wall clock). */
class GardenDomainTest {

    static final GardenRules RULES = GardenTestRules.seeded();
    static final GardenCalendar CAL = new GardenCalendar(RULES);
    // Phase 1 arithmetic is checked without rain (the weather timeline has its own tests)
    static final GrowthCalculator GROWTH = new GrowthCalculator(GardenTestRules.withoutWeather(RULES));

    static void assertNear(Instant expected, Instant actual) {
        assertNotNull(actual);
        assertTrue(Math.abs(Duration.between(expected, actual).toMillis()) <= 1, expected + " vs " + actual);
    }

    /** Local Asia/Ho_Chi_Minh wall time → instant. */
    static Instant vn(String localDateTime) {
        return ZonedDateTime.parse(localDateTime + "+07:00[Asia/Ho_Chi_Minh]").toInstant();
    }

    @Nested
    class Calendar {
        @Test
        void themeWeeksRotateEveryMondayLocalMidnight() {
            assertEquals(Season.LU_HANH, CAL.theme(vn("2026-10-05T00:00:00")));
            assertEquals(Season.LU_HANH, CAL.theme(vn("2026-10-11T23:59:59")));
            assertEquals(Season.CONG_SO, CAL.theme(vn("2026-10-12T00:00:00")));
            assertEquals(Season.HOC_THUAT, CAL.theme(vn("2026-10-19T08:00:00")));
            assertEquals(Season.THANH_NGU, CAL.theme(vn("2026-10-26T08:00:00")));
            assertEquals(Season.LU_HANH, CAL.theme(vn("2026-11-02T08:00:00")));
            assertEquals(Season.THANH_NGU, CAL.theme(vn("2026-10-04T23:00:00")), "weeks before the epoch wrap backwards");
            assertEquals(vn("2026-10-12T00:00:00"), CAL.themeEndsAt(vn("2026-10-09T15:00:00")));
            assertEquals(vn("2026-10-19T00:00:00"), CAL.themeEndsAt(vn("2026-10-12T00:00:00")));
        }

        @Test
        void dayKeyUsesVietnamTimeNotUtc() {
            // 2026-10-09 17:30 UTC is already 2026-10-10 00:30 in Vietnam
            assertEquals(LocalDate.parse("2026-10-10"), CAL.dayKey(Instant.parse("2026-10-09T17:30:00Z")));
            assertEquals(LocalDate.parse("2026-10-09"), CAL.dayKey(Instant.parse("2026-10-09T16:59:59Z")));
        }

        @Test
        void moonlitWindowIsSevenPmToFiveAm() {
            assertTrue(CAL.moonlit(vn("2026-10-09T19:00:00")));
            assertTrue(CAL.moonlit(vn("2026-10-10T04:59:59")));
            assertFalse(CAL.moonlit(vn("2026-10-10T05:00:00")));
            assertFalse(CAL.moonlit(vn("2026-10-09T18:59:59")));
        }
    }

    @Nested
    class Growth {
        final Instant t0 = vn("2026-10-09T10:00:00");
        final PlantingFacts wheat = new PlantingFacts(t0, 1200, 0, Season.ALL);

        @Test
        void stagesFollowProgressAndReadinessIsExact() {
            assertEquals(1, GROWTH.evaluate(wheat, t0).stage());
            assertEquals(1, GROWTH.evaluate(wheat, t0.plusSeconds(119)).stage());
            assertEquals(2, GROWTH.evaluate(wheat, t0.plusSeconds(120)).stage());
            assertEquals(3, GROWTH.evaluate(wheat, t0.plusSeconds(540)).stage());
            var before = GROWTH.evaluate(wheat, t0.plusMillis(1_199_999));
            assertFalse(before.ready());
            assertEquals(t0.plusSeconds(1200), before.readyAt(), "estimate for a growing crop");
            var at = GROWTH.evaluate(wheat, t0.plusSeconds(1200));
            assertTrue(at.ready());
            assertEquals(4, at.stage());
            assertEquals(t0.plusSeconds(1200), at.readyAt());
        }

        @Test
        void repeatedReadsAreStableAndClientClockIsIrrelevant() {
            Instant now = t0.plusSeconds(600);
            assertEquals(GROWTH.evaluate(wheat, now), GROWTH.evaluate(wheat, now));
            // a skewed clock "before planting" never produces negative growth
            var skew = GROWTH.evaluate(wheat, t0.minusSeconds(300));
            assertEquals(0, skew.progressSeconds());
            assertFalse(skew.ready());
        }

        @Test
        void careReducesRequiredWorkRetroactivelyAndIsCapped() {
            var cared = new PlantingFacts(t0, 1200, 0.04 * 3 + 0.10, Season.ALL);
            assertEquals(1200 * 0.78, GROWTH.requiredSeconds(cared), 1e-9);
            assertNear(t0.plusSeconds(936), GROWTH.evaluate(cared, t0).readyAt());
            var overCap = new PlantingFacts(t0, 1200, 0.9, Season.ALL);
            assertEquals(1200 * 0.60, GROWTH.requiredSeconds(overCap), 1e-9);
            // watering a crop that already has enough progress makes it ready at the earlier crossing
            var late = new PlantingFacts(t0, 1200, 0.04, Season.ALL);
            var snap = GROWTH.evaluate(late, t0.plusSeconds(1170));
            assertTrue(snap.ready());
            assertNear(t0.plusSeconds(1152), snap.readyAt());
        }

        @Test
        void seasonFactorsApplyPerSegment() {
            // Strawberry (Lữ Hành) in its week: 7200 s of work at ×1.25
            var in = new PlantingFacts(vn("2026-10-06T08:00:00"), 7200, 0, Season.LU_HANH);
            assertEquals(vn("2026-10-06T08:00:00").plusSeconds(5760), GROWTH.evaluate(in, vn("2026-10-06T08:00:00")).readyAt());
            // Watermelon (Công Sở) planted off season: ×0.70
            var off = new PlantingFacts(vn("2026-10-06T08:00:00"), 18000, 0, Season.CONG_SO);
            assertEquals(18000 / 0.70, Duration.between(off.plantedAt(), GROWTH.evaluate(off, off.plantedAt()).readyAt()).toMillis() / 1000.0, 0.01);
        }

        @Test
        void crossingAThemeBoundaryIntegratesBothSegments() {
            // planted Sunday 23:00 in Lữ Hành week: 1 h at ×1.25 = 4500 s of work, the rest at ×0.70 from Monday
            Instant plant = vn("2026-10-11T23:00:00");
            var s = new PlantingFacts(plant, 7200, 0, Season.LU_HANH);
            Instant expected = vn("2026-10-12T00:00:00").plusNanos((long) Math.ceil(2700 / 0.70 * 1e9));
            assertEquals(expected, GROWTH.evaluate(s, plant).readyAt());
            var mid = GROWTH.evaluate(s, vn("2026-10-12T00:30:00"));
            assertEquals(4500 + 1800 * 0.70, mid.progressSeconds(), 1e-6);
            assertFalse(mid.ready());
            // a naive "latest multiplier × elapsed" would claim 5400 × 0.70 = 3780 s instead
            assertNotEquals(5400 * 0.70, mid.progressSeconds(), 1.0);
            assertTrue(GROWTH.evaluate(s, expected).ready());
        }
    }

    @Nested
    class Quality {
        final QualityCalculator q = new QualityCalculator(RULES);

        @Test
        void componentsAndTiers() {
            var golden = q.score(new Input(3, false, true, SeasonFit.IN_SEASON, true, true));
            assertEquals(100, golden.total());
            assertEquals("GOLDEN", golden.tier().code());
            var commonMax = q.score(new Input(3, false, true, SeasonFit.ALL_SEASON, true, true));
            assertEquals(90, commonMax.total());
            assertEquals("PERFECT", commonMax.tier().code(), "Common crops top out at Perfect");
            var skipped = q.score(new Input(3, true, true, SeasonFit.ALL_SEASON, false, true));
            assertEquals(0, skipped.recall());
            assertEquals(45, skipped.total());
            assertEquals("NORMAL", skipped.tier().code());
            assertEquals(0, q.score(new Input(0, false, true, SeasonFit.OFF_SEASON, false, false)).season());
        }

        @Test
        void tierBoundaries() {
            var tiers = RULES.quality();
            assertEquals("NORMAL", tiers.tierFor(49).code());
            assertEquals("GOOD", tiers.tierFor(50).code());
            assertEquals("GOOD", tiers.tierFor(74).code());
            assertEquals("PERFECT", tiers.tierFor(75).code());
            assertEquals("PERFECT", tiers.tierFor(94).code());
            assertEquals("GOLDEN", tiers.tierFor(95).code());
        }

        @Test
        void freshnessWindowIsMaxOfTwoHoursAndHalfTheBaseTime() {
            Instant ready = vn("2026-10-09T10:00:00");
            assertTrue(q.fresh(1200, ready, ready.plus(Duration.ofHours(2))));
            assertFalse(q.fresh(1200, ready, ready.plus(Duration.ofHours(2)).plusSeconds(1)));
            assertTrue(q.fresh(21600, ready, ready.plus(Duration.ofHours(3))), "pumpkin: 50 % of 6 h = 3 h");
            assertFalse(q.fresh(21600, ready, ready.plus(Duration.ofHours(3)).plusSeconds(1)));
        }

        @Test
        void seasonFitUsesPlantingOrHarvestWeek() {
            var strawberry = RULES.crop("STRAWBERRY");
            assertEquals(SeasonFit.IN_SEASON, q.seasonFit(strawberry, vn("2026-10-11T22:00:00"), vn("2026-10-12T02:00:00")));
            assertEquals(SeasonFit.OFF_SEASON, q.seasonFit(strawberry, vn("2026-10-13T08:00:00"), vn("2026-10-13T12:00:00")));
            assertEquals(SeasonFit.ALL_SEASON, q.seasonFit(RULES.crop("WHEAT"), vn("2026-10-13T08:00:00"), vn("2026-10-13T12:00:00")));
        }

        @Test
        void sellPriceAndXpRoundDown() {
            var wheat = RULES.crop("WHEAT");
            assertEquals(15, q.unitSellPrice(wheat, RULES.quality().tier("NORMAL"), false));
            assertEquals(17, q.unitSellPrice(wheat, RULES.quality().tier("GOOD"), false));
            assertEquals(30, q.unitSellPrice(wheat, RULES.quality().tier("PERFECT"), true));
            assertEquals(31, q.harvestXp(RULES.crop("ROSE"), RULES.quality().tier("PERFECT")));
            assertEquals(4, q.harvestXp(wheat, RULES.quality().tier("NORMAL")));
        }

        @Test
        void mutationIsDeterministicAndNearThreePercent() {
            assertEquals(q.mutated(42), q.mutated(42));
            long hits = IntStream.range(0, 20_000).filter(i -> q.mutated(i)).count();
            assertEquals(0.03, hits / 20_000.0, 0.006);
            assertEquals(DeterministicRandom.unit("x"), DeterministicRandom.unit("x"));
        }
    }

    @Nested
    class Rewards {
        final RewardEngine r = new RewardEngine(RULES);

        RewardEngine.DayStats review(int n, List<Integer> water, List<Integer> xp) {
            var s = RewardEngine.DayStats.empty();
            for (int i = 0; i < n; i++) {
                var d = r.applyReview(s, true);
                water.add(d.water());
                xp.add(d.xp());
                s = d.after();
            }
            return s;
        }

        @Test
        void diminishingScheduleWaterCarryAndXp() {
            var water = new ArrayList<Integer>();
            var xp = new ArrayList<Integer>();
            var s20 = review(20, water, xp);
            assertEquals(20, s20.effectiveUnits(), 1e-9);
            assertEquals(4, water.stream().mapToInt(Integer::intValue).sum());
            assertEquals(40, xp.stream().mapToInt(Integer::intValue).sum());
            water.clear();
            xp.clear();
            var s60 = review(60, water, xp);
            assertEquals(20 + 14 + 6, s60.effectiveUnits(), 1e-9);
            assertEquals(8, water.stream().mapToInt(Integer::intValue).sum());
            assertEquals(80, xp.stream().mapToInt(Integer::intValue).sum());
            assertEquals(0, s60.waterCarry(), 1e-9);
        }

        @Test
        void repeatsOfTheSameCardThatDayEarnNothing() {
            var d = r.applyReview(new RewardEngine.DayStats(3, 3, 3, 3), false);
            assertEquals(0, d.rawUnits());
            assertEquals(0, d.water());
            assertEquals(0, d.xp());
            assertEquals(4, d.after().reviews(), "still counted as a review for the due-queue goal");
        }

        @Test
        void dailyGoal() {
            assertTrue(r.goalReached(new RewardEngine.DayStats(20, 20, 0, 20), 9));
            assertFalse(r.goalReached(new RewardEngine.DayStats(19, 19, 0, 19), 9));
            assertTrue(r.goalReached(new RewardEngine.DayStats(5, 5, 0, 5), 0));
            assertFalse(r.goalReached(new RewardEngine.DayStats(4, 4, 0, 4), 0));
        }
    }

    @Nested
    class Levels {
        final LevelCurve l = new LevelCurve(RULES);

        @Test
        void matchesTheDocumentedMilestones() {
            assertEquals(50, l.xpToNext(1));
            assertEquals(620, l.totalXpForLevel(5));
            assertEquals(3835, l.totalXpForLevel(10));
            assertEquals(23288, l.totalXpForLevel(20));
            assertEquals(66430, l.totalXpForLevel(30));
            assertEquals(247469, l.totalXpForLevel(50));
            assertEquals(4, l.level(619));
            assertEquals(5, l.level(620));
            assertEquals(1, l.level(0));
        }

        @Test
        void unlocks() {
            assertEquals(List.of("CORN"), l.unlocksAt(2).stream().map(GardenRules.CropDef::code).toList());
            assertEquals("CORN", l.nextUnlock(1).orElseThrow().code());
            assertEquals("ROSE", l.nextUnlock(3).orElseThrow().code());
            assertTrue(l.nextUnlock(12).isEmpty(), "Frost Lily (12) is the last level unlock; the orchid needs a graduation seed");
        }
    }

    @Nested
    class Challenges {
        final ChallengeGenerator g = new ChallengeGenerator(RULES);
        final List<Word> own = List.of(new Word(1L, "agree", "Đồng ý, tán thành", "/əˈɡriː/"),
                new Word(2L, "arrive", "Đến, tới nơi", "/əˈraɪv/"), new Word(3L, "boat", "Tàu thuyền", "/bəʊt/"),
                new Word(4L, "camera", "Máy ảnh, máy chụp hình", "/ˈkæmrə/"));
        final List<Word> pool = List.of(new Word(null, "breakfast", "Bữa ăn sáng", null),
                new Word(null, "river", "Dòng sông", null), new Word(null, "window", "Cửa sổ", null),
                new Word(null, "teacher", "Giáo viên", null), new Word(null, "garden", "Khu vườn", null));

        @Test
        void threeQuestionsTwoForwardOneReverseWithDistinctOptions() {
            var qs = g.generate(List.of(own), pool, "c-1");
            assertEquals(3, qs.size());
            assertEquals(List.of(Direction.EN_VI, Direction.EN_VI, Direction.VI_EN), qs.stream().map(ChallengeGenerator.Question::direction).toList());
            for (var q : qs) {
                assertEquals(4, q.options().size());
                assertEquals(4, new HashSet<>(q.options()).size());
                assertTrue(q.answer() >= 0 && q.answer() < 4);
                String expected = q.direction() == Direction.EN_VI
                        ? ChallengeGenerator.shortMeaning(own.stream().filter(w -> w.word().equals(q.word())).findFirst().orElseThrow().meaningVi())
                        : q.word();
                assertEquals(expected, q.options().get(q.answer()));
                assertNotNull(q.cardId(), "own cards are preferred over the system pool");
            }
        }

        @Test
        void deterministicPerSeed() {
            assertEquals(g.generate(List.of(own), pool, "same"), g.generate(List.of(own), pool, "same"));
            var other = IntStream.range(0, 10).mapToObj(i -> g.generate(List.of(own), pool, "seed-" + i)).distinct().count();
            assertTrue(other > 1);
        }

        @Test
        void fallsBackToTheSystemPoolForNewLearners() {
            var qs = g.generate(List.of(List.of(), pool), pool, "new");
            assertEquals(3, qs.size());
            assertTrue(qs.stream().allMatch(q -> q.cardId() == null));
        }

        @Test
        void shortMeaningTakesTheFirstSense() {
            assertEquals("Đồng ý", ChallengeGenerator.shortMeaning("Đồng ý, tán thành, bằng lòng"));
            assertEquals("Máy ảnh", ChallengeGenerator.shortMeaning("máy ảnh (thiết bị); máy chụp hình"));
            assertEquals("", ChallengeGenerator.shortMeaning(null));
        }
    }
}
