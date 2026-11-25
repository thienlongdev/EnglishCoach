package com.englishcoach.garden;

import com.englishcoach.garden.domain.CosmeticRules;
import com.englishcoach.garden.domain.CosmeticRules.Facts;
import com.englishcoach.garden.domain.CosmeticRules.Item;
import com.englishcoach.garden.domain.CosmeticRules.Spot;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 3E without a database: the reviewed catalogue ({@code garden/phase3e_catalogue.json}, the source the V86 seed
 * was generated from) meets the owner's minimums, its prices follow the documented bands, and the pure rules decide
 * eligibility and decoration placement correctly.
 */
class GardenPhase3EDomainTest {

    static JsonNode catalogue;
    static CosmeticRules rules;

    @BeforeAll
    static void load() throws Exception {
        try (var in = GardenPhase3EDomainTest.class.getResourceAsStream("/garden/phase3e_catalogue.json")) {
            catalogue = new ObjectMapper().readTree(in);
        }
        rules = fromCatalogue(catalogue);
    }

    /** The rule set the server builds from the V86 rows, built here from the same reviewed source. */
    static CosmeticRules fromCatalogue(JsonNode c) {
        Map<String, CosmeticRules.CollectionDef> collections = new LinkedHashMap<>();
        for (JsonNode n : c.get("collections")) {
            collections.put(n.get("code").asText(), new CosmeticRules.CollectionDef(n.get("code").asText(), n.get("nameVi").asText(),
                    n.get("descriptionVi").asText(), n.get("sortOrder").asInt()));
        }
        Map<String, Item> items = new LinkedHashMap<>();
        for (JsonNode n : c.get("cosmetics")) {
            items.put(n.get("code").asText(), new Item(n.get("code").asText(), n.get("category").asText(), n.get("family").asText(),
                    n.get("collection").asText(), n.get("nameVi").asText(), n.get("descriptionVi").asText(), n.get("artKey").asText(),
                    n.get("unlockKind").asText(), n.get("coinPrice").asLong(), n.get("requirement").asInt(), n.get("maxOwned").asInt(),
                    n.get("footprint").asDouble(), n.get("sortOrder").asInt()));
        }
        Map<String, String> skins = new LinkedHashMap<>();
        for (JsonNode n : c.get("skins")) skins.put(n.get("code").asText(), n.get("collection").asText());
        List<CosmeticRules.Region> regions = new ArrayList<>();
        for (JsonNode r : c.get("config").get("regions")) {
            regions.add(new CosmeticRules.Region(r.get("code").asText(), r.get("nameVi").asText(), r.get("rect").get(0).asDouble(),
                    r.get("rect").get(1).asDouble(), r.get("rect").get(2).asDouble(), r.get("rect").get(3).asDouble()));
        }
        return new CosmeticRules(collections, items, skins, c.get("config").get("maxPlaced").asInt(), c.get("config").get("snap").asDouble(), regions);
    }

    // ------------------------------------------------------------------ the owner's minimums

    @Test
    void everyCropHasFiveNewCultivarsWithItsOwnArtKey() {
        Map<String, Integer> perCrop = new TreeMap<>();
        List<String> arts = new ArrayList<>();
        for (JsonNode s : catalogue.get("skins")) {
            perCrop.merge(s.get("cropCode").asText(), 1, Integer::sum);
            arts.add(s.get("artKey").asText());
            assertEquals(s.get("code").asText().toLowerCase(), s.get("artKey").asText(), "art key = lower-case code");
            assertTrue(s.get("artKey").asText().startsWith(s.get("cropCode").asText().toLowerCase() + "_"), "the art key names its crop");
        }
        assertEquals(List.of("CORN", "CRYSTAL_ORCHID", "FROST_LILY", "MOONFLOWER", "PUMPKIN", "ROSE", "STRAWBERRY", "TOMATO", "WATERMELON", "WHEAT"),
                List.copyOf(perCrop.keySet()), "all ten crops");
        perCrop.forEach((crop, n) -> assertEquals(5, n, crop + " has five new cultivars"));
        assertEquals(50, arts.stream().distinct().count(), "fifty distinct cultivars (never an alias of another)");
        // none of the six earlier cultivars is counted again
        for (String old : List.of("wheat_dusk", "tomato_amber", "corn_gem", "strawberry_snow", "rose_moon", "pumpkin_jade", "watermelon_echo")) {
            assertFalse(arts.contains(old), old + " is a Phase 3B / 3C cultivar");
        }
    }

    @Test
    void everyCosmeticFamilyHasAtLeastFiveChoices() {
        Map<String, Long> perCategory = new TreeMap<>();
        Map<String, Long> perDecorFamily = new TreeMap<>();
        for (Item i : rules.items().values()) {
            perCategory.merge(i.category(), 1L, Long::sum);
            if (i.placeable()) perDecorFamily.merge(i.family(), 1L, Long::sum);
        }
        for (String slot : CosmeticRules.SLOTS) assertTrue(perCategory.getOrDefault(slot, 0L) >= 5, slot + " has five choices: " + perCategory);
        assertEquals(List.of("BENCH", "LANTERN", "PLANTER", "SIGN", "STATUE"), List.copyOf(perDecorFamily.keySet()));
        perDecorFamily.forEach((family, n) -> assertTrue(n >= 5, family + " has five decorations"));
        assertEquals(25, perCategory.get("DECOR"));
        // art keys are unique inside a category (one item = one appearance)
        Map<String, Long> art = new TreeMap<>();
        rules.items().values().forEach(i -> art.merge(i.category() + ":" + i.artKey(), 1L, Long::sum));
        art.forEach((k, n) -> assertEquals(1L, n, k));
    }

    @Test
    void everyItemBelongsToACollectionAndEveryCollectionIsUsed() {
        Map<String, Integer> used = new TreeMap<>();
        rules.items().values().forEach(i -> used.merge(i.collection(), 1, Integer::sum));
        rules.skinCollections().values().forEach(c -> used.merge(c, 1, Integer::sum));
        assertEquals(rules.collections().keySet(), used.keySet());
        used.forEach((c, n) -> assertTrue(n >= 5, "collection " + c + " is a real set, not a label (" + n + " pieces)"));
        // the four seasons, the Vietnamese festivals and the dragon / phoenix set all exist
        assertTrue(rules.collections().keySet().containsAll(List.of("BLOSSOM", "SUNGOLD", "AMBER", "FROST", "TET", "TRUNGTHU", "LONGPHUNG", "CELESTIAL")));
    }

    // ------------------------------------------------------------------ prices and earned paths

    @Test
    void coinItemsHaveAPriceAndEarnedItemsCannotBeBought() {
        for (Item i : rules.items().values()) {
            if (i.coin()) {
                assertTrue(i.coinPrice() >= 1_500 && i.coinPrice() % 500 == 0, i.code() + " price " + i.coinPrice());
                assertEquals(0, i.requirement(), i.code());
            } else {
                assertEquals(0, i.coinPrice(), i.code() + " is earned, never sold");
                assertTrue(i.requirement() > 0, i.code());
            }
            assertTrue(i.maxOwned() == 1 || i.placeable(), i.code() + ": only decorations repeat");
        }
        for (JsonNode s : catalogue.get("skins")) {
            boolean coin = s.get("unlockKind").asText().equals("COIN");
            assertEquals(coin, s.get("coinPrice").asLong() > 0, s.get("code").asText());
            // a cultivar never bypasses its crop: the crop must have been harvested (mastery tier >= 1) on every path
            assertTrue(s.get("masteryTier").asInt() >= 1, s.get("code").asText() + " needs its crop grown first");
        }
    }

    @Test
    void thePriceBandsReachFromAStarterToAnAspiration() {
        List<Long> prices = rules.items().values().stream().filter(Item::coin).map(Item::coinPrice).sorted().toList();
        long starters = prices.stream().filter(p -> p <= 5_000).count();
        long regular = prices.stream().filter(p -> p > 5_000 && p <= 30_000).count();
        long premium = prices.stream().filter(p -> p > 30_000 && p <= 120_000).count();
        long aspirational = prices.stream().filter(p -> p > 120_000).count();
        assertTrue(starters >= 6, "starter band: " + starters);
        assertTrue(regular >= 20, "regular band: " + regular);
        assertTrue(premium >= 12, "premium band: " + premium);
        assertTrue(aspirational >= 4, "aspirational band: " + aspirational);
        // modelled income (PHASE3D_ECONOMY_SIM_RESULTS §6): a normal learner nets about 3,200 a day in month 1, a returner 850
        long firstWeekReturner = 850L * 7;
        assertTrue(prices.stream().filter(p -> p <= firstWeekReturner).count() >= 6, "even a returning player can afford starters in week one");
        long monthNormal = 3_200L * 30;
        assertTrue(prices.stream().filter(p -> p <= monthNormal).count() >= prices.size() * 0.75, "three quarters of the coin items cost under a month of an ordinary learner");
        // every slot has an entry-level choice under a fortnight of an ordinary learner, so no category is paywalled by time
        for (String slot : CosmeticRules.SLOTS) {
            long cheapest = rules.items().values().stream().filter(i -> i.category().equals(slot) && i.coin()).mapToLong(Item::coinPrice).min().orElseThrow();
            assertTrue(cheapest <= 3_200L * 21, slot + " cheapest " + cheapest);
        }
        // earned exclusives exist in every kind and include genuine learning milestones
        assertTrue(rules.items().values().stream().filter(i -> i.unlockKind().equals("LEARNING")).count() >= 4);
        assertTrue(rules.items().values().stream().anyMatch(i -> i.unlockKind().equals("HARVESTS")));
        assertTrue(rules.items().values().stream().anyMatch(i -> i.unlockKind().equals("GRADUATIONS")));
    }

    @Test
    void eligibilityComesFromStoredFactsOnly() {
        Item whale = rules.item("DECOR_STATUE_WHALE");
        assertEquals("LEARNING", whale.unlockKind());
        var locked = rules.check(whale, new Facts(6, 9_999, 99), 9_999_999);
        assertFalse(locked.requirementOk(), "coins and other facts never substitute for learning days");
        assertEquals(6, locked.progress());
        assertEquals(0, locked.price());
        assertTrue(rules.check(whale, new Facts(7, 0, 0), 0).ok(), "seven verified days: claimable with an empty purse");

        Item holly = rules.item("SHRUB_HOLLY");
        assertFalse(rules.check(holly, new Facts(500, 299, 0), 0).requirementOk());
        assertTrue(rules.check(holly, new Facts(0, 300, 0), 0).ok());
        Item moonlily = rules.item("FLOWER_MOONLILY");
        assertFalse(rules.check(moonlily, new Facts(500, 500, 0), 0).requirementOk());
        assertTrue(rules.check(moonlily, new Facts(0, 0, 1), 0).ok());

        Item house = rules.item("HOUSE_LONGPHUNG");
        var poor = rules.check(house, new Facts(0, 0, 0), 319_999);
        assertTrue(poor.requirementOk());
        assertFalse(poor.coinsOk());
        assertEquals(320_000, poor.price());
        assertTrue(rules.check(house, new Facts(0, 0, 0), 320_000).ok());
        assertNull(rules.item("HOUSE_CLASSIC"), "the island's own cottage is not an item");
        assertNull(rules.item(null));
    }

    // ------------------------------------------------------------------ decoration placement

    @Test
    void aDecorationStandsOnlyOnTheGridInsideARegionAndClearOfOthers() {
        Item lantern = rules.item("DECOR_LANTERN_STONE");   // footprint 0.35
        Item bench = rules.item("DECOR_BENCH_SWING");        // footprint 0.7
        assertEquals(Optional.empty(), rules.placementError(lantern, 9.0, 25.25, List.of()));
        assertEquals("SOUTH_SHORE", rules.regionAt(9.0, 25.25).orElseThrow().code());
        assertEquals(Optional.of("DECOR_OFF_GRID"), rules.placementError(lantern, 9.1, 25.25, List.of()));
        assertEquals(Optional.of("DECOR_OFF_GRID"), rules.placementError(lantern, Double.NaN, 25.25, List.of()));
        // the fenced farm, the pond, the cottage and the Knowledge Tree are in no region
        for (double[] p : new double[][]{{8.0, 18.0}, {5.5, 10.5}, {14.5, 7.25}, {23.5, 18.5}, {12.5, 12.5}, {0.0, 0.0}, {26.0, 26.0}}) {
            assertEquals(Optional.of("DECOR_OUT_OF_BOUNDS"), rules.placementError(lantern, p[0], p[1], List.of()), p[0] + "," + p[1]);
        }
        // two lanterns need 0.7 between their anchors; a lantern and a swing need 1.05
        List<Spot> one = List.of(new Spot(1, 9.0, 25.25, lantern.footprint()));
        assertEquals(Optional.of("DECOR_OVERLAP"), rules.placementError(lantern, 9.5, 25.25, one));
        assertEquals(Optional.empty(), rules.placementError(lantern, 9.75, 25.25, one));
        assertEquals(Optional.of("DECOR_OVERLAP"), rules.placementError(bench, 10.0, 25.25, one));
        assertEquals(Optional.empty(), rules.placementError(bench, 10.25, 25.25, one));
        assertEquals(Optional.of("DECOR_OVERLAP"), rules.placementError(lantern, 9.0, 25.25, one), "the same point twice");
    }

    @Test
    void decorationRegionsStayClearOfEveryProtectedPartOfTheIsland() {
        // protected rectangles in grid cells (layout facts): the fenced farm with all 24 bed cells, the cottage with its
        // wing / porch / pergola, the Knowledge Tree's sanctuary, the memory grove, the pond (its water and pier)
        double[][] keepOut = {{3.25, 15.65, 12.75, 23.7}, {11.7, 5.7, 17.3, 9.5}, {20.4, 15.8, 26.2, 21.0}, {16.1, 17.5, 19.4, 21.9}, {3.45, 6.84, 7.64, 13.81},
                {6.9, 10.75, 8.05, 11.1}};
        for (CosmeticRules.Region r : rules.regions()) {
            assertTrue(r.x1() > r.x0() && r.y1() > r.y0(), r.code());
            for (double[] k : keepOut) {
                boolean apart = r.x1() < k[0] || r.x0() > k[2] || r.y1() < k[1] || r.y0() > k[3];
                assertTrue(apart, r.code() + " overlaps a protected area " + java.util.Arrays.toString(k));
            }
            assertTrue(rules.snapped(r.x0()) && rules.snapped(r.y0()) && rules.snapped(r.x1()) && rules.snapped(r.y1()), r.code() + " is on the grid");
        }
        for (int i = 0; i < rules.regions().size(); i++) {
            for (int j = i + 1; j < rules.regions().size(); j++) {
                var a = rules.regions().get(i);
                var b = rules.regions().get(j);
                assertTrue(a.x1() < b.x0() || a.x0() > b.x1() || a.y1() < b.y0() || a.y0() > b.y1(), a.code() + " / " + b.code() + " are disjoint");
            }
        }
        assertEquals(0.25, rules.snap());
        assertTrue(rules.maxPlaced() >= 20 && rules.maxPlaced() <= 40, "a bounded scene budget");
        // room: decorations 0.75 apart (two of the smallest need 0.7) on every region; the budget must really fit
        int spots = rules.regions().stream().mapToInt(r -> ((int) Math.floor((r.x1() - r.x0()) / 0.75) + 1) * ((int) Math.floor((r.y1() - r.y0()) / 0.75) + 1)).sum();
        assertTrue(spots >= rules.maxPlaced(), "the regions hold the whole budget: " + spots + " spots for " + rules.maxPlaced());
        assertEquals(10, rules.regions().size());
    }
}
