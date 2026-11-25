package com.englishcoach.garden.domain;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Phase 3H rules of livestock and guardian pets ({@code garden_config.animals}, V89). Numbers only — the decisions are
 * {@link AnimalEngine}.
 */
public record AnimalRules(Feed feed, Water water, int restGrowthBp, Map<String, House> houses, Map<String, Livestock> livestock,
                          Map<String, Product> products, Compost compost, Map<String, Guardian> guardians) {

    public static final String DOG = "DOG";
    public static final String GOOSE = "GOOSE";
    public static final String CAT = "CAT";

    /**
     * {@code mill}: feed units one produce unit of a crop gives. {@code maxHours}: food never reaches further ahead than
     * this. {@code learningBonusBp}: a ration given on a day whose learning goal is met lasts this much longer.
     */
    public record Feed(String item, Map<String, Integer> mill, int maxHours, int learningBonusBp) {}

    /** One {@code item} refills a house's trough for {@code hours}; refused while more than {@code refillBelowHours} is left. */
    public record Water(String item, int hours, int refillBelowHours) {}

    public record House(String code, String nameVi, String species, int minLevel, long coins, int capacity) {}

    /**
     * {@code growHours} of cared-for time to adulthood; one ration ({@code rationFeed} feed) lasts {@code rationHours};
     * an adult gives one {@code product} per {@code productHours} of cared-for time and holds at most {@code storeCap}.
     */
    public record Livestock(String species, String nameVi, String babyVi, long coins, int growHours, int rationFeed, int rationHours,
                            String product, int productHours, int storeCap) {

        public long growSeconds() {
            return growHours * 3600L;
        }

        public long productSeconds() {
            return productHours * 3600L;
        }

        public long storeSeconds() {
            return productSeconds() * storeCap;
        }
    }

    public record Product(String code, String nameVi, long sell) {}

    public record Compost(String product, int manure, String gives, int dailyCap) {}

    /**
     * A guardian works only while it is fed. DOG: {@code cooldownHours} between two visitors turned away and
     * {@code shieldHours} of guarding afterwards; GOOSE: {@code graceMinutes} added to the owner's head start on a crop
     * that just ripened; CAT: {@code pestCapReduction} fewer Forgotten Pests on crops at once.
     */
    public record Guardian(String species, String nameVi, int minLevel, long coins, int rationFeed, int rationHours,
                           int cooldownHours, int shieldHours, int graceMinutes, int pestCapReduction) {}

    public AnimalRules {
        if (restGrowthBp < 0 || restGrowthBp > 10_000) throw new IllegalArgumentException("animals.restGrowthBp must be within 0..10000");
        if (feed.maxHours() < 1 || water.hours() < 1) throw new IllegalArgumentException("animals feed / water hours must be positive");
        for (House h : houses.values()) {
            if (h.capacity() < 1 || h.capacity() > 4) throw new IllegalArgumentException("animals house capacity must be within 1..4");
            if (!livestock.containsKey(h.species())) throw new IllegalArgumentException("animals house of an unknown species " + h.species());
        }
        for (Livestock l : livestock.values()) {
            if (l.growHours() < 1 || l.productHours() < 1 || l.storeCap() < 1 || l.rationHours() < 1 || l.rationFeed() < 1) {
                throw new IllegalArgumentException("animals livestock numbers must be positive: " + l.species());
            }
            if (!products.containsKey(l.product())) throw new IllegalArgumentException("animals livestock gives an unknown product " + l.product());
        }
    }

    public Duration feedHorizon() {
        return Duration.ofHours(feed.maxHours());
    }

    /** The house a species lives in, or null. */
    public House houseOf(String species) {
        return houses.values().stream().filter(h -> h.species().equals(species)).findFirst().orElse(null);
    }

    static <K, V> Map<K, V> ordered(List<V> values, java.util.function.Function<V, K> key) {
        Map<K, V> out = new LinkedHashMap<>();
        values.forEach(v -> out.put(key.apply(v), v));
        return java.util.Collections.unmodifiableMap(out);
    }

    public static AnimalRules of(Feed feed, Water water, int restGrowthBp, List<House> houses, List<Livestock> livestock,
                                 List<Product> products, Compost compost, List<Guardian> guardians) {
        return new AnimalRules(feed, water, restGrowthBp, ordered(houses, House::code), ordered(livestock, Livestock::species),
                ordered(products, Product::code), compost, ordered(guardians, Guardian::species));
    }
}
