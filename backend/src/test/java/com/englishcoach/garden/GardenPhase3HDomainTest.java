package com.englishcoach.garden;

import com.englishcoach.garden.domain.AnimalEngine;
import com.englishcoach.garden.domain.AnimalEngine.Progress;
import com.englishcoach.garden.domain.AnimalEngine.Stage;
import com.englishcoach.garden.domain.AnimalRules;
import com.englishcoach.garden.domain.AnimalRules.Livestock;
import com.englishcoach.garden.domain.SocialEngine;
import com.englishcoach.garden.domain.SocialEngine.Guard;
import com.englishcoach.garden.domain.SocialEngine.Reason;
import com.englishcoach.garden.domain.SocialRules;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/** Phase 3H pure rules: lazy growth and production, food and water bounds, guardian decisions, portion sale value. */
class GardenPhase3HDomainTest {

    static final Instant T0 = Instant.parse("2026-10-09T03:00:00Z");

    static AnimalRules rules(int restBp) {
        return AnimalRules.of(new AnimalRules.Feed("FEED", Map.of("WHEAT", 1), 48, 2500), new AnimalRules.Water("WELL_WATER", 48, 24), restBp,
                List.of(new AnimalRules.House("COOP", "Chuồng gà", "CHICKEN", 4, 6000, 3)),
                List.of(new Livestock("CHICKEN", "Gà", "Gà con", 1200, 24, 2, 24, "EGG", 8, 3)),
                List.of(new AnimalRules.Product("EGG", "Trứng gà", 36)), new AnimalRules.Compost("EGG", 3, "FERTILIZER", 2),
                List.of(new AnimalRules.Guardian("DOG", "Chó", 8, 20000, 2, 24, 24, 3, 0, 0),
                        new AnimalRules.Guardian("GOOSE", "Ngỗng", 6, 12000, 2, 24, 0, 0, 40, 0),
                        new AnimalRules.Guardian("CAT", "Mèo", 5, 8000, 1, 24, 0, 0, 0, 1)));
    }

    static final AnimalEngine E = new AnimalEngine(rules(5000));
    static final Livestock CHICKEN = E.rules().livestock().get("CHICKEN");

    static Instant h(double hours) {
        return T0.plusSeconds(Math.round(hours * 3600));
    }

    @Test
    void aCaredForChickGrowsInItsGrowTimeAndThenLays() {
        Progress born = new Progress(T0, 0, 0);
        Progress half = E.advance(CHICKEN, born, h(100), h(100), h(12));
        assertEquals(Stage.YOUNG, E.stage(CHICKEN, half.growthSeconds()));
        assertEquals(Stage.BABY, E.stage(CHICKEN, E.advance(CHICKEN, born, h(100), h(100), h(11.9)).growthSeconds()));
        Progress adult = E.advance(CHICKEN, born, h(100), h(100), h(24));
        assertEquals(Stage.ADULT, E.stage(CHICKEN, adult.growthSeconds()));
        assertEquals(0, adult.productSeconds(), "nothing is produced before adulthood");
        assertEquals(h(24), E.adultAt(CHICKEN, born, h(100), h(100)));
        Progress laying = E.advance(CHICKEN, born, h(100), h(100), h(24 + 17));
        assertEquals(2, E.ready(CHICKEN, laying.productSeconds()), "one egg per eight cared-for hours");
        assertEquals(h(48), E.nextProductAt(CHICKEN, laying, h(100), h(100)));
        assertEquals(3600, E.afterCollect(CHICKEN, laying.productSeconds(), 2), "the hour toward the next egg is kept");
    }

    @Test
    void careIsFoodAndWaterTogetherAndTheStoreIsSmall() {
        Progress adult = new Progress(T0, CHICKEN.growSeconds(), 0);
        assertEquals(0, E.advance(CHICKEN, adult, h(100), T0, h(50)).productSeconds(), "food without water produces nothing");
        assertEquals(0, E.advance(CHICKEN, adult, T0, h(100), h(50)).productSeconds(), "water without food produces nothing");
        Progress partly = E.advance(CHICKEN, adult, h(10), h(100), h(50));
        assertEquals(10 * 3600, partly.productSeconds(), "only the cared-for hours count");
        assertNull(E.nextProductAt(CHICKEN, partly, h(10), h(100)), "care ended: no promise of a next egg");
        Progress full = E.advance(CHICKEN, adult, h(10_000), h(10_000), h(9_000));
        assertEquals(3, E.ready(CHICKEN, full.productSeconds()), "a year away still leaves three eggs, never more");
        assertEquals(CHICKEN.storeSeconds(), full.productSeconds());
    }

    @Test
    void neglectNeverHarmsAndAYoungAnimalIsNeverStuck() {
        Progress born = new Progress(T0, 0, 0);
        Progress slow = E.advance(CHICKEN, born, T0, T0, h(24));
        assertEquals(12 * 3600, slow.growthSeconds(), "without care it grows at half speed");
        assertEquals(Stage.ADULT, E.stage(CHICKEN, E.advance(CHICKEN, born, T0, T0, h(48)).growthSeconds()));
        assertEquals(h(48), E.adultAt(CHICKEN, born, T0, T0));
        // counters only ever rise, whatever the care and however long the absence
        Random rng = new Random(7);
        for (int i = 0; i < 300; i++) {
            Progress p = new Progress(T0, rng.nextInt(30) * 3600L, rng.nextInt(20) * 3600L);
            Progress q = E.advance(CHICKEN, p, h(rng.nextInt(60)), h(rng.nextInt(60)), h(rng.nextInt(4000)));
            assertTrue(q.growthSeconds() >= p.growthSeconds(), "growth is never lost");
            assertTrue(q.productSeconds() >= p.productSeconds() && q.productSeconds() <= CHICKEN.storeSeconds(), "products are never lost");
            assertFalse(q.progressAt().isBefore(p.progressAt()));
        }
        assertEquals(new Progress(T0, 5, 5), E.advance(CHICKEN, new Progress(T0, 5, 5), h(1), h(1), T0.minusSeconds(60)), "time never runs backwards");
    }

    @Test
    void evaluatingOftenGivesExactlyWhatEvaluatingOnceGives() {
        Random rng = new Random(11);
        for (int round = 0; round < 60; round++) {
            Instant fed = h(rng.nextInt(40));
            Instant watered = h(rng.nextInt(40));
            Progress once = E.advance(CHICKEN, new Progress(T0, 0, 0), fed, watered, h(90));
            Progress steps = new Progress(T0, 0, 0);
            Instant t = T0;
            while (t.isBefore(h(90))) {
                t = t.plusSeconds(1 + rng.nextInt(5000));
                if (t.isAfter(h(90))) t = h(90);
                steps = E.advance(CHICKEN, steps, fed, watered, t);
            }
            assertEquals(once.growthSeconds(), steps.growthSeconds(), "growth does not depend on how often the server looked");
            assertTrue(Math.abs(once.productSeconds() - steps.productSeconds()) <= 1, "production does not either");
        }
    }

    @Test
    void foodIsBoundedAndLearningStretchesARation() {
        assertEquals(h(24), E.fedAfterRation(T0, 24, false, T0));
        assertEquals(h(30), E.fedAfterRation(T0, 24, true, T0), "a learning day adds a quarter");
        assertEquals(h(48), E.fedAfterRation(h(24), 24, false, T0), "two days ahead at most");
        assertNull(E.fedAfterRation(h(24.5), 24, false, T0), "a third ration would be wasted: refused");
        assertNull(E.fedAfterRation(h(24), 24, true, T0));
        assertEquals(h(24), E.fedAfterRation(T0.minusSeconds(999_999), 24, false, T0), "old hunger is not a debt");
        assertTrue(E.troughRefillable(h(24), T0));
        assertFalse(E.troughRefillable(h(24.1), T0));
        assertEquals(h(48), E.wateredAfterRefill(T0));
    }

    @Test
    void guardiansWorkOnlyWhileFedAndOnlyWithinTheirBounds() {
        assertFalse(E.dogReady(T0, null, T0), "a hungry dog does not guard");
        assertTrue(E.dogReady(h(5), null, T0));
        assertFalse(E.dogReady(h(50), T0, h(23.9)), "once per cooldown");
        assertTrue(E.dogReady(h(50), T0, h(24)));
        assertEquals(h(3), E.dogShieldUntil(T0, h(1)));
        assertNull(E.dogShieldUntil(T0, h(3)), "the watch ends");
        assertNull(E.dogShieldUntil(null, T0));
        assertEquals(40, E.gooseGraceMinutes(h(1), T0));
        assertEquals(0, E.gooseGraceMinutes(T0, T0));
        assertEquals(1, E.catPestRelief(h(1), T0, 2));
        assertEquals(0, E.catPestRelief(h(1), T0, 1), "the cat never removes every pest place");
        assertEquals(0, E.catPestRelief(T0, T0, 2));
    }

    @Test
    void portionsOfOneUnitNeverSellForMoreThanTheUnit() {
        for (long unit : new long[]{0, 1, 9, 16, 44, 84, 130, 215, 300, 385, 560, 700, 1500, 2625}) {
            assertEquals(unit, AnimalEngine.portionValue(unit, 10, 10), "ten portions are the unit");
            for (int taken = 0; taken <= 10; taken++) {
                long together = AnimalEngine.portionValue(unit, taken, 10) + AnimalEngine.portionValue(unit, 10 - taken, 10);
                assertTrue(together <= unit, "two holders never get more than the unit");
            }
            long oneByOne = 0;
            for (int i = 0; i < 10; i++) oneByOne += AnimalEngine.portionValue(unit, 1, 10);
            assertTrue(oneByOne <= unit, "selling portion by portion never beats selling the unit");
            assertTrue(AnimalEngine.portionValue(unit, 9, 10) >= unit * 9 / 10 - 1 && AnimalEngine.portionValue(unit, 9, 10) <= unit * 9 / 10);
        }
        assertEquals(0, AnimalEngine.portionValue(100, 0, 10));
        assertEquals(0, AnimalEngine.portionValue(100, -3, 10));
    }

    @Test
    void theDogsWatchProtectsTheIslandAndTheGooseLengthensTheHeadStart() {
        SocialEngine e = new SocialEngine(new SocialRules(10, new SocialRules.Theft(1000, 24, 3, 1, 2, 6, 72, 24, 20, Set.of()),
                new SocialRules.Discovery(12, 20, 2), 30, 20, 10, List.of("GARDEN_BEAUTIFUL"), 24));
        Instant joined = T0.minus(Duration.ofDays(30));
        var taker = new SocialEngine.Taker(true, joined, joined, 0, null);
        var island = new SocialEngine.Island(joined, 0, null, null, 0, null);
        var crop = new SocialEngine.Crop("TOMATO", false, true, T0, 0);
        assertEquals(Reason.OK, e.verdict(taker, island, crop, T0.plusSeconds(25 * 60)).reason());
        var fresh = e.verdict(taker, island, crop, T0.plusSeconds(25 * 60), new Guard(40, null));
        assertEquals(Reason.CROP_FRESH, fresh.reason());
        assertEquals(T0.plusSeconds(60 * 60), fresh.availableAt());
        assertEquals(Reason.OK, e.verdict(taker, island, crop, T0.plusSeconds(60 * 60), new Guard(40, null)).reason());
        var guarded = e.verdict(taker, island, crop, h(2), new Guard(0, h(3)));
        assertEquals(Reason.ISLAND_GUARDED, guarded.reason());
        assertEquals(h(3), guarded.availableAt());
        assertEquals(Reason.OK, e.verdict(taker, island, crop, h(3), new Guard(0, h(3))).reason(), "the watch is temporary");
        // the free protections are told first and are never replaced by a pet
        var fresher = new SocialEngine.Island(h(1), 0, null, null, 0, null);
        assertEquals(Reason.ISLAND_NEW, e.protection(fresher, h(2), new Guard(0, h(3))).reason());
    }
}
