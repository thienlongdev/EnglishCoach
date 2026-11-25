package com.englishcoach.garden;

import com.englishcoach.garden.domain.FarmEconomyRules;
import com.englishcoach.garden.domain.GardenCalendar;
import com.englishcoach.garden.domain.GardenRules;
import com.englishcoach.garden.domain.GardenRules.Rarity;
import com.englishcoach.garden.domain.GardenRules.Season;
import com.englishcoach.garden.domain.MarketEngine;
import com.englishcoach.garden.domain.OrderEngine;
import com.englishcoach.garden.domain.OrderEngine.Line;
import com.englishcoach.garden.domain.OrderEngine.Supply;
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

/** Phase 3A pure rules (no Spring, no database, explicit instants): market rotation, delivery orders, bed expansion. */
class GardenPhase3DomainTest {

    static final GardenRules RULES = GardenTestRules.seeded();
    static final FarmEconomyRules ECONOMY = GardenTestRules.economy();
    static final MarketEngine MARKET = new MarketEngine(RULES, ECONOMY);
    static final OrderEngine ORDERS = new OrderEngine(RULES, ECONOMY);
    static final GardenCalendar CAL = new GardenCalendar(RULES);
    /** 2026-10-09 10:00 Vietnam (Lữ Hành week). */
    static final Instant T0 = Instant.parse("2026-10-09T03:00:00Z");

    @Nested
    class Market {
        @Test
        void rotationIsAPureFunctionOfTheVietnamDay() {
            LocalDate day = CAL.dayKey(T0);
            assertEquals(MARKET.offers(day), MARKET.offers(day), "same day, same stall (any device, any refresh)");
            // the day turns at 00:00 Vietnam time = 17:00 UTC
            Instant before = Instant.parse("2026-10-09T16:59:59Z"), after = Instant.parse("2026-10-09T17:00:00Z");
            assertEquals(LocalDate.parse("2026-10-09"), CAL.dayKey(before));
            assertEquals(LocalDate.parse("2026-10-10"), CAL.dayKey(after));
            Set<List<String>> rotations = new HashSet<>();
            for (int d = 0; d < 28; d++) {
                rotations.add(MARKET.offers(day.plusDays(d)).stream().map(MarketEngine.Offer::code).toList());
            }
            assertTrue(rotations.size() > 3, "the featured packs rotate from day to day");
        }

        @Test
        void staplesAreTheFertilizersNeverWaterAndPacksFollowTheTheme() {
            for (int d = 0; d < 28; d++) {
                LocalDate day = LocalDate.parse("2026-10-05").plusDays(d);
                var offers = MARKET.offers(day);
                assertEquals(List.of("ITEM:FERTILIZER", "ITEM:FERTILIZER_PREMIUM"),
                        offers.stream().filter(o -> o.kind() == MarketEngine.Kind.STAPLE).map(MarketEngine.Offer::code).toList());
                assertTrue(offers.stream().noneMatch(o -> o.item().equals("WATER")), "water stays the Flashcard resource");
                Season theme = CAL.theme(CAL.startOfDay(day));
                var packs = offers.stream().filter(o -> o.kind() == MarketEngine.Kind.PACK).toList();
                assertEquals(ECONOMY.market().featuredSlots(), packs.size());
                for (var p : packs) {
                    var crop = RULES.crop(p.cropCode());
                    assertTrue(crop.season() == Season.ALL || crop.season() == theme, p.code() + " on " + day);
                    assertTrue(crop.rarity() == Rarity.COMMON || crop.rarity() == Rarity.RARE, "never Epic / Legendary");
                    assertFalse(crop.qaOnly());
                    assertEquals(ECONOMY.market().packSize(), p.unitQty());
                    assertEquals((long) Math.floor(5 * crop.seedPrice() * 0.9 + 1e-9), p.price(), "pack = 5 seeds at 90 %");
                    assertEquals(crop.unlockLevel(), p.unlockLevel());
                }
            }
        }

        @Test
        void purchaseArithmeticIsBounded() {
            var fert = MARKET.offers(CAL.dayKey(T0)).getFirst();
            assertEquals(120, fert.price());
            assertEquals(240, MARKET.total(fert, 2));
            assertEquals(-1, MARKET.total(fert, 0));
            assertEquals(-1, MARKET.total(fert, ECONOMY.market().maxPerPurchase() + 1));
            assertTrue(MARKET.offer(CAL.dayKey(T0), "ITEM:WATER").isEmpty());
            assertTrue(MARKET.offer(CAL.dayKey(T0), "PACK:CRYSTAL_ORCHID").isEmpty());
        }
    }

    @Nested
    class Orders {
        @Test
        void sameUserSlotAndPeriodAlwaysGiveTheSameOrder() {
            var a = ORDERS.generate(42, 1, T0, 6, 6).orElseThrow();
            var b = ORDERS.generate(42, 1, T0.plus(Duration.ofHours(3)), 6, 6).orElseThrow();
            assertEquals(a.lines().stream().map(Line::cropCode).toList(), b.lines().stream().map(Line::cropCode).toList(),
                    "the crop choice is seeded by user + slot + period");
            assertEquals("D2026-10-09", ORDERS.periodKey(OrderEngine.Kind.DAILY, T0));
            assertEquals("W2026-10-05", ORDERS.periodKey(OrderEngine.Kind.WEEKLY, T0));
            assertEquals(Instant.parse("2026-10-09T17:00:00Z"), ORDERS.expiresAt(OrderEngine.Kind.DAILY, T0));
            assertEquals(Instant.parse("2026-10-11T17:00:00Z"), ORDERS.expiresAt(OrderEngine.Kind.WEEKLY, T0), "theme week ends Monday 00:00");
        }

        @Test
        void everyGeneratedOrderIsGrowableInItsWindowAndBounded() {
            for (int level = 1; level <= 14; level++) {
                for (int h = 0; h < 24; h++) {
                    Instant now = T0.plus(Duration.ofHours(h)).plus(Duration.ofDays(level % 7));
                    for (int slot = 1; slot <= ECONOMY.orders().slots(); slot++) {
                        var spec = ORDERS.generate(1000L + level, slot, now, level, 6 + level % 5);
                        if (spec.isEmpty()) continue;
                        var kind = ORDERS.kindOf(slot);
                        var k = ORDERS.rulesOf(kind);
                        double remaining = Duration.between(now, ORDERS.expiresAt(kind, now)).toSeconds();
                        long value = 0;
                        for (Line l : spec.get().lines()) {
                            var crop = RULES.crop(l.cropCode());
                            assertTrue(crop.unlockLevel() <= level, "unlocked " + l);
                            assertTrue(crop.rarity() == Rarity.COMMON || crop.rarity() == Rarity.RARE, "orderable " + l);
                            assertTrue(crop.purchasable() && crop.seedEssence() == 0, "seed for coins " + l);
                            assertTrue(ORDERS.growSeconds(crop, now) <= remaining * ECONOMY.orders().growShare() + 1e-6, "growable " + l + " at " + now);
                            assertTrue(l.qty() >= 1 && l.qty() <= k.maxQty(), "qty " + l);
                            value += (long) crop.sellPrice() * l.qty();
                        }
                        assertEquals((long) Math.floor(value * 1.15 + 1e-9), spec.get().coins(), "coins = 1.15 × plain sell value");
                        assertEquals(spec.get().lines().size(), spec.get().lines().stream().map(Line::cropCode).distinct().count());
                    }
                }
            }
        }

        @Test
        void noOrderWhenNothingFitsOrTheLevelIsTooLow() {
            Instant lateNight = Instant.parse("2026-10-09T16:55:00Z"); // 23:55 Vietnam: five minutes left in the day
            assertTrue(ORDERS.generate(7, 1, lateNight, 10, 10).isEmpty(), "nothing grows in 2.5 minutes");
            assertTrue(ORDERS.generate(7, 3, T0, 2, 6).isEmpty(), "weekly orders start at level 3");
            assertTrue(ORDERS.generate(7, 3, T0, 3, 6).isPresent());
            assertTrue(ORDERS.generate(7, 1, T0, 1, 0).isEmpty(), "no beds, no order");
        }

        @Test
        void weeklyOrdersAskForGoodProduceFromLevelEightAndCarryTheirBonus() {
            var low = ORDERS.generate(9, 3, T0, 7, 8).orElseThrow();
            assertTrue(low.lines().stream().allMatch(l -> l.minTier().equals("NORMAL")));
            var high = ORDERS.generate(9, 3, T0, 8, 8).orElseThrow();
            assertEquals("GOOD", high.lines().getFirst().minTier());
            assertEquals(1, high.bonus().get("FERTILIZER_PREMIUM"));
            assertTrue(high.bonus().keySet().stream().anyMatch(k -> k.startsWith("SEED:")), "weekly order adds rare seeds");
            var daily = ORDERS.generate(9, 1, T0, 8, 8).orElseThrow();
            assertFalse(daily.bonus().containsKey("FERTILIZER"), "daily orders never duplicate the skill-lesson fertilizer");
            assertFalse(daily.bonus().containsKey("WATER"), "or the Flashcard water");
            assertTrue(daily.bonus().values().stream().allMatch(q -> q == 2));
        }

        @Test
        void deliveriesMustMatchExactly() {
            var lines = List.of(new Line("CORN", 5, "NORMAL"), new Line("ROSE", 3, "GOOD"));
            assertTrue(ORDERS.matches(lines, List.of(new Supply("CORN", "NORMAL", 2), new Supply("CORN", "PERFECT", 3),
                    new Supply("ROSE", "GOOD", 3))).ok(), "tiers may be mixed when each is accepted");
            assertEquals("ORDER_LINES_MISMATCH", ORDERS.matches(lines, List.of(new Supply("CORN", "NORMAL", 5),
                    new Supply("ROSE", "GOOD", 2))).code(), "too few");
            assertEquals("ORDER_LINES_MISMATCH", ORDERS.matches(lines, List.of(new Supply("CORN", "NORMAL", 6),
                    new Supply("ROSE", "GOOD", 3))).code(), "too many");
            assertEquals("ORDER_LINES_MISMATCH", ORDERS.matches(lines, List.of(new Supply("CORN", "NORMAL", 5),
                    new Supply("ROSE", "GOOD", 3), new Supply("WHEAT", "NORMAL", 1))).code(), "nothing extra");
            assertEquals("ORDER_TIER_TOO_LOW", ORDERS.matches(lines, List.of(new Supply("CORN", "NORMAL", 5),
                    new Supply("ROSE", "NORMAL", 3))).code());
            assertEquals("ORDER_LINES_MISMATCH", ORDERS.matches(lines, List.of(new Supply("CORN", "SHINY", 5),
                    new Supply("ROSE", "GOOD", 3))).code(), "unknown tier");
        }

        @Test
        void thePreviewUsesTheLowestAcceptedTiersFirst() {
            var lines = List.of(new Line("CORN", 4, "NORMAL"), new Line("ROSE", 2, "GOOD"));
            Map<String, Map<String, Integer>> stock = Map.of("CORN", Map.of("NORMAL", 1, "GOOD", 2, "GOLDEN", 5),
                    "ROSE", Map.of("NORMAL", 9, "PERFECT", 3));
            assertEquals(List.of(new Supply("CORN", "NORMAL", 1), new Supply("CORN", "GOOD", 2), new Supply("CORN", "GOLDEN", 1),
                    new Supply("ROSE", "PERFECT", 2)), ORDERS.allocate(lines, stock).orElseThrow());
            assertTrue(ORDERS.allocate(List.of(new Line("ROSE", 4, "GOOD")), stock).isEmpty(), "NORMAL roses do not count");
        }

        @Test
        void theBlessingMultipliesTheDeliveryLikeASale() {
            assertEquals(1000, ORDERS.payout(1000, false));
            assertEquals(1500, ORDERS.payout(1000, true));
            assertEquals(1, ORDERS.payout(1, true), "floor");
        }
    }

    @Nested
    class Expansion {
        @Test
        void bedsAreTheFourOwnerApprovedCellsBoughtInOrder() {
            var plots = ECONOMY.expansion().plots();
            assertEquals(List.of(7, 8, 9, 10), plots.stream().map(FarmEconomyRules.ExpansionPlot::slot).toList());
            assertEquals(List.of(List.of(8, 16), List.of(9, 16), List.of(10, 16), List.of(6, 18)),
                    plots.stream().map(p -> List.of(p.gx(), p.gy())).toList());
            assertEquals(7, ECONOMY.expansion().next(Set.of(1, 2, 3, 4, 5, 6)).orElseThrow().slot());
            assertEquals(9, ECONOMY.expansion().next(Set.of(7, 8)).orElseThrow().slot());
            assertTrue(ECONOMY.expansion().next(Set.of(7, 8, 9, 10)).isEmpty());
            for (int i = 1; i < plots.size(); i++) {
                assertTrue(plots.get(i).level() > plots.get(i - 1).level() && plots.get(i).coins() > plots.get(i - 1).coins());
            }
        }

        @Test
        void compostIsExactAndAcceptsAnyTier() {
            var compost = Map.of("TOMATO", 6, "CORN", 6);
            assertTrue(ORDERS.compostMatches(compost, List.of(new Supply("TOMATO", "GOLDEN", 6), new Supply("CORN", "NORMAL", 4),
                    new Supply("CORN", "GOOD", 2))).ok());
            assertEquals("COMPOST_MISMATCH", ORDERS.compostMatches(compost, List.of(new Supply("TOMATO", "NORMAL", 6))).code());
            assertEquals("COMPOST_MISMATCH", ORDERS.compostMatches(compost, List.of(new Supply("TOMATO", "NORMAL", 6),
                    new Supply("CORN", "NORMAL", 6), new Supply("WHEAT", "NORMAL", 1))).code());
        }
    }
}
