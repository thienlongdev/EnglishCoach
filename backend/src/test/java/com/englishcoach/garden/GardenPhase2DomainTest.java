package com.englishcoach.garden;

import com.englishcoach.garden.domain.ChallengeGenerator;
import com.englishcoach.garden.domain.ChallengeGenerator.Direction;
import com.englishcoach.garden.domain.ChallengeGenerator.Word;
import com.englishcoach.garden.domain.GardenCalendar;
import com.englishcoach.garden.domain.GardenRules;
import com.englishcoach.garden.domain.GardenRules.Season;
import com.englishcoach.garden.domain.GrowthCalculator;
import com.englishcoach.garden.domain.GrowthCalculator.PlantingFacts;
import com.englishcoach.garden.domain.GrowthCalculator.Slowdown;
import com.englishcoach.garden.domain.KnowledgeEvaluator;
import com.englishcoach.garden.domain.KnowledgeEvaluator.CardFacts;
import com.englishcoach.garden.domain.KnowledgeEvaluator.Health;
import com.englishcoach.garden.domain.PestPlanner;
import com.englishcoach.garden.domain.PestPlanner.CropHost;
import com.englishcoach.garden.domain.PestPlanner.Host;
import com.englishcoach.garden.domain.PestPlanner.OverdueCard;
import com.englishcoach.garden.domain.PestPlanner.PestFacts;
import com.englishcoach.garden.domain.QualityCalculator;
import com.englishcoach.garden.domain.RewardEngine;
import com.englishcoach.garden.domain.WeatherCalendar;
import com.englishcoach.garden.domain.WeatherCalendar.Weather;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.LongStream;

import static org.junit.jupiter.api.Assertions.*;

/** Phase 2 pure rules: seasons, weather, growth integration, Knowledge Trees, essence, pests, learning credits. */
class GardenPhase2DomainTest {

    static final GardenRules RULES = GardenTestRules.seeded();
    static final WeatherCalendar WEATHER = new WeatherCalendar(RULES);
    static final GardenCalendar CAL = new GardenCalendar(RULES);

    static Instant vn(String local) {
        return ZonedDateTime.parse(local + "+07:00[Asia/Ho_Chi_Minh]").toInstant();
    }

    /** First window index ≥ {@code from} with the given weather. */
    static long find(Weather w, long from) {
        return LongStream.range(from, from + 2000).filter(i -> WEATHER.weather(i) == w).findFirst().orElseThrow();
    }

    @Nested
    class Seasons {
        @Test
        void fourSeasonCycleIsGlobalAndAlignedToVietnamMondays() {
            assertEquals(Season.LU_HANH, CAL.theme(vn("2026-10-05T00:00:00")));
            assertEquals(Season.CONG_SO, CAL.theme(vn("2026-10-12T00:00:00")));
            assertEquals(Season.HOC_THUAT, CAL.theme(vn("2026-10-19T00:00:00")));
            assertEquals(Season.THANH_NGU, CAL.theme(vn("2026-10-26T00:00:00")));
            assertEquals(Season.LU_HANH, CAL.theme(vn("2026-11-02T00:00:00")), "the cycle repeats every four weeks");
            // Sunday 23:59:59 VN is still the old season even though it is Sunday 16:59 UTC
            assertEquals(Season.LU_HANH, CAL.theme(Instant.parse("2026-10-11T16:59:59Z")));
            assertEquals(Season.CONG_SO, CAL.theme(Instant.parse("2026-10-11T17:00:00Z")));
            // the same instant is the same season for everyone (no per-user state is involved)
            assertEquals(new GardenCalendar(RULES).theme(vn("2026-10-20T09:00:00")), CAL.theme(vn("2026-10-20T09:00:00")));
        }
    }

    @Nested
    class WeatherTimeline {
        @Test
        void windowsAreFourHoursFromVietnamMidnightAndDeterministic() {
            assertEquals(0, WEATHER.index(vn("2026-10-05T00:00:00")));
            assertEquals(0, WEATHER.index(vn("2026-10-05T03:59:59")));
            assertEquals(1, WEATHER.index(vn("2026-10-05T04:00:00")));
            assertEquals(-1, WEATHER.index(vn("2026-10-04T23:59:59")));
            assertEquals(Weather.SUNNY, WEATHER.weather(-5), "before the timeline starts it is always sunny");
            assertEquals(vn("2026-10-09T12:00:00"), WEATHER.windowEnd(vn("2026-10-09T10:30:00")));
            var a = new WeatherCalendar(RULES);
            for (long i = 0; i < 500; i++) assertEquals(a.weather(i), WEATHER.weather(i), "window " + i);
        }

        @Test
        void rainbowsOnlyFollowRainAndChancesFollowTheSeason() {
            for (long i = 1; i < 3000; i++) {
                if (WEATHER.weather(i) == Weather.RAINBOW) assertEquals(Weather.RAIN, WEATHER.weather(i - 1), "window " + i);
            }
            Map<Season, int[]> counts = new EnumMap<>(Season.class);
            for (long i = 0; i < 6 * 7 * 4 * 60; i++) {
                var w = WEATHER.window(i);
                counts.computeIfAbsent(w.season(), k -> new int[2]);
                counts.get(w.season())[0]++;
                if (w.weather() == Weather.RAIN) counts.get(w.season())[1]++;
            }
            counts.forEach((season, c) -> assertEquals(RULES.weather().chances().get(season)[0], c[1] / (double) c[0], 0.03, season.name()));
        }

        @Test
        void forecastRevealsTwelveHoursAndNeverAFutureRainbow() {
            long rainbow = find(Weather.RAINBOW, 10);
            Instant before = WEATHER.windowStart(rainbow - 1).plusSeconds(60);
            var f = WEATHER.forecast(before);
            assertEquals(1 + RULES.weather().forecastWindows(), f.size());
            assertEquals(Weather.RAIN, f.get(0).weather());
            assertEquals(Weather.SUNNY, f.get(1).weather(), "a coming rainbow is shown as clearing sky");
            assertEquals(Weather.RAINBOW, WEATHER.forecast(WEATHER.windowStart(rainbow)).get(0).weather(), "visible once it begins");
            assertEquals(WEATHER.windowStart(rainbow - 1 + 1 + RULES.weather().forecastWindows()), WEATHER.revealedUntil(before));
        }
    }

    @Nested
    class GrowthWithWeatherAndPests {
        final GrowthCalculator growth = new GrowthCalculator(RULES);

        @Test
        void rainSpeedsGrowthOnlyInsideItsWindowAndIsIntegratedPerSegment() {
            long rain = find(Weather.RAIN, 5);
            while (WEATHER.weather(rain + 1) == Weather.RAIN) rain = find(Weather.RAIN, rain + 2);
            Instant start = WEATHER.windowStart(rain);
            Instant mid = start.plus(Duration.ofHours(2));
            Instant plant = start.minus(Duration.ofHours(1));
            boolean sunnyBefore = WEATHER.at(plant) != Weather.RAIN;
            var corn = new PlantingFacts(plant, 5400, 0, Season.ALL);
            var snap = growth.evaluate(corn, mid);
            double expected = (sunnyBefore ? 3600 : 3600 * 1.2) + 7200 * 1.2;
            assertEquals(Math.min(5400, expected), snap.progressSeconds(), 1e-6);
            assertEquals(1.2, growth.speedAt(corn, start.plusSeconds(1)), 1e-9);
            assertEquals(1.0, growth.speedAt(corn, WEATHER.windowStart(rain + 1)), 1e-9, "the rain ends with its window");
            // rain is not watering: the required work is unchanged
            assertEquals(5400, growth.requiredSeconds(corn), 1e-9);
        }

        @Test
        void seasonAndRainMultiplyAndTheEstimateOnlyUsesTheForecast() {
            // a long crop: the estimate beyond the revealed forecast assumes sunshine, so the real ripening is never later
            Instant plant = vn("2026-10-06T08:00:00");
            var orchid = new PlantingFacts(plant, 64800, 0, Season.THANH_NGU);
            var estimate = growth.evaluate(orchid, plant).readyAt();
            Instant real = null;
            for (Instant t = plant; real == null; t = t.plus(Duration.ofMinutes(10))) {
                var s = growth.evaluate(orchid, t);
                if (s.ready()) real = s.readyAt();
            }
            assertFalse(real.isAfter(estimate.plusMillis(1)), "rain can only make a crop ripen earlier than announced");
            var rose = new PlantingFacts(plant, 14400, 0, Season.LU_HANH);
            double s = growth.speedAt(rose, plant);
            double w = WEATHER.at(plant) == Weather.RAIN ? 1.2 : 1.0;
            assertEquals(1.25 * w, s, 1e-9);
        }

        @Test
        void aPestSlowsGrowthUntilTheReviewAndNeverUnripensACrop() {
            var noRain = new GrowthCalculator(GardenTestRules.withoutWeather(RULES));
            Instant plant = vn("2026-10-09T10:00:00");
            Instant pestAt = plant.plus(Duration.ofMinutes(40));
            Instant review = pestAt.plus(Duration.ofMinutes(30));
            var slowed = new PlantingFacts(plant, 5400, 0, Season.ALL, List.of(new Slowdown(pestAt, review, 0.8)));
            var snap = noRain.evaluate(slowed, review.plus(Duration.ofMinutes(15)));
            assertEquals(2400 + 1800 * 0.8 + 900, snap.progressSeconds(), 1e-6);
            // a pest that appears after ripening changes nothing: still ready, same ready instant
            var plain = new PlantingFacts(plant, 1200, 0, Season.ALL);
            Instant ripe = noRain.evaluate(plain, plant.plusSeconds(1200)).readyAt();
            var late = new PlantingFacts(plant, 1200, 0, Season.ALL, List.of(new Slowdown(plant.plusSeconds(1500), null, 0.8)));
            var after = noRain.evaluate(late, plant.plusSeconds(4000));
            assertTrue(after.ready());
            assertEquals(ripe, after.readyAt());
        }
    }

    @Nested
    class KnowledgeTrees {
        final KnowledgeEvaluator k = new KnowledgeEvaluator(RULES);
        final Instant planted = vn("2026-10-01T09:00:00");

        List<CardFacts> cards(int days, String status, boolean overdue) {
            List<CardFacts> out = new ArrayList<>();
            for (int i = 0; i < 5; i++) out.add(new CardFacts(i + 1, "w" + i, "nghĩa", true, status, overdue && i == 0, days, null));
            return out;
        }

        @Test
        void stageIsEvidenceOfDistinctReviewDaysAndAgeNotAFictionalScore() {
            assertEquals(1, k.evaluate(planted, 1, cards(0, "NEW", false), planted, false, null).stage());
            // 5 cards × 1 day = 5 evidence, age ≥ 1 day → stage 2
            assertEquals(2, k.evaluate(planted, 1, cards(1, "LEARNED", false), planted.plus(Duration.ofDays(1)), false, null).stage());
            assertEquals(1, k.evaluate(planted, 1, cards(1, "LEARNED", false), planted.plus(Duration.ofHours(12)), false, null).stage(),
                    "age gate");
            // 5 × 2 = 10 evidence, age 4 → stage 3; 5 × 3 = 15 (≥ 13), every card ≥ 2, age 9 → stage 4
            assertEquals(3, k.evaluate(planted, 1, cards(2, "LEARNED", false), planted.plus(Duration.ofDays(4)), false, null).stage());
            assertEquals(4, k.evaluate(planted, 1, cards(3, "LEARNED", false), planted.plus(Duration.ofDays(9)), false, null).stage());
            // evidence per card is capped: 10 review days of one card do not replace the other four
            List<CardFacts> lopsided = new ArrayList<>(cards(0, "LEARNED", false));
            lopsided.set(0, new CardFacts(1, "w0", "nghĩa", true, "LEARNED", false, 10, null));
            var ev = k.evaluate(planted, 1, lopsided, planted.plus(Duration.ofDays(20)), false, null);
            assertEquals(3, ev.evidence());
            assertEquals(1, ev.stage());
        }

        @Test
        void peakStageNeverDecreasesButHealthShowsNeglect() {
            var ev = k.evaluate(planted, 4, cards(0, "LEARNED", true), planted.plus(Duration.ofDays(20)), false, null);
            assertEquals(4, ev.stage(), "the highest stage reached stays");
            assertEquals(1, ev.computedStage());
            assertEquals(Health.THIRSTY, ev.health());
            List<CardFacts> wilting = new ArrayList<>();
            for (int i = 0; i < 5; i++) wilting.add(new CardFacts(i, "w", "n", true, "LEARNED", i < 3, 3, null));
            assertEquals(Health.WILTING, k.evaluate(planted, 4, wilting, planted.plus(Duration.ofDays(20)), false, null).health());
        }

        @Test
        void graduationNeedsAgeEvidenceStudiedCardsNoOverdueNoPestAndRest() {
            Instant day14 = planted.plus(Duration.ofDays(14));
            var ok = k.evaluate(planted, 4, cards(3, "LEARNED", false), day14, false, null);
            assertTrue(ok.graduationEligible(), ok.blockers().toString());
            assertTrue(k.evaluate(planted, 4, cards(3, "MASTERED", false), day14, false, null).graduationEligible(),
                    "MASTERED cards qualify (they are never due again)");
            assertEquals(List.of("AGE"), k.evaluate(planted, 4, cards(3, "LEARNED", false), day14.minusSeconds(1), false, null).blockers());
            assertTrue(k.evaluate(planted, 4, cards(3, "NEW", false), day14, false, null).blockers().contains("CARD_NEW"));
            assertTrue(k.evaluate(planted, 4, cards(3, "LEARNED", true), day14, false, null).blockers().contains("CARD_OVERDUE"));
            assertTrue(k.evaluate(planted, 4, cards(3, "LEARNED", false), day14, true, null).blockers().contains("PEST"));
            assertTrue(k.evaluate(planted, 4, cards(3, "LEARNED", false), day14, false, day14.plusSeconds(60)).blockers().contains("RETRY_WAIT"));
            assertFalse(k.evaluate(planted, 4, cards(3, "LEARNED", false), day14.plusSeconds(61), false, day14.plusSeconds(60)).blockers().contains("RETRY_WAIT"));
            List<CardFacts> lost = new ArrayList<>(cards(3, "LEARNED", false));
            lost.set(2, new CardFacts(3, "w2", "n", false, null, false, 0, null));
            assertTrue(k.evaluate(planted, 4, lost, day14, false, null).blockers().contains("CARD_LOST"));
            List<CardFacts> thin = new ArrayList<>(cards(3, "LEARNED", false));
            thin.set(4, new CardFacts(5, "w4", "n", true, "LEARNED", false, 1, null));
            assertTrue(k.evaluate(planted, 4, thin, day14, false, null).blockers().contains("CARD_EVIDENCE"));
        }

        @Test
        void essenceAccruesByStageUpToTheStoreAndCarriesFractions() {
            assertEquals(0, k.essencePerDay(1));
            assertEquals(0.5, k.essencePerDay(2));
            assertEquals(1.0, k.essencePerDay(4));
            Instant since = planted;
            assertEquals(1.0, k.essenceAccrued(0, since, 4, since.plus(Duration.ofDays(1))), 1e-9);
            assertEquals(3.0, k.essenceAccrued(0, since, 4, since.plus(Duration.ofDays(30))), 1e-9, "store = 3 days");
            assertEquals(0.0, k.essenceAccrued(0, since, 1, since.plus(Duration.ofDays(30))), 1e-9, "seedlings make none");
            assertEquals(1.25, k.essenceAccrued(0.75, since, 2, since.plus(Duration.ofDays(1))), 1e-9, "banked carries over");
            assertEquals(since.plus(Duration.ofDays(3)), k.essenceFullAt(0, since, 4, since));
            assertNull(k.essenceFullAt(0, since, 4, since.plus(Duration.ofDays(4))));
        }
    }

    @Nested
    class Pests {
        final PestPlanner planner = new PestPlanner(RULES);
        final Instant now = vn("2026-10-09T10:00:00");

        @Test
        void treeCardsBecomeTreePestsAndOthersSettleOnBoundedEligibleCrops() {
            var overdue = List.of(new OverdueCard(1, "agree", 50L), new OverdueCard(2, "arrive", null),
                    new OverdueCard(3, "boat", null), new OverdueCard(4, "camera", null));
            var crops = List.of(new CropHost(10, now.minus(Duration.ofHours(3)), false, false),
                    new CropHost(11, now.minus(Duration.ofMinutes(10)), false, false), // protected (30 min)
                    new CropHost(12, now.minus(Duration.ofHours(1)), true, false),   // tutorial
                    new CropHost(13, now.minus(Duration.ofHours(2)), false, true));  // ripe: a valid host
            var plan = planner.plan(overdue, Set.of(), crops, Set.of(), 0, now);
            assertEquals(3, plan.size(), plan.toString());
            assertEquals(Host.TREE, plan.get(0).host());
            assertEquals(50L, plan.get(0).treeId());
            assertEquals(10L, plan.get(1).plantingId(), "oldest planting first");
            assertEquals(13L, plan.get(2).plantingId());
            assertEquals(2, plan.stream().filter(s -> s.host() == Host.CROP).count(), "maxCropPests");
        }

        @Test
        void oneActivePestPerCardAndPerCropAndTheCapIncludesExistingPests() {
            var overdue = List.of(new OverdueCard(1, "agree", null), new OverdueCard(2, "arrive", null));
            var crops = List.of(new CropHost(10, now.minus(Duration.ofHours(3)), false, false),
                    new CropHost(11, now.minus(Duration.ofHours(2)), false, false));
            assertTrue(planner.plan(overdue, Set.of(1L, 2L), crops, Set.of(), 0, now).isEmpty(), "cards already have pests");
            var one = planner.plan(overdue, Set.of(), crops, Set.of(10L), 1, now);
            assertEquals(1, one.size());
            assertEquals(11L, one.getFirst().plantingId());
            assertTrue(planner.plan(overdue, Set.of(), crops, Set.of(), 2, now).isEmpty(), "cap already reached");
            assertTrue(planner.plan(overdue, Set.of(), List.of(), Set.of(), 0, now).isEmpty(), "no host, no pest");
        }

        @Test
        void qualityPestScoreAndRainbowMutation() {
            var q = new QualityCalculator(RULES);
            var clean = q.score(new QualityCalculator.Input(3, false, true, QualityCalculator.SeasonFit.ALL_SEASON, true, true));
            var late = q.score(new QualityCalculator.Input(3, false, false, QualityCalculator.SeasonFit.ALL_SEASON, true, true));
            assertEquals(15, clean.total() - late.total());
            long plain = LongStream.range(0, 20_000).filter(i -> q.mutated(i, false)).count();
            long rainbow = LongStream.range(0, 20_000).filter(i -> q.mutated(i, true)).count();
            assertEquals(0.03, plain / 20_000.0, 0.006);
            assertEquals(0.15, rainbow / 20_000.0, 0.01);
            for (long i = 0; i < 2000; i++) if (q.mutated(i, false)) assertTrue(q.mutated(i, true), "a rainbow never removes a mutation");
        }
    }

    @Nested
    class Learning {
        final RewardEngine r = new RewardEngine(RULES);

        @Test
        void skillLessonsAreCappedAndOnlyTheFirstTwoGiveFertilizer() {
            assertEquals(new RewardEngine.ActivityCredit(true, 30, 1), r.creditActivity("SKILL", 0));
            assertEquals(new RewardEngine.ActivityCredit(true, 30, 1), r.creditActivity("SKILL", 1));
            assertEquals(new RewardEngine.ActivityCredit(true, 30, 0), r.creditActivity("SKILL", 2));
            assertEquals(new RewardEngine.ActivityCredit(false, 0, 0), r.creditActivity("SKILL", 3));
            assertEquals(new RewardEngine.ActivityCredit(true, 5, 0), r.creditActivity("GAME", 1));
            assertFalse(r.creditActivity("GAME", 2).credited());
            assertFalse(r.creditActivity("UNKNOWN", 0).credited());
        }

        @Test
        void mixedGoalNeedsTenUnitsAndOneSkillLesson() {
            assertTrue(r.goalReached(new RewardEngine.DayStats(10, 10, 0, 10), 9, 1));
            assertFalse(r.goalReached(new RewardEngine.DayStats(9, 9, 0, 9), 9, 1));
            assertFalse(r.goalReached(new RewardEngine.DayStats(10, 10, 0, 10), 9, 0));
        }

        @Test
        void harvestXpDiminishesWithinADayButNeverDependsOnBatching() {
            assertEquals(40, r.harvestXpGain(0, 40));
            assertEquals(4, r.harvestXpGain(40, 10), "40–90 at 40 %");
            assertEquals(1, r.harvestXpGain(120, 20), "beyond 90 at 5 %");
            int oneByOne = 0;
            for (int i = 0; i < 300; i += 6) oneByOne += r.harvestXpGain(i, 6);
            assertEquals(r.harvestXpGain(0, 300), oneByOne, 1, "same day total whatever the harvest batches");
        }
    }

    @Nested
    class Graduation {
        @Test
        void oneQuestionPerTreeWordLastTwoReversed() {
            var g = new ChallengeGenerator(RULES);
            var words = List.of(new Word(1L, "agree", "Đồng ý", null), new Word(2L, "arrive", "Đến", null),
                    new Word(3L, "boat", "Tàu thuyền", null), new Word(4L, "camera", "Máy ảnh", null),
                    new Word(5L, "river", "Dòng sông", null));
            var pool = List.of(new Word(null, "window", "Cửa sổ", null), new Word(null, "teacher", "Giáo viên", null));
            var qs = g.generateFor(words, pool, "grad-1", 2);
            assertEquals(5, qs.size());
            assertEquals(List.of("agree", "arrive", "boat", "camera", "river"), qs.stream().map(ChallengeGenerator.Question::word).toList());
            assertEquals(List.of(Direction.EN_VI, Direction.EN_VI, Direction.EN_VI, Direction.VI_EN, Direction.VI_EN),
                    qs.stream().map(ChallengeGenerator.Question::direction).toList());
            assertEquals(qs, g.generateFor(words, pool, "grad-1", 2), "deterministic per seed");
        }
    }
}
