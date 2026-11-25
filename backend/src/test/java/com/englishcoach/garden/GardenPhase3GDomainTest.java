package com.englishcoach.garden;

import com.englishcoach.garden.domain.SocialEngine;
import com.englishcoach.garden.domain.SocialEngine.Crop;
import com.englishcoach.garden.domain.SocialEngine.Island;
import com.englishcoach.garden.domain.SocialEngine.Reason;
import com.englishcoach.garden.domain.SocialEngine.Taker;
import com.englishcoach.garden.domain.SocialRules;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/** Phase 3G rules as pure decisions: how much a take carries, what protects an island, who may take, public names. */
class GardenPhase3GDomainTest {

    static final Instant NOW = Instant.parse("2026-10-12T05:00:00Z");
    static final Instant LONG_AGO = NOW.minus(Duration.ofDays(30));

    static SocialRules rules(int portionsPerUnit, int fractionBp) {
        return new SocialRules(portionsPerUnit, new SocialRules.Theft(fractionBp, 24, 3, 1, 2, 6, 72, 24, 20, Set.of("QA_SPROUT", "CRYSTAL_ORCHID")),
                new SocialRules.Discovery(12, 20, 2), 30, 20, 10, List.of("GARDEN_BEAUTIFUL"), 24);
    }

    static final SocialEngine ENGINE = new SocialEngine(rules(10, 1000));
    static final Taker TAKER = new Taker(true, LONG_AGO, LONG_AGO, 0, null);
    static final Island ISLAND = new Island(LONG_AGO, 0, null, null, 0, null);

    static Crop ripe(String code, int taken) {
        return new Crop(code, false, true, NOW.minus(Duration.ofHours(2)), taken);
    }

    @Test
    void aTakeIsASmallShareAndTheOwnerKeepsExactlyTheRest() {
        assertEquals(1, ENGINE.takeSize(0), "10 % of ten portions");
        assertEquals(0, ENGINE.takeSize(1), "nine portions left: 10 % rounds down to nothing");
        for (int unit = 2; unit <= 60; unit++) {
            for (int bp : new int[]{1, 250, 500, 999, 1000}) {
                SocialEngine e = new SocialEngine(rules(unit, bp));
                int take = e.takeSize(0);
                assertTrue(take * 10 <= unit, "never above a tenth of the unit");
                assertEquals(unit, take + e.ownerPortions(take), "taker + owner = one unit");
                assertTrue(e.ownerPortions(take) >= unit - unit / 10);
            }
        }
    }

    @Test
    void aCropThatCannotBeSplitSmallIsNeverTaken() {
        // five portions per unit: a tenth is half a portion — taking one whole portion would be 20 %, so nothing is taken
        SocialEngine coarse = new SocialEngine(rules(5, 1000));
        assertEquals(0, coarse.takeSize(0));
        assertEquals(Reason.NOT_ENOUGH_YIELD, coarse.verdict(TAKER, ISLAND, ripe("TOMATO", 0), NOW).reason());
        assertThrows(IllegalArgumentException.class, () -> rules(10, 1001), "a share above 10 % is not a configuration");
        assertThrows(IllegalArgumentException.class, () -> rules(1, 1000));
    }

    @Test
    void anEligibleRipeCropGivesOnePortion() {
        var v = ENGINE.verdict(TAKER, ISLAND, ripe("TOMATO", 0), NOW);
        assertTrue(v.ok());
        assertEquals(1, v.portions());
    }

    @Test
    void theCropItselfDecidesLast() {
        assertEquals(Reason.CROP_EXCLUDED, ENGINE.verdict(TAKER, ISLAND, ripe("CRYSTAL_ORCHID", 0), NOW).reason());
        assertEquals(Reason.CROP_EXCLUDED, ENGINE.verdict(TAKER, ISLAND, new Crop("WHEAT", true, true, LONG_AGO, 0), NOW).reason(), "the tutorial crop");
        var growing = ENGINE.verdict(TAKER, ISLAND, new Crop("TOMATO", false, false, NOW.plusSeconds(600), 0), NOW);
        assertEquals(Reason.NOT_READY, growing.reason());
        var fresh = ENGINE.verdict(TAKER, ISLAND, new Crop("TOMATO", false, true, NOW.minus(Duration.ofMinutes(5)), 0), NOW);
        assertEquals(Reason.CROP_FRESH, fresh.reason());
        assertEquals(NOW.plus(Duration.ofMinutes(15)), fresh.availableAt(), "the owner's head start ends twenty minutes after ripening");
        assertEquals(Reason.CROP_TAKEN, ENGINE.verdict(TAKER, ISLAND, ripe("TOMATO", 1), NOW).reason());
    }

    @Test
    void anIslandIsProtectedWhileNewAfterATakeAndAtItsDailyLimit() {
        Island fresh = new Island(NOW.minus(Duration.ofHours(10)), 0, null, null, 0, null);
        var intro = ENGINE.verdict(TAKER, fresh, ripe("TOMATO", 0), NOW);
        assertEquals(Reason.ISLAND_NEW, intro.reason());
        assertEquals(NOW.plus(Duration.ofHours(62)), intro.availableAt());

        Instant lastTake = NOW.minus(Duration.ofHours(2));
        var shield = ENGINE.verdict(TAKER, new Island(LONG_AGO, 1, lastTake, lastTake, 0, null), ripe("TOMATO", 0), NOW);
        assertEquals(Reason.ISLAND_SHIELD, shield.reason());
        assertEquals(lastTake.plus(Duration.ofHours(6)), shield.availableAt());

        Instant first = NOW.minus(Duration.ofHours(20));
        Instant second = NOW.minus(Duration.ofHours(8));
        var capped = ENGINE.verdict(TAKER, new Island(LONG_AGO, 2, first, second, 0, null), ripe("TOMATO", 0), NOW);
        assertEquals(Reason.VICTIM_LIMIT, capped.reason());
        assertEquals(first.plus(Duration.ofHours(24)), capped.availableAt(), "free again when the oldest take leaves the window");
        assertTrue(ENGINE.protection(ISLAND, NOW).ok());
    }

    @Test
    void whoCannotBeTakenFromCannotTake() {
        assertEquals(Reason.THIEF_PRIVATE, ENGINE.verdict(new Taker(false, LONG_AGO, LONG_AGO, 0, null), ISLAND, ripe("TOMATO", 0), NOW).reason());
        Instant joined = NOW.minus(Duration.ofHours(1));
        assertEquals(Reason.THIEF_NEW, ENGINE.verdict(new Taker(true, joined, joined, 0, null), ISLAND, ripe("TOMATO", 0), NOW).reason());
        var reopened = ENGINE.verdict(new Taker(true, LONG_AGO, NOW.minus(Duration.ofHours(3)), 0, null), ISLAND, ripe("TOMATO", 0), NOW);
        assertEquals(Reason.THIEF_REOPENED, reopened.reason());
        assertEquals(NOW.plus(Duration.ofHours(21)), reopened.availableAt());
        Instant oldest = NOW.minus(Duration.ofHours(23));
        var limit = ENGINE.verdict(new Taker(true, LONG_AGO, LONG_AGO, 3, oldest), ISLAND, ripe("TOMATO", 0), NOW);
        assertEquals(Reason.THIEF_LIMIT, limit.reason());
        assertEquals(oldest.plus(Duration.ofHours(24)), limit.availableAt());
        Instant pair = NOW.minus(Duration.ofHours(9));
        assertEquals(Reason.PAIR_LIMIT, ENGINE.verdict(TAKER, new Island(LONG_AGO, 1, pair, pair, 1, pair), ripe("TOMATO", 0), NOW).reason(),
                "one take per island a day comes before the island's own shield in what the taker is told");
    }

    @Test
    void publicNamesAreFoldedForSearchAndNeverKeepAnAddress() {
        assertEquals("nguyen duc anh", SocialEngine.nameKey("  Nguyễn  Đức-Anh "));
        assertEquals("minh 2006", SocialEngine.nameKey("Minh_2006"));
        assertEquals("Lan", SocialEngine.cleanName("Lan (lan.tran@example.com)"));
        assertNull(SocialEngine.cleanName("someone@example.com"));
        assertNull(SocialEngine.cleanName("   "));
        assertEquals(80, SocialEngine.cleanName("x".repeat(200)).length());
    }
}
