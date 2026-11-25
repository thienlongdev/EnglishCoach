package com.englishcoach.garden.domain;

/**
 * The rule set plus the pure calculators built on it (one instance per loaded configuration). Phase 3A adds the farm
 * economy ({@code economy}, {@code market}, {@code orders}); they are null only for an engine built from Phase 1–2 rules
 * alone (pure domain tests).
 */
public record GardenEngine(GardenRules rules, GardenCalendar calendar, GrowthCalculator growth,
                           QualityCalculator quality, RewardEngine rewards, LevelCurve levels,
                           ChallengeGenerator challenges, WeatherCalendar weather, KnowledgeEvaluator knowledge,
                           PestPlanner pests, FarmEconomyRules economy, MarketEngine market, OrderEngine orders) {

    public static GardenEngine of(GardenRules rules) {
        return of(rules, null);
    }

    public static GardenEngine of(GardenRules rules, FarmEconomyRules economy) {
        return new GardenEngine(rules, new GardenCalendar(rules), new GrowthCalculator(rules),
                new QualityCalculator(rules), new RewardEngine(rules), new LevelCurve(rules),
                new ChallengeGenerator(rules), new WeatherCalendar(rules), new KnowledgeEvaluator(rules),
                new PestPlanner(rules), economy,
                economy == null ? null : new MarketEngine(rules, economy),
                economy == null ? null : new OrderEngine(rules, economy));
    }
}
