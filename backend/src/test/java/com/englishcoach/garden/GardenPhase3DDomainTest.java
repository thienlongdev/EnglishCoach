package com.englishcoach.garden;

import com.englishcoach.garden.domain.FarmingEngine;
import com.englishcoach.garden.domain.FarmingEngine.Treatment;
import com.englishcoach.garden.domain.FarmingRules;
import com.englishcoach.garden.domain.FarmingRules.Effect;
import com.englishcoach.garden.domain.GardenRules;
import com.englishcoach.garden.domain.GrowthCalculator;
import com.englishcoach.garden.domain.GrowthCalculator.PlantingFacts;
import com.englishcoach.garden.domain.GrowthCalculator.Slowdown;
import com.englishcoach.garden.domain.QualityCalculator;
import com.englishcoach.garden.domain.SoilModel;
import com.englishcoach.garden.domain.SoilModel.Event;
import com.englishcoach.garden.domain.SoilModel.Status;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Phase 3D pure rules: soil moisture (drought, rain, waterlogging), farming supplies, the pest spray that never resolves
 * a pest, the soil's share of harvest quality and the harvest coin bonus. No database: the V85 fixture
 * ({@link GardenTestRules#phase3d()}, {@link GardenTestRules#farming()}), checked against the migration by
 * {@code GardenPhase3DPersistenceTest}.
 */
class GardenPhase3DDomainTest {

    static final FarmingRules FARMING = GardenTestRules.farming();
    /** A Monday 08:00 Vietnam time in the Lữ Hành (spring) week. */
    static final Instant T0 = Instant.parse("2026-11-02T01:00:00Z");

    /** The V85 rules with a fixed weather: every window sunny ({@code rain} 0) or every window rainy (1). */
    static GardenRules weather(double rain) {
        GardenRules r = GardenTestRules.phase3d();
        var p = GardenTestRules.parts(r);
        var w = r.weather();
        Map<GardenRules.Season, double[]> chances = new java.util.EnumMap<>(GardenRules.Season.class);
        for (var s : w.chances().keySet()) chances.put(s, new double[]{rain, 0});
        p.weather = new GardenRules.WeatherRules(w.startAt(), w.windowHours(), w.rainSpeed(), w.rainbowMutation(), w.forecastWindows(), chances);
        return p.build();
    }

    static final GardenRules SUNNY = weather(0);
    static final GardenRules RAINY = weather(1);

    static Instant h(double hours) {
        return T0.plus(Duration.ofSeconds(Math.round(hours * 3600)));
    }

    static SoilModel.Timeline soil(GardenRules rules, String crop, List<Event> events, double hours) {
        return new SoilModel(rules, FARMING).timeline(T0, FARMING.thirstOf(crop), events, h(hours), null);
    }

    static Event event(double atHours, Effect effect, Double hours, double value) {
        return new Event(h(atHours), effect, hours == null ? null : h(atHours + hours), value);
    }

    // ------------------------------------------------------------------ drought

    @Test
    void sunshineDriesTheSoilAtTheCropsOwnThirstAndAThirstyCropSlowsDown() {
        // rose: thirst 1.0, 4.5 moisture an hour in spring: from 60 it crosses the dry line (25) after 7 h 47 min
        var tl = soil(SUNNY, "ROSE", List.of(), 12);
        assertEquals(60 - 4.5 * 4, tl.at(h(4)).moisture(), 0.01);
        assertEquals(Status.OK, tl.at(h(7.5)).status());
        assertEquals(Status.DRY, tl.at(h(8)).status());
        assertEquals(h(35.0 / 4.5).getEpochSecond(), tl.at(h(1)).nextChangeAt().getEpochSecond(), 1);
        assertEquals(Status.DRY, tl.at(h(1)).nextStatus());
        // a thirsty crop dries sooner, a hardy one later
        assertEquals(Status.DRY, soil(SUNNY, "WATERMELON", List.of(), 12).at(h(5.5)).status());
        assertEquals(Status.OK, soil(SUNNY, "WHEAT", List.of(), 12).at(h(10)).status());
        // the dry stretch slows growth at the dry factor (one window per weather segment, back to back)
        assertFalse(tl.slowdowns().isEmpty());
        assertTrue(tl.slowdowns().stream().allMatch(s -> s.factor() == FARMING.soil().dryFactor()));
        assertEquals(h(12), tl.slowdowns().getLast().end());
        assertEquals(35.0 / 4.5 * 3600, Duration.between(T0, tl.slowdowns().getFirst().start()).toSeconds(), 1);
    }

    @Test
    void wateringRestoresTheSoilAndNeverFloodsIt() {
        // watered when dry: +35 moisture, the crop is healthy again and the slowdown ends at that instant
        var tl = soil(SUNNY, "ROSE", List.of(event(9, Effect.MOISTURE, null, 35)), 12);
        assertEquals(Status.DRY, tl.at(h(8.9)).status());
        assertEquals(Status.OK, tl.at(h(9.01)).status());
        assertEquals(h(9), tl.slowdowns().getLast().end());
        // three waterings in a row on fresh soil stop at the waterlogging line: watering alone never floods a bed
        var soaked = soil(SUNNY, "ROSE", List.of(event(0, Effect.MOISTURE, null, 35), event(0.01, Effect.MOISTURE, null, 35),
                event(0.02, Effect.MOISTURE, null, 35)), 2);
        assertEquals(Status.OK, soaked.at(h(0.03)).status());
        assertTrue(soaked.at(h(0.03)).moisture() <= FARMING.soil().wetAbove() + 1e-9);
        assertTrue(soaked.slowdowns().isEmpty());
    }

    @Test
    void theSummerDriesFasterAndTheWinterSlower() {
        var soil = FARMING.soil();
        assertTrue(soil.seasonEvap().get(GardenRules.Season.CONG_SO) > soil.seasonEvap().get(GardenRules.Season.LU_HANH));
        assertTrue(soil.seasonEvap().get(GardenRules.Season.THANH_NGU) < soil.seasonEvap().get(GardenRules.Season.LU_HANH));
        // one week later (Công Sở = summer) the same crop loses 25 % more an hour
        Instant summer = T0.plus(Duration.ofDays(7));
        var tl = new SoilModel(SUNNY, FARMING).timeline(summer, 1.0, List.of(), summer.plus(Duration.ofHours(4)), null);
        assertEquals(60 - 4.5 * 1.25 * 4, tl.at(summer.plus(Duration.ofHours(4))).moisture(), 0.01);
    }

    // ------------------------------------------------------------------ rain and waterlogging

    @Test
    void oneShowerIsHealthyAndPersistentRainWaterlogs() {
        var tl = soil(RAINY, "ROSE", List.of(), 12);
        // 6 moisture an hour: 60 -> 84 after the first four-hour window (healthy), over the line (85) soon after
        assertEquals(84, tl.at(h(4)).moisture(), 0.01);
        assertEquals(Status.OK, tl.at(h(4)).status());
        assertEquals(Status.WET, tl.at(h(5)).status());
        assertEquals(100, tl.at(h(12)).moisture(), 0.01);
        assertEquals(FARMING.soil().wetFactor(), tl.slowdowns().getFirst().factor(), 1e-9);
    }

    @Test
    void aRainCoverKeepsTheRainOutAndTheRainBonusWithIt() {
        var tl = soil(RAINY, "ROSE", List.of(event(0, Effect.RAIN_COVER, 12.0, 0)), 16);
        assertEquals(60, tl.at(h(12)).moisture(), 0.01);
        assertEquals(Status.OK, tl.at(h(12)).status());
        // while covered, the rain speeds nothing up: a window cancelling the rain factor
        assertEquals(1.0 / RAINY.weather().rainSpeed(), tl.slowdowns().getFirst().factor(), 1e-9);
        var growth = new GrowthCalculator(RAINY);
        var covered = new PlantingFacts(T0, 36000, 0, GardenRules.Season.ALL, tl.slowdowns());
        assertEquals(1.0, growth.speedAt(covered, h(2)), 1e-9);
        // when the cover ends the rain reaches the soil again
        assertTrue(tl.at(h(16)).moisture() > 80);
    }

    @Test
    void drainageClearsWaterloggedSoilAndKeepsItClearWhileItLasts() {
        var tl = soil(RAINY, "ROSE", List.of(event(8, Effect.DRAINAGE, 24.0, 65)), 40);
        assertEquals(Status.WET, tl.at(h(7.9)).status());
        assertEquals(65, tl.at(h(8)).moisture(), 0.5);
        for (double t = 8.1; t < 32; t += 1.3) {
            assertEquals(Status.OK, tl.at(h(t)).status(), "drained at hour " + t);
            assertTrue(tl.at(h(t)).moisture() <= FARMING.soil().wetAbove() + 1e-9);
        }
        assertEquals(Status.WET, tl.at(h(36)).status(), "after the drainage ends, persistent rain floods the bed again");
    }

    @Test
    void mulchAndShadeSlowTheDryingAndMulchAlsoSoftensTheRain() {
        double plain = soil(SUNNY, "ROSE", List.of(), 6).at(h(6)).moisture();
        double mulched = soil(SUNNY, "ROSE", List.of(event(0, Effect.MULCH, null, 0.6)), 6).at(h(6)).moisture();
        double shaded = soil(SUNNY, "ROSE", List.of(event(0, Effect.SHADE, 12.0, 0.4)), 6).at(h(6)).moisture();
        assertEquals(60 - 4.5 * 6, plain, 0.01);
        assertEquals(60 - 4.5 * 0.6 * 6, mulched, 0.01);
        assertEquals(60 - 4.5 * 0.4 * 6, shaded, 0.01);
        assertEquals(60 + 6 * 0.6 * 4, soil(RAINY, "ROSE", List.of(event(0, Effect.MULCH, null, 0.6)), 4).at(h(4)).moisture(), 0.01);
        // the shade net ends after its hours; mulch lasts until harvest
        var later = soil(SUNNY, "ROSE", List.of(event(0, Effect.SHADE, 2.0, 0.4)), 4);
        assertEquals(60 - 4.5 * 0.4 * 2 - 4.5 * 2, later.at(h(4)).moisture(), 0.01);
    }

    // ------------------------------------------------------------------ bounded, deterministic, monotonic

    @Test
    void theSlowdownOfStressedSoilIsBoundedSoACropAlwaysRipens() {
        var model = new SoilModel(SUNNY, FARMING);
        var tl = model.timeline(T0, 1.5, List.of(), h(24 * 6), null);
        double slowed = tl.slowdowns().stream().mapToDouble(s -> Duration.between(s.start(), s.end()).toSeconds()).sum();
        assertEquals(FARMING.soil().maxStressHours() * 3600, slowed, 2);
        assertEquals(FARMING.soil().maxStressHours() * 3600 * (1 - FARMING.soil().dryFactor()), model.maxGrowthLossSeconds(), 1e-6);
        // the worst case for every crop: never tended, six days of drought or of rain — it still ripens, and no later than
        // its unstressed time plus the bounded loss
        for (GardenRules rules : List.of(SUNNY, RAINY)) {
            var growth = new GrowthCalculator(rules);
            var soil = new SoilModel(rules, FARMING);
            for (var crop : rules.crops().values()) {
                if (crop.qaOnly()) continue;
                Instant end = h(24 * 6);
                var stressed = soil.timeline(T0, FARMING.thirstOf(crop.code()), List.of(), end, null);
                var plain = growth.evaluate(new PlantingFacts(T0, crop.baseSeconds(), 0, crop.season()), end);
                var withSoil = growth.evaluate(new PlantingFacts(T0, crop.baseSeconds(), 0, crop.season(), stressed.slowdowns()), end);
                assertTrue(withSoil.ready(), crop.code() + " ripens whatever the weather does");
                double delay = Duration.between(plain.readyAt(), withSoil.readyAt()).toSeconds();
                assertTrue(delay >= 0 && delay <= soil.maxGrowthLossSeconds() / rules.growth().speedFloor() + 2,
                        crop.code() + " is delayed by at most the bounded loss: " + delay);
            }
        }
    }

    @Test
    void theSameFactsAlwaysGiveTheSameSoilAndARipeCropNeverUnripens() {
        GardenRules rules = GardenTestRules.phase3d(); // the real weather timeline
        var soil = new SoilModel(rules, FARMING);
        var growth = new GrowthCalculator(rules);
        var weather = new com.englishcoach.garden.domain.WeatherCalendar(rules);
        for (var crop : rules.crops().values()) {
            if (crop.qaOnly()) continue;
            for (int start = 0; start < 28; start += 3) {
                Instant planted = T0.plus(Duration.ofHours(start * 7L));
                List<Event> events = new ArrayList<>();
                boolean wasReady = false;
                double lastProgress = -1;
                Instant readyAt = null;
                for (int step = 0; step <= 70; step++) {
                    Instant now = planted.plus(Duration.ofHours(step));
                    // the player waters at hour 6 and covers at hour 9: recorded at "now", never in the past
                    if (step == 6) events.add(new Event(now, Effect.MOISTURE, null, 35));
                    if (step == 9) events.add(new Event(now, Effect.RAIN_COVER, now.plus(Duration.ofHours(12)), 0));
                    Instant until = now.plus(Duration.ofDays(7));
                    var a = soil.timeline(planted, FARMING.thirstOf(crop.code()), events, until, weather.revealedUntil(now));
                    var b = soil.timeline(planted, FARMING.thirstOf(crop.code()), events, until, weather.revealedUntil(now));
                    assertEquals(a.segments(), b.segments(), "deterministic");
                    var snap = growth.evaluate(new PlantingFacts(planted, crop.baseSeconds(), 0, crop.season(), a.slowdowns()), now);
                    assertTrue(snap.progressSeconds() >= lastProgress - 1e-6, crop.code() + " never loses progress");
                    lastProgress = snap.progressSeconds();
                    if (wasReady) {
                        assertTrue(snap.ready(), crop.code() + " stays ripe");
                        assertEquals(readyAt, snap.readyAt(), "and the instant it ripened never moves");
                    }
                    if (snap.ready() && !wasReady) {
                        wasReady = true;
                        readyAt = snap.readyAt();
                    }
                    var c = a.at(now);
                    assertTrue(c.moisture() >= 0 && c.moisture() <= 100);
                }
            }
        }
    }

    // ------------------------------------------------------------------ supplies and pests

    @Test
    void aSprayOnlySuspendsThePestDamageAndNeverScoresLikeARealReview() {
        var engine = new FarmingEngine(SUNNY, FARMING);
        List<Slowdown> pest = List.of(new Slowdown(h(6), h(24), 0.85), new Slowdown(h(24), h(36), 0.7));
        var sprayed = engine.suppress(pest, List.of(new Treatment("ORGANIC_SPRAY", h(10), h(22))));
        assertEquals(List.of(new Slowdown(h(6), h(10), 0.85), new Slowdown(h(22), h(24), 0.85), new Slowdown(h(24), h(36), 0.7)), sprayed);
        // other supplies never touch a pest window
        assertEquals(pest, engine.suppress(pest, List.of(new Treatment("RAIN_COVER", h(10), h(22)), new Treatment("INSECT_NET", h(10), h(34)))));
        // harvest under an active spray: at least the spray's score, never the clean score of a genuine review
        int clean = SUNNY.quality().pestClean();
        var spray = List.of(new Treatment("ORGANIC_SPRAY", h(10), h(22)));
        assertEquals(18, engine.sprayedPestScore(0, spray, h(12), clean));
        assertEquals(18, engine.sprayedPestScore(10, spray, h(12), clean));
        assertEquals(clean, engine.sprayedPestScore(clean, spray, h(12), clean), "a reviewed pest keeps the full score");
        assertEquals(0, engine.sprayedPestScore(0, spray, h(23), clean), "an expired spray protects nothing");
        assertTrue(FARMING.item("ORGANIC_SPRAY").value() < clean);
    }

    @Test
    void timedSuppliesExpireAndOncePerPlantingOnesStayRecorded() {
        var engine = new FarmingEngine(SUNNY, FARMING);
        assertEquals(h(12), engine.expiresAt(FARMING.item("RAIN_COVER"), T0));
        assertEquals(h(24), engine.expiresAt(FARMING.item("INSECT_NET"), T0));
        assertNull(engine.expiresAt(FARMING.item("MULCH"), T0), "mulch lasts until harvest");
        assertNull(engine.expiresAt(FARMING.item("WELL_WATER"), T0), "well water is instant");
        var applied = List.of(new Treatment("INSECT_NET", T0, h(24)), new Treatment("CROP_TONIC", T0, h(8)));
        assertTrue(engine.active(applied, Effect.PEST_NET, h(23.9)));
        assertFalse(engine.active(applied, Effect.PEST_NET, h(24)));
        assertFalse(engine.active(applied, Effect.TONIC, h(9)));
        assertTrue(engine.everApplied(applied, Effect.TONIC, h(9)), "the tonic stays recorded for the harvest");
    }

    @Test
    void aTonicLiftsTheSlowdownWhileItLasts() {
        // dry from hour 7.8 on; a tonic at hour 9 for 8 hours: no slowdown between hour 9 and 17
        var tl = soil(SUNNY, "ROSE", List.of(event(9, Effect.TONIC, 8.0, 0.5)), 24);
        assertTrue(tl.slowdowns().stream().noneMatch(s -> s.start().isBefore(h(17)) && s.end().isAfter(h(9))));
        assertTrue(tl.slowdowns().stream().anyMatch(s -> !s.start().isBefore(h(17))), "the stress returns after the tonic");
        assertEquals(Status.DRY, tl.at(h(12)).status(), "the soil itself is still dry: only water fixes that");
    }

    // ------------------------------------------------------------------ harvest

    @Test
    void theSoilDecidesTheCarePartAndASeverelyStressedCropIsCappedNeverDestroyed() {
        var engine = new FarmingEngine(SUNNY, FARMING);
        int cared = SUNNY.quality().cared();
        var healthy = new SoilModel.Condition(50, Status.OK, 0.10 * 36000, 36000, null, null);
        var stressed = new SoilModel.Condition(20, Status.DRY, 0.30 * 36000, 36000, null, null);
        var severe = new SoilModel.Condition(10, Status.DRY, 0.60 * 36000, 36000, null, null);
        assertEquals(cared, engine.care(true, healthy, false).points());
        assertEquals(0, engine.care(false, healthy, false).points(), "healthy soil alone is not care: the crop must be tended");
        assertEquals((int) Math.round(cared * 0.5), engine.care(true, stressed, false).points());
        assertNull(engine.care(true, stressed, false).tierCap());
        assertEquals(0, engine.care(true, severe, false).points());
        assertEquals("GOOD", engine.care(true, severe, false).tierCap());
        // a tonic halves the stressed share: the severe crop is no longer capped
        var toned = engine.care(true, severe, true);
        assertEquals(0.30, toned.stressShare(), 1e-9);
        assertNull(toned.tierCap());
        assertEquals((int) Math.round(cared * 0.5), toned.points());

        var quality = new QualityCalculator(SUNNY);
        var input = new QualityCalculator.Input(3, false, true, QualityCalculator.SeasonFit.IN_SEASON, true, true);
        var golden = quality.score(input, SUNNY.quality().pestClean(), cared);
        assertEquals("GOLDEN", golden.tier().code());
        var capped = engine.capped(quality.score(input, SUNNY.quality().pestClean(), 0), engine.care(true, severe, false));
        assertEquals("GOOD", capped.tier().code());
        assertEquals(golden.total() - cared, capped.total(), "the score is kept; only the tier is capped");
        // the legacy call (growth model 1) is unchanged
        assertEquals(golden.total(), quality.score(input, SUNNY.quality().pestClean()).total());
        assertEquals(golden.total(), quality.score(input).total());
    }

    @Test
    void theHarvestBonusIsSmallProportionalAndCappedPerDay() {
        GardenRules rules = GardenTestRules.phase3d();
        var engine = new FarmingEngine(rules, FARMING);
        assertEquals(1, engine.harvestBonus(rules.crop("WHEAT")));
        assertEquals(23, engine.harvestBonus(rules.crop("PUMPKIN")));
        assertEquals(90, engine.harvestBonus(rules.crop("CRYSTAL_ORCHID")));
        assertEquals(0, engine.harvestBonus(rules.crop("QA_SPROUT")), "a crop that sells for nothing pays nothing");
        for (var c : rules.crops().values()) {
            assertTrue(engine.harvestBonus(c) <= 0.07 * c.sellPrice() + 1, c.code() + ": a small share of one sale");
        }
        int cap = FARMING.harvestBonus().dailyCap();
        assertEquals(23, engine.grantedBonus(23, 0));
        assertEquals(5, engine.grantedBonus(23, cap - 5));
        assertEquals(0, engine.grantedBonus(23, cap));
        assertEquals(0, engine.grantedBonus(23, cap + 50));
    }

    @Test
    void everySupplyOfTheCatalogueHasARealEffect() {
        assertEquals(10, FARMING.items().size());
        for (var item : FARMING.items().values()) {
            assertNotNull(item.category());
            switch (item.effect()) {
                case MOISTURE -> assertTrue(item.value() > 0);
                case MULCH, SHADE -> assertTrue(item.value() > 0 && item.value() < 1);
                case RAIN_COVER, PEST_NET -> assertTrue(item.hours() > 0);
                case DRAINAGE -> assertTrue(item.hours() > 0 && item.value() < FARMING.soil().wetAbove() && item.value() > FARMING.soil().dryBelow());
                case TONIC -> assertTrue(item.hours() > 0 && item.value() > 0 && item.value() < 1);
                case PEST_SPRAY -> assertTrue(item.hours() > 0 && item.value() > 0);
                case BOOST -> assertTrue(GardenTestRules.phase3d().boosts().containsKey(item.code()));
            }
        }
    }
}
