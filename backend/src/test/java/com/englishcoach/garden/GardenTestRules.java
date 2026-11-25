package com.englishcoach.garden;

import com.englishcoach.garden.domain.GardenRules;
import com.englishcoach.garden.domain.GardenRules.BoostItem;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GardenRules.QualityTier;
import com.englishcoach.garden.domain.GardenRules.Rarity;
import com.englishcoach.garden.domain.GardenRules.Season;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The V77 seed as a plain fixture for fast domain tests. {@code GardenPersistenceTest} loads the real migration and
 * asserts {@link #equivalent} so this fixture can never drift from production configuration.
 */
public final class GardenTestRules {

    private GardenTestRules() {}

    /**
     * The exact Phase 2 configuration (V77 + V78, before V80 tightened the harvest-XP band from 120 to 90 raw XP):
     * the historical Phase 2 acceptance ({@code EconomySimulatorTest}) keeps asserting it unchanged.
     */
    public static GardenRules phase2() {
        GardenRules r = seeded();
        Parts p = parts(r);
        var w = r.rewards();
        p.rewards = new GardenRules.Rewards(w.unitsPerWater(), w.diminishing(), w.reviewUnit(), w.repeatSameDayUnit(),
                w.xpPerUnit(), w.goalUnits(), w.goalDueMinReviews(), w.goalXp(), w.goalMixUnits(), w.goalMixSkills(),
                List.of(new double[]{40, 1.0}, new double[]{120, 0.4}, new double[]{999999, 0.05}));
        return p.build();
    }

    /** The current seeded configuration: V77 + V78 + V80 (harvest-XP band 40 / 90). */
    public static GardenRules seeded() {
        Map<String, CropDef> crops = new LinkedHashMap<>();
        add(crops, "WHEAT", "Lúa mì", Rarity.COMMON, 1200, 5, 0, 15, Season.ALL, 1, 4, true, false, 1);
        add(crops, "TOMATO", "Cà chua", Rarity.COMMON, 2700, 15, 0, 38, Season.ALL, 1, 6, true, false, 2);
        add(crops, "CORN", "Ngô", Rarity.COMMON, 5400, 25, 0, 70, Season.ALL, 2, 9, true, false, 3);
        add(crops, "STRAWBERRY", "Dâu tây", Rarity.RARE, 7200, 40, 0, 102, Season.LU_HANH, 3, 15, true, false, 4);
        add(crops, "ROSE", "Hoa hồng", Rarity.RARE, 14400, 70, 0, 192, Season.LU_HANH, 4, 25, true, false, 5);
        add(crops, "WATERMELON", "Dưa hấu", Rarity.RARE, 18000, 90, 0, 240, Season.CONG_SO, 6, 30, true, false, 6);
        add(crops, "PUMPKIN", "Bí ngô", Rarity.RARE, 21600, 110, 0, 290, Season.HOC_THUAT, 8, 35, true, false, 7);
        // V78: Epic seeds cost real essence; the legendary orchid is planted from a graduation seed at any level
        add(crops, "MOONFLOWER", "Hoa Trăng", Rarity.EPIC, 28800, 180, 5, 420, Season.HOC_THUAT, 10, 50, true, false, 8);
        add(crops, "FROST_LILY", "Huệ Băng", Rarity.EPIC, 36000, 220, 8, 520, Season.THANH_NGU, 12, 60, true, false, 9);
        add(crops, "CRYSTAL_ORCHID", "Lan Pha Lê", Rarity.LEGENDARY, 64800, 400, 15, 940, Season.THANH_NGU, 1, 120, false, false, 10);
        add(crops, "QA_SPROUT", "Mầm thử nghiệm", Rarity.COMMON, 60, 0, 0, 0, Season.ALL, 1, 0, true, true, 99);

        Map<String, BoostItem> boosts = new LinkedHashMap<>();
        boosts.put("WATER", new BoostItem("WATER", "Nước", "WATER", 0.04, 3, 45));
        boosts.put("FERTILIZER", new BoostItem("FERTILIZER", "Phân bón", "FERTILIZER", 0.10, 1, 120));
        boosts.put("FERTILIZER_PREMIUM", new BoostItem("FERTILIZER_PREMIUM", "Phân bón Thượng hạng", "FERTILIZER", 0.20, 1, 260));

        var tiers = List.of(new QualityTier("NORMAL", 0, 1.0, 1.0), new QualityTier("GOOD", 50, 1.15, 1.10),
                new QualityTier("PERFECT", 75, 1.35, 1.25), new QualityTier("GOLDEN", 95, 1.75, 1.50));
        return new GardenRules(
                ZoneId.of("Asia/Ho_Chi_Minh"),
                new GardenRules.Growth(0.40, 0.5, 1.25, 0.70, 1.0, 60, "WHEAT", new double[]{0.10, 0.45}, 7),
                new GardenRules.Seasons(LocalDate.parse("2026-10-05"),
                        List.of(Season.LU_HANH, Season.CONG_SO, Season.HOC_THUAT, Season.THANH_NGU)),
                new GardenRules.Quality(tiers, 10, 25, 10, 20, 10, 0, 15, 10, 2, 0.5, 0.03, 19, 5, 20),
                new GardenRules.Rewards(5, List.of(new double[]{20, 1.0}, new double[]{40, 0.7}, new double[]{999999, 0.3}),
                        1, 0, 2, 20, 5, 30, 10, 1,
                        List.of(new double[]{40, 1.0}, new double[]{90, 0.4}, new double[]{999999, 0.05})),
                new GardenRules.Level(30, 1.55, 20),
                new GardenRules.Challenge(3, 1, 4, 300, 14),
                new GardenRules.Starter(200, Map.of("WATER", 3, "FERTILIZER", 1, "SEED:WHEAT", 4, "SEED:TOMATO", 2),
                        List.of(new GardenRules.Cell(8, 18), new GardenRules.Cell(9, 18), new GardenRules.Cell(10, 18),
                                new GardenRules.Cell(8, 19), new GardenRules.Cell(9, 19), new GardenRules.Cell(10, 19))),
                1.5, 1.0, Map.copyOf(crops), Map.copyOf(boosts), weather(), pests(), knowledge(), learning());
    }

    /** Mutable copy of a rule set for what-if variants in tests (records have no withers). */
    public static final class Parts {
        public java.time.ZoneId zone; public GardenRules.Growth growth; public GardenRules.Seasons seasons;
        public GardenRules.Quality quality; public GardenRules.Rewards rewards; public GardenRules.Level level;
        public GardenRules.Challenge challenge; public GardenRules.Starter starter; public double blessing;
        public double coinScale; public Map<String, CropDef> crops; public Map<String, BoostItem> boosts;
        public GardenRules.WeatherRules weather; public GardenRules.PestRules pests;
        public GardenRules.KnowledgeRules knowledge; public GardenRules.LearningRules learning;

        public GardenRules build() {
            return new GardenRules(zone, growth, seasons, quality, rewards, level, challenge, starter, blessing, coinScale,
                    crops, boosts, weather, pests, knowledge, learning);
        }
    }

    public static Parts parts(GardenRules r) {
        Parts p = new Parts();
        p.zone = r.zone(); p.growth = r.growth(); p.seasons = r.seasons(); p.quality = r.quality(); p.rewards = r.rewards();
        p.level = r.level(); p.challenge = r.challenge(); p.starter = r.starter(); p.blessing = r.blessingSellMultiplier();
        p.coinScale = r.coinScale(); p.crops = r.crops(); p.boosts = r.boosts(); p.weather = r.weather(); p.pests = r.pests();
        p.knowledge = r.knowledge(); p.learning = r.learning();
        return p;
    }

    /**
     * The Phase 2 systems with the V77 balance values (before calibration): no harvest-XP schedule, 15 XP per skill
     * lesson, the first essence draft (1/2/3 per day, 2-day store, 6 per graduation) and the V77 Epic / Legendary rows.
     */
    public static GardenRules uncalibrated() {
        GardenRules r = seeded();
        Parts p = parts(r);
        var w = r.rewards();
        p.rewards = new GardenRules.Rewards(w.unitsPerWater(), w.diminishing(), w.reviewUnit(), w.repeatSameDayUnit(),
                w.xpPerUnit(), w.goalUnits(), w.goalDueMinReviews(), w.goalXp(), w.goalMixUnits(), w.goalMixSkills(),
                List.of(new double[]{999999, 1.0}));
        Map<String, CropDef> crops = new LinkedHashMap<>(r.crops());
        crops.put("MOONFLOWER", copy(r.crop("MOONFLOWER"), 2, 10));
        crops.put("FROST_LILY", copy(r.crop("FROST_LILY"), 3, 12));
        crops.put("CRYSTAL_ORCHID", copy(r.crop("CRYSTAL_ORCHID"), 15, 15));
        p.crops = Map.copyOf(crops);
        var k = r.knowledge();
        var g = k.graduation();
        p.knowledge = new GardenRules.KnowledgeRules(k.slotLevels(), k.cards(), k.evidenceCap(), k.stages(),
                new GardenRules.Graduation(g.minAgeDays(), g.minPerCard(), g.questions(), g.reverseQuestions(), g.pass(),
                        g.retryMinutes(), g.xp(), 6, g.items()), new double[]{0, 0, 1, 2, 3}, 2, k.candidateLimit());
        var l = r.learning();
        p.learning = new GardenRules.LearningRules(l.sources(), Map.of("SKILL", new GardenRules.CategoryRule(15, 3, 2),
                "GAME", l.categories().get("GAME")), l.lookbackDays(), l.batchLimit());
        return p.build();
    }

    public static CropDef copy(CropDef c, int seedEssence, int unlockLevel) {
        return new CropDef(c.code(), c.nameVi(), c.rarity(), c.baseSeconds(), c.seedPrice(), seedEssence, c.sellPrice(),
                c.season(), unlockLevel, c.harvestXp(), c.seedInFixedShop(), c.qaOnly(), c.sortOrder());
    }

    /** The seed with every rain chance at zero (isolates season / care arithmetic from the weather timeline). */
    public static GardenRules withoutWeather(GardenRules r) {
        Parts p = parts(r);
        Map<Season, double[]> none = new java.util.EnumMap<>(Season.class);
        r.weather().chances().keySet().forEach(k -> none.put(k, new double[]{0, 0}));
        var w = r.weather();
        p.weather = new GardenRules.WeatherRules(w.startAt(), w.windowHours(), w.rainSpeed(), w.rainbowMutation(),
                w.forecastWindows(), Map.copyOf(none));
        return p.build();
    }

    // ------------------------------------------------------------------ Phase 2 (V78)

    public static GardenRules.WeatherRules weather() {
        Map<Season, double[]> chances = new java.util.EnumMap<>(Season.class);
        chances.put(Season.LU_HANH, new double[]{0.35, 0.40});
        chances.put(Season.CONG_SO, new double[]{0.20, 0.35});
        chances.put(Season.HOC_THUAT, new double[]{0.30, 0.30});
        chances.put(Season.THANH_NGU, new double[]{0.30, 0.15});
        return new GardenRules.WeatherRules(java.time.Instant.parse("2026-10-04T17:00:00Z"), 4, 1.2, 0.15, 3, Map.copyOf(chances));
    }

    public static GardenRules.PestRules pests() {
        return new GardenRules.PestRules(24, 2, 0.8, 12, 30, 5, 6, 20);
    }

    public static GardenRules.KnowledgeRules knowledge() {
        return new GardenRules.KnowledgeRules(List.of(3, 5, 8), 5, 3,
                List.of(new GardenRules.StageRule(2, 5, 1, 0), new GardenRules.StageRule(3, 10, 4, 1),
                        new GardenRules.StageRule(4, 13, 9, 2)),
                new GardenRules.Graduation(14, 2, 5, 2, 4, 30, 120, 5, Map.of("SEED:CRYSTAL_ORCHID", 1)),
                new double[]{0, 0, 0.5, 1, 1}, 3, 80);
    }

    public static GardenRules.LearningRules learning() {
        Map<String, GardenRules.SourceRule> sources = new LinkedHashMap<>();
        for (String[] s : new String[][]{{"DICTATION", "SKILL", "true", "3"}, {"SHADOWING", "SKILL", "true", "3"},
                {"WRITING", "SKILL", "true", "30"}, {"EXAM", "SKILL", "true", "1"}, {"CARD_BLAST", "GAME", "true", "100"},
                {"WORD_CHAIN", "GAME", "true", "5"}, {"READING", "SKILL", "false", "0"}, {"ROLEPLAY", "SKILL", "false", "0"},
                {"LISTENING_WATCH", "SKILL", "false", "0"}, {"CARD_BLAST_PVP", "GAME", "false", "0"}}) {
            sources.put(s[0], new GardenRules.SourceRule(s[0], s[1], Boolean.parseBoolean(s[2]), Integer.parseInt(s[3])));
        }
        return new GardenRules.LearningRules(Map.copyOf(sources),
                Map.of("SKILL", new GardenRules.CategoryRule(30, 3, 2), "GAME", new GardenRules.CategoryRule(5, 2, 0)), 3, 50);
    }

    // ------------------------------------------------------------------ Phase 3A (V80)

    /** The V80 farm-economy seed; {@code GardenPhase3PersistenceTest} asserts the loaded configuration equals it. */
    public static com.englishcoach.garden.domain.FarmEconomyRules economy() {
        var market = new com.englishcoach.garden.domain.FarmEconomyRules.Market(List.of(
                new com.englishcoach.garden.domain.FarmEconomyRules.Staple("FERTILIZER", "Phân bón", 120, 2, 1),
                new com.englishcoach.garden.domain.FarmEconomyRules.Staple("FERTILIZER_PREMIUM", "Phân bón Thượng hạng", 260, 2, 5)),
                2, 5, 0.10, 1, 5);
        var daily = new com.englishcoach.garden.domain.FarmEconomyRules.OrderKind(1, 1, 2, 5, 3, 8, Map.of(), 2, 0);
        var weekly = new com.englishcoach.garden.domain.FarmEconomyRules.OrderKind(3, 2, 2, 1, 6, 12,
                Map.of("FERTILIZER_PREMIUM", 1), 3, 8);
        var orders = new com.englishcoach.garden.domain.FarmEconomyRules.Orders(2, 1, 1.15, 0.5, daily, weekly, 20);
        var expansion = new com.englishcoach.garden.domain.FarmEconomyRules.Expansion(List.of(
                new com.englishcoach.garden.domain.FarmEconomyRules.ExpansionPlot(7, 8, 16, "north_strip", 5, 3000, Map.of("WHEAT", 8)),
                new com.englishcoach.garden.domain.FarmEconomyRules.ExpansionPlot(8, 9, 16, "north_strip", 7, 12000, Map.of("TOMATO", 6, "CORN", 6)),
                new com.englishcoach.garden.domain.FarmEconomyRules.ExpansionPlot(9, 10, 16, "north_strip", 9, 30000, Map.of("CORN", 8, "STRAWBERRY", 5)),
                new com.englishcoach.garden.domain.FarmEconomyRules.ExpansionPlot(10, 6, 18, "west_tilled", 11, 60000, Map.of("CORN", 10, "ROSE", 5))));
        return new com.englishcoach.garden.domain.FarmEconomyRules(market, orders, expansion);
    }

    // ------------------------------------------------------------------ Phase 3B (V82)

    /** The V82 living-knowledge seed; {@code GardenPhase3BPersistenceTest} asserts the loaded configuration equals it. */
    public static com.englishcoach.garden.domain.LivingRules living() {
        var F = com.englishcoach.garden.domain.LivingRules.Family.class;
        Map<com.englishcoach.garden.domain.LivingRules.Family, String> families = new java.util.EnumMap<>(F);
        families.put(com.englishcoach.garden.domain.LivingRules.Family.VOCABULARY, "FLASHCARD");
        families.put(com.englishcoach.garden.domain.LivingRules.Family.LISTENING, "DICTATION");
        families.put(com.englishcoach.garden.domain.LivingRules.Family.SPEAKING, "SHADOWING");
        families.put(com.englishcoach.garden.domain.LivingRules.Family.WRITING, "WRITING");
        families.put(com.englishcoach.garden.domain.LivingRules.Family.EXAM, "EXAM");
        var monument = new com.englishcoach.garden.domain.LivingRules.Monument(5, 400, 36, 40, 12, families,
                List.of("CARD_BLAST", "WORD_CHAIN"), List.of(3, 20, 60), List.of(1, 5, 15), 3, List.of(
                new com.englishcoach.garden.domain.LivingRules.EraGate(1, 21, 0, 1),
                new com.englishcoach.garden.domain.LivingRules.EraGate(2, 75, 3, 3),
                new com.englishcoach.garden.domain.LivingRules.EraGate(3, 180, 10, 5),
                new com.englishcoach.garden.domain.LivingRules.EraGate(4, 365, 25, 7)), 100);
        var mastery = new com.englishcoach.garden.domain.LivingRules.Mastery(List.of(
                new com.englishcoach.garden.domain.LivingRules.MasteryTier(1, 1, 0, 0, 0),
                new com.englishcoach.garden.domain.LivingRules.MasteryTier(2, 10, 0, 0, 0),
                new com.englishcoach.garden.domain.LivingRules.MasteryTier(3, 30, 2, 0, 0),
                new com.englishcoach.garden.domain.LivingRules.MasteryTier(4, 75, 2, 3, 0),
                new com.englishcoach.garden.domain.LivingRules.MasteryTier(5, 150, 2, 4, 5)),
                Map.of(Rarity.COMMON, 1.0, Rarity.RARE, 0.6, Rarity.EPIC, 0.3, Rarity.LEGENDARY, 0.1));
        Map<String, com.englishcoach.garden.domain.LivingRules.SkinDef> skins = new LinkedHashMap<>();
        skin(skins, "WHEAT_DUSK", "WHEAT", "Lúa Tím Hoàng Hôn", "Bông lúa tím thẫm với râu vàng óng, thân nâu mận.", "MASTERY", 0, 4, 0, "wheat_dusk", 1);
        skin(skins, "TOMATO_AMBER", "TOMATO", "Cà Chua Hổ Phách", "Giống cà chua múi lớn màu hổ phách, chùm quả vàng mật.", "COIN", 24000, 1, 0, "tomato_amber", 2);
        skin(skins, "CORN_GEM", "CORN", "Bắp Ngọc Cầu Vồng", "Bắp hạt ngọc nhiều màu, bẹ tím mận và cờ đỏ rượu.", "LEARNING", 0, 1, 21, "corn_gem", 3);
        skin(skins, "STRAWBERRY_SNOW", "STRAWBERRY", "Dâu Tuyết", "Dâu trắng kem điểm hạt đỏ, hoa phớt hồng trên tán lá bạc hà.", "COIN", 60000, 1, 0, "strawberry_snow", 4);
        skin(skins, "ROSE_MOON", "ROSE", "Hồng Nguyệt Lam", "Hồng leo xanh ánh trăng quấn quanh giàn gỗ, toả sáng dịu khi đêm xuống.", "MASTERY", 0, 4, 0, "rose_moon", 5);
        skin(skins, "PUMPKIN_JADE", "PUMPKIN", "Bí Ngọc Bích", "Bí dẹt xanh ngọc nhiều múi sâu, cuống sần, lá viền bạc.", "COIN", 150000, 1, 0, "pumpkin_jade", 6);
        // V83 (Phase 3C): the one cultivar delivered by an Echo Reward (never sold, never earned by mastery)
        skin(skins, "WATERMELON_ECHO", "WATERMELON", "Dưa Hấu Sóng Echo", "Dưa vỏ xanh biển với vân sóng trắng như lưng cá voi Echo, lá ánh lam.", "REWARD", 0, 0, 0, "watermelon_echo", 7);
        return new com.englishcoach.garden.domain.LivingRules(monument, mastery, skins);
    }

    // ------------------------------------------------------------------ Phase 3C (V83)

    private static com.englishcoach.garden.domain.EstateRules.BuildingLevel level(int level, int minLevel, long coins,
                                                                                   Map<String, Integer> materials, Object... effects) {
        Map<String, Double> fx = new LinkedHashMap<>();
        for (int i = 0; i < effects.length; i += 2) fx.put((String) effects[i], ((Number) effects[i + 1]).doubleValue());
        return new com.englishcoach.garden.domain.EstateRules.BuildingLevel(level, minLevel, coins, materials, fx);
    }

    private static com.englishcoach.garden.domain.EstateRules.LandPlot land(int slot, int gx, int gy, long coins, Map<String, Integer> materials) {
        return new com.englishcoach.garden.domain.EstateRules.LandPlot(slot, gx, gy, coins, materials);
    }

    private static void source(Map<String, com.englishcoach.garden.domain.EstateRules.Source> m, String code, boolean capped, Integer... points) {
        m.put(code, new com.englishcoach.garden.domain.EstateRules.Source(code, List.of(points), capped));
    }

    /** The V83 estate seed; {@code GardenPhase3CPersistenceTest} asserts the loaded configuration equals it. */
    public static com.englishcoach.garden.domain.EstateRules estate() {
        Map<String, com.englishcoach.garden.domain.EstateRules.Building> buildings = new LinkedHashMap<>();
        buildings.put("COTTAGE", new com.englishcoach.garden.domain.EstateRules.Building("COTTAGE", "Nhà Gỗ", List.of(
                level(1, 6, 20000, Map.of("WHEAT", 12, "TOMATO", 8), "freshBonus", 0.25, "forecastExtra", 1),
                level(2, 10, 80000, Map.of("CORN", 16, "STRAWBERRY", 8), "freshBonus", 0.5, "forecastExtra", 2),
                level(3, 14, 240000, Map.of("ROSE", 12, "PUMPKIN", 10), "freshBonus", 1.0, "forecastExtra", 3))));
        buildings.put("WAREHOUSE", new com.englishcoach.garden.domain.EstateRules.Building("WAREHOUSE", "Kho Nông Trại", List.of(
                level(1, 5, 12000, Map.of("WHEAT", 16), "compostDaily", 2, "premiumCompostDaily", 0),
                level(2, 9, 60000, Map.of("TOMATO", 14, "CORN", 14), "compostDaily", 4, "premiumCompostDaily", 1),
                level(3, 13, 200000, Map.of("WATERMELON", 10, "STRAWBERRY", 12), "compostDaily", 6, "premiumCompostDaily", 2))));
        buildings.put("MARKET", new com.englishcoach.garden.domain.EstateRules.Building("MARKET", "Quầy Chợ Echo", List.of(
                level(1, 7, 25000, Map.of("TOMATO", 12, "CORN", 8), "featuredExtra", 1, "stapleCapExtra", 0, "packCapExtra", 0),
                level(2, 11, 100000, Map.of("STRAWBERRY", 12, "ROSE", 8), "featuredExtra", 1, "stapleCapExtra", 1, "packCapExtra", 0),
                level(3, 15, 300000, Map.of("PUMPKIN", 12, "WATERMELON", 12), "featuredExtra", 2, "stapleCapExtra", 2, "packCapExtra", 1))));
        var compost = new com.englishcoach.garden.domain.EstateRules.Compost(
                new com.englishcoach.garden.domain.EstateRules.Recipe(8, "NORMAL", "FERTILIZER"),
                new com.englishcoach.garden.domain.EstateRules.Recipe(12, "GOOD", "FERTILIZER_PREMIUM"));
        var regions = List.of(
                new com.englishcoach.garden.domain.EstateRules.Region("WEST_TILLED", "Thửa Cày Phía Tây", "west_tilled",
                        new com.englishcoach.garden.domain.EstateRules.Gate(12, 10, 10, 150), List.of(
                        land(11, 6, 19, 90000, Map.of("CORN", 12, "STRAWBERRY", 6)),
                        land(12, 5, 19, 110000, Map.of("TOMATO", 16, "ROSE", 6)),
                        land(13, 4, 19, 130000, Map.of("CORN", 16, "WATERMELON", 6)),
                        land(14, 4, 18, 150000, Map.of("STRAWBERRY", 10, "PUMPKIN", 6)))),
                new com.englishcoach.garden.domain.EstateRules.Region("WEST_FALLOW", "Bãi Cỏ Phía Tây", "west_fallow",
                        new com.englishcoach.garden.domain.EstateRules.Gate(14, 10, 30, 400), List.of(
                        land(15, 6, 22, 180000, Map.of("ROSE", 10, "WATERMELON", 8)),
                        land(16, 5, 22, 210000, Map.of("CORN", 20, "PUMPKIN", 8)),
                        land(17, 4, 22, 240000, Map.of("STRAWBERRY", 14, "WATERMELON", 10)),
                        land(18, 4, 21, 270000, Map.of("ROSE", 12, "PUMPKIN", 10)))),
                new com.englishcoach.garden.domain.EstateRules.Region("SOUTH_FIELD", "Cánh Đồng Phía Nam", "south_field",
                        new com.englishcoach.garden.domain.EstateRules.Gate(16, 14, 60, 900), List.of(
                        land(19, 8, 21, 400000, Map.of("WATERMELON", 12, "ROSE", 12)),
                        land(20, 9, 21, 480000, Map.of("PUMPKIN", 12, "STRAWBERRY", 16)),
                        land(21, 10, 21, 580000, Map.of("WATERMELON", 14, "CORN", 24)),
                        land(22, 8, 22, 700000, Map.of("PUMPKIN", 14, "ROSE", 14)),
                        land(23, 9, 22, 850000, Map.of("WATERMELON", 16, "STRAWBERRY", 18)),
                        land(24, 10, 22, 1000000, Map.of("PUMPKIN", 16, "ROSE", 16)))));
        var land = new com.englishcoach.garden.domain.EstateRules.Land(24,
                List.of(new double[]{21, 0.05}, new double[]{75, 0.10}, new double[]{180, 0.15}, new double[]{365, 0.20}), regions);
        var pest = new com.englishcoach.garden.domain.EstateRules.PestDamage(6, 24, 0.85, 0.7, 12, 10, 0, 0.5);
        Map<String, com.englishcoach.garden.domain.EstateRules.Source> sources = new LinkedHashMap<>();
        source(sources, "LEARNING_DAY", true, 10);
        source(sources, "BREADTH_DAY", true, 5);
        source(sources, "GRADUATION", true, 40);
        source(sources, "WEEKLY_ORDER", true, 15);
        source(sources, "ERA", false, 100, 200, 300, 400);
        source(sources, "BRANCH", false, 10, 30, 60);
        source(sources, "MEMORY", false, 20, 40, 80);
        source(sources, "RING", false, 50);
        source(sources, "MASTERY", false, 0, 0, 10, 25, 50);
        source(sources, "LAND_REGION", false, 40);
        source(sources, "BUILDING_MAX", false, 40);
        var contribution = new com.englishcoach.garden.domain.EstateRules.Contribution(sources, 60, 200, 600, 120, 20);
        return new com.englishcoach.garden.domain.EstateRules(buildings, compost, land, pest, contribution);
    }

    /** Field-by-field comparison of two estate rule sets (the discount rows are arrays). */
    public static boolean estateEquivalent(com.englishcoach.garden.domain.EstateRules a, com.englishcoach.garden.domain.EstateRules b) {
        var la = a.land();
        var lb = b.land();
        boolean discount = la.learningDiscount().size() == lb.learningDiscount().size()
                && java.util.stream.IntStream.range(0, la.learningDiscount().size())
                .allMatch(i -> java.util.Arrays.equals(la.learningDiscount().get(i), lb.learningDiscount().get(i)));
        return a.buildings().equals(b.buildings()) && a.compost().equals(b.compost()) && a.pestDamage().equals(b.pestDamage())
                && a.contribution().equals(b.contribution()) && la.maxPlots() == lb.maxPlots() && la.regions().equals(lb.regions())
                && discount;
    }

    private static void skin(Map<String, com.englishcoach.garden.domain.LivingRules.SkinDef> m, String code, String crop, String name,
                             String description, String kind, long price, int masteryTier, int learningDays, String art, int sort) {
        m.put(code, new com.englishcoach.garden.domain.LivingRules.SkinDef(code, crop, name, description, kind, price, masteryTier,
                learningDays, art, sort));
    }

    // ------------------------------------------------------------------ Phase 3D (V85)

    /**
     * The V85 crop growth profiles on top of {@link #seeded()}: {@code GardenPhase3DPersistenceTest} asserts the loaded
     * configuration equals it. Every earlier fixture keeps the V77 values it was qualified with.
     */
    public static GardenRules phase3d() {
        GardenRules r = seeded();
        Parts p = parts(r);
        Map<String, CropDef> crops = new LinkedHashMap<>(r.crops());
        profile(crops, "WHEAT", 1800, 5, 16, 4);
        profile(crops, "TOMATO", 5400, 16, 44, 8);
        profile(crops, "CORN", 10800, 28, 84, 12);
        profile(crops, "STRAWBERRY", 18000, 45, 130, 20);
        profile(crops, "ROSE", 28800, 80, 215, 32);
        profile(crops, "WATERMELON", 43200, 100, 300, 42);
        profile(crops, "PUMPKIN", 57600, 125, 385, 52);
        profile(crops, "MOONFLOWER", 72000, 200, 560, 70);
        profile(crops, "FROST_LILY", 86400, 250, 700, 85);
        profile(crops, "CRYSTAL_ORCHID", 129600, 400, 1500, 180);
        p.crops = java.util.Collections.unmodifiableMap(crops);
        return p.build();
    }

    private static void profile(Map<String, CropDef> crops, String code, int base, int seed, int sell, int xp) {
        CropDef c = crops.get(code);
        crops.put(code, new CropDef(c.code(), c.nameVi(), c.rarity(), base, seed, c.seedEssence(), sell, c.season(),
                c.unlockLevel(), xp, c.seedInFixedShop(), c.qaOnly(), c.sortOrder()));
    }

    /** The market with the V85 farming supplies as staples (ordered by price, then code, like the loader). */
    public static com.englishcoach.garden.domain.FarmEconomyRules economy3d() {
        var e = economy();
        var S = com.englishcoach.garden.domain.FarmEconomyRules.Staple.class;
        List<com.englishcoach.garden.domain.FarmEconomyRules.Staple> staples = new java.util.ArrayList<>(e.market().staples());
        staples.add(new com.englishcoach.garden.domain.FarmEconomyRules.Staple("WELL_WATER", "Nước Giếng", 20, 6, 2));
        staples.add(new com.englishcoach.garden.domain.FarmEconomyRules.Staple("MULCH", "Rơm Phủ Gốc", 45, 4, 3));
        staples.add(new com.englishcoach.garden.domain.FarmEconomyRules.Staple("RAIN_COVER", "Bạt Che Mưa", 60, 3, 4));
        staples.add(new com.englishcoach.garden.domain.FarmEconomyRules.Staple("SHADE_NET", "Lưới Che Nắng", 60, 3, 4));
        staples.add(new com.englishcoach.garden.domain.FarmEconomyRules.Staple("DRAINAGE", "Rãnh Thoát Nước", 90, 2, 6));
        staples.add(new com.englishcoach.garden.domain.FarmEconomyRules.Staple("ORGANIC_SPRAY", "Thuốc Xịt Hữu Cơ", 70, 2, 3));
        staples.add(new com.englishcoach.garden.domain.FarmEconomyRules.Staple("INSECT_NET", "Lưới Chắn Côn Trùng", 110, 2, 5));
        staples.add(new com.englishcoach.garden.domain.FarmEconomyRules.Staple("CROP_TONIC", "Thuốc Dưỡng Cây", 120, 2, 6));
        staples.sort(java.util.Comparator.comparingInt(com.englishcoach.garden.domain.FarmEconomyRules.Staple::price)
                .thenComparing(com.englishcoach.garden.domain.FarmEconomyRules.Staple::item));
        var m = e.market();
        return new com.englishcoach.garden.domain.FarmEconomyRules(new com.englishcoach.garden.domain.FarmEconomyRules.Market(
                List.copyOf(staples), m.featuredSlots(), m.packSize(), m.packDiscount(), m.packDailyCap(), m.maxPerPurchase()),
                e.orders(), e.expansion());
    }

    private static void item(Map<String, com.englishcoach.garden.domain.FarmingRules.Item> m, String code, String category,
                             String effect, double hours, double value) {
        m.put(code, new com.englishcoach.garden.domain.FarmingRules.Item(code,
                com.englishcoach.garden.domain.FarmingRules.Category.valueOf(category),
                com.englishcoach.garden.domain.FarmingRules.Effect.valueOf(effect), hours, value));
    }

    /** The V85 farming seed; {@code GardenPhase3DPersistenceTest} asserts the loaded configuration equals it. */
    public static com.englishcoach.garden.domain.FarmingRules farming() {
        Map<Season, Double> evap = new java.util.EnumMap<>(Season.class);
        evap.put(Season.LU_HANH, 1.0);
        evap.put(Season.CONG_SO, 1.25);
        evap.put(Season.HOC_THUAT, 1.0);
        evap.put(Season.THANH_NGU, 0.75);
        var soil = new com.englishcoach.garden.domain.FarmingRules.Soil(60, 25, 85, 4.5, 6, 0.5, 0.6, 0.6, 10, 35, evap,
                List.of(new double[]{0.15, 1.0}, new double[]{0.4, 0.5}), 0.4, "GOOD");
        Map<String, Double> thirst = new LinkedHashMap<>();
        thirst.put("WHEAT", 0.7);
        thirst.put("TOMATO", 1.3);
        thirst.put("CORN", 0.8);
        thirst.put("STRAWBERRY", 1.2);
        thirst.put("ROSE", 1.0);
        thirst.put("WATERMELON", 1.5);
        thirst.put("PUMPKIN", 1.1);
        thirst.put("MOONFLOWER", 0.9);
        thirst.put("FROST_LILY", 0.8);
        thirst.put("CRYSTAL_ORCHID", 1.0);
        thirst.put("QA_SPROUT", 1.0);
        Map<String, com.englishcoach.garden.domain.FarmingRules.Item> items = new LinkedHashMap<>();
        item(items, "FERTILIZER", "CARE", "BOOST", 0, 0);
        item(items, "FERTILIZER_PREMIUM", "CARE", "BOOST", 0, 0);
        item(items, "MULCH", "CARE", "MULCH", 0, 0.6);
        item(items, "CROP_TONIC", "CARE", "TONIC", 8, 0.5);
        item(items, "RAIN_COVER", "WEATHER", "RAIN_COVER", 12, 0);
        item(items, "SHADE_NET", "WEATHER", "SHADE", 12, 0.4);
        item(items, "DRAINAGE", "WEATHER", "DRAINAGE", 24, 65);
        item(items, "ORGANIC_SPRAY", "PEST", "PEST_SPRAY", 12, 18);
        item(items, "INSECT_NET", "PEST", "PEST_NET", 24, 0);
        item(items, "WELL_WATER", "UTILITY", "MOISTURE", 0, 30);
        return new com.englishcoach.garden.domain.FarmingRules(soil, thirst, items,
                new com.englishcoach.garden.domain.FarmingRules.HarvestBonus(0.06, 1, 400));
    }

    public static boolean farmingEquivalent(com.englishcoach.garden.domain.FarmingRules a, com.englishcoach.garden.domain.FarmingRules b) {
        var x = a.soil();
        var y = b.soil();
        boolean soil = x.start() == y.start() && x.dryBelow() == y.dryBelow() && x.wetAbove() == y.wetAbove()
                && x.evapPerHour() == y.evapPerHour() && x.rainPerHour() == y.rainPerHour() && x.rainbowEvap() == y.rainbowEvap()
                && x.dryFactor() == y.dryFactor() && x.wetFactor() == y.wetFactor() && x.maxStressHours() == y.maxStressHours()
                && x.waterGain() == y.waterGain() && x.seasonEvap().equals(y.seasonEvap()) && x.careShare().size() == y.careShare().size()
                && java.util.stream.IntStream.range(0, x.careShare().size()).allMatch(i ->
                java.util.Arrays.equals(x.careShare().get(i), y.careShare().get(i)))
                && x.severeShare() == y.severeShare() && x.severeTierCap().equals(y.severeTierCap());
        return soil && a.thirst().equals(b.thirst()) && a.items().equals(b.items()) && a.harvestBonus().equals(b.harvestBonus());
    }

    private static void add(Map<String, CropDef> m, String code, String name, Rarity r, int base, int seed, int ess,
                            int sell, Season season, int unlock, int xp, boolean shop, boolean qa, int sort) {
        m.put(code, new CropDef(code, name, r, base, seed, ess, sell, season, unlock, xp, shop, qa, sort));
    }

    static boolean phase2Equivalent(GardenRules a, GardenRules b) {
        var wa = a.weather();
        var wb = b.weather();
        boolean weather = wa.startAt().equals(wb.startAt()) && wa.windowHours() == wb.windowHours()
                && wa.rainSpeed() == wb.rainSpeed() && wa.rainbowMutation() == wb.rainbowMutation()
                && wa.forecastWindows() == wb.forecastWindows() && wa.chances().keySet().equals(wb.chances().keySet())
                && wa.chances().entrySet().stream().allMatch(e -> java.util.Arrays.equals(e.getValue(), wb.chances().get(e.getKey())));
        var ka = a.knowledge();
        var kb = b.knowledge();
        boolean knowledge = ka.slotLevels().equals(kb.slotLevels()) && ka.cards() == kb.cards()
                && ka.evidenceCap() == kb.evidenceCap() && ka.stages().equals(kb.stages())
                && ka.graduation().equals(kb.graduation()) && java.util.Arrays.equals(ka.essencePerDay(), kb.essencePerDay())
                && ka.essenceStoreDays() == kb.essenceStoreDays() && ka.candidateLimit() == kb.candidateLimit();
        return weather && knowledge && a.pests().equals(b.pests()) && a.learning().equals(b.learning());
    }

    /** Field-by-field comparison (records holding arrays do not implement value equality for them). */
    public static boolean equivalent(GardenRules a, GardenRules b) {
        return a.zone().equals(b.zone()) && a.crops().equals(b.crops()) && a.boosts().equals(b.boosts())
                && a.seasons().equals(b.seasons()) && a.quality().equals(b.quality()) && a.level().equals(b.level())
                && a.challenge().equals(b.challenge()) && a.starter().equals(b.starter())
                && a.blessingSellMultiplier() == b.blessingSellMultiplier() && a.coinScale() == b.coinScale()
                && a.growth().maxBoost() == b.growth().maxBoost() && a.growth().speedFloor() == b.growth().speedFloor()
                && a.growth().inSeason() == b.growth().inSeason() && a.growth().offSeason() == b.growth().offSeason()
                && a.growth().allSeason() == b.growth().allSeason()
                && a.growth().tutorialSeconds() == b.growth().tutorialSeconds()
                && a.growth().tutorialCrop().equals(b.growth().tutorialCrop())
                && java.util.Arrays.equals(a.growth().stageThresholds(), b.growth().stageThresholds())
                && a.growth().estimateHorizonDays() == b.growth().estimateHorizonDays()
                && a.rewards().unitsPerWater() == b.rewards().unitsPerWater()
                && a.rewards().reviewUnit() == b.rewards().reviewUnit()
                && a.rewards().repeatSameDayUnit() == b.rewards().repeatSameDayUnit()
                && a.rewards().xpPerUnit() == b.rewards().xpPerUnit() && a.rewards().goalUnits() == b.rewards().goalUnits()
                && a.rewards().goalDueMinReviews() == b.rewards().goalDueMinReviews()
                && a.rewards().goalXp() == b.rewards().goalXp()
                && a.rewards().goalMixUnits() == b.rewards().goalMixUnits()
                && a.rewards().goalMixSkills() == b.rewards().goalMixSkills()
                && a.rewards().harvestXpDiminishing().size() == b.rewards().harvestXpDiminishing().size()
                && java.util.stream.IntStream.range(0, a.rewards().harvestXpDiminishing().size()).allMatch(i ->
                java.util.Arrays.equals(a.rewards().harvestXpDiminishing().get(i), b.rewards().harvestXpDiminishing().get(i)))
                && phase2Equivalent(a, b)
                && a.rewards().diminishing().size() == b.rewards().diminishing().size()
                && java.util.stream.IntStream.range(0, a.rewards().diminishing().size()).allMatch(i ->
                java.util.Arrays.equals(a.rewards().diminishing().get(i), b.rewards().diminishing().get(i)));
    }
}
