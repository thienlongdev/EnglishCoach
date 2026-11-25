package com.englishcoach.garden.infra;

import com.englishcoach.garden.domain.EstateRules;
import com.englishcoach.garden.domain.FarmEconomyRules;
import com.englishcoach.garden.domain.FarmingRules;
import com.englishcoach.garden.domain.GardenRules;
import com.englishcoach.garden.domain.GardenRules.BoostItem;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GardenRules.QualityTier;
import com.englishcoach.garden.domain.GardenRules.Rarity;
import com.englishcoach.garden.domain.GardenRules.Season;
import com.englishcoach.garden.domain.LivingRules;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads the Flyway-seeded configuration ({@code garden_config}, {@code garden_crop_def}, {@code garden_item_def}) into
 * the immutable {@link GardenRules}. A missing key fails loudly: Garden never falls back to numbers in code.
 */
public final class GardenRulesLoader {

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public GardenRulesLoader(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    public GardenRules load() {
        Map<String, JsonNode> cfg = new HashMap<>();
        jdbc.query("SELECT key, value::text FROM public.garden_config", rs -> {
            cfg.put(rs.getString(1), parse(rs.getString(2)));
        });

        Map<String, CropDef> crops = new LinkedHashMap<>();
        jdbc.query("SELECT * FROM public.garden_crop_def ORDER BY sort_order", rs -> {
            var c = new CropDef(rs.getString("code"), rs.getString("name_vi"), Rarity.valueOf(rs.getString("rarity")),
                    rs.getInt("base_seconds"), rs.getInt("seed_price"), rs.getInt("seed_essence"), rs.getInt("sell_price"),
                    Season.valueOf(rs.getString("season")), rs.getInt("unlock_level"), rs.getInt("harvest_xp"),
                    rs.getBoolean("seed_in_fixed_shop"), rs.getBoolean("qa_only"), rs.getInt("sort_order"));
            crops.put(c.code(), c);
        });

        Map<String, BoostItem> boosts = new LinkedHashMap<>();
        jdbc.query("SELECT code, name_vi, params::text, coin_price FROM public.garden_item_def WHERE kind = 'BOOST'", rs -> {
            JsonNode p = parse(rs.getString(3));
            Object price = rs.getObject(4);
            boosts.put(rs.getString(1), new BoostItem(rs.getString(1), rs.getString(2), p.get("group").asText(),
                    p.get("fraction").asDouble(), p.get("perPlanting").asInt(),
                    price == null ? null : ((Number) price).intValue()));
        });

        List<QualityTier> tiers = new ArrayList<>();
        for (JsonNode t : req(cfg, "quality.tiers")) {
            tiers.add(new QualityTier(t.get(1).asText(), t.get(0).asInt(), t.get(2).asDouble(), t.get(3).asDouble()));
        }
        JsonNode points = req(cfg, "quality.points");
        JsonNode moon = req(cfg, "codex.moonlitHours");
        var quality = new GardenRules.Quality(tiers, points.get("recallPerCorrect").asInt(), points.get("pestClean").asInt(),
                points.get("pestLate").asInt(), points.get("seasonIn").asInt(), points.get("seasonCommon").asInt(),
                points.get("seasonOff").asInt(), points.get("cared").asInt(), points.get("fresh").asInt(),
                req(cfg, "quality.freshMinHours").asDouble(), req(cfg, "quality.freshFraction").asDouble(),
                req(cfg, "mutation.base").asDouble(), moon.get(0).asInt(), moon.get(1).asInt(),
                req(cfg, "codex.newFormXp").asInt());

        JsonNode th = req(cfg, "growth.stageThresholds");
        JsonNode tutorial = req(cfg, "tutorial");
        var growth = new GardenRules.Growth(req(cfg, "boost.maxFraction").asDouble(), req(cfg, "speed.floor").asDouble(),
                req(cfg, "speed.inSeason").asDouble(), req(cfg, "speed.offSeason").asDouble(),
                req(cfg, "speed.allSeason").asDouble(), tutorial.get("seconds").asInt(), tutorial.get("crop").asText(),
                new double[]{th.get(0).asDouble(), th.get(1).asDouble()}, req(cfg, "growth.estimateHorizonDays").asInt());

        List<Season> order = new ArrayList<>();
        req(cfg, "season.order").forEach(n -> order.add(Season.valueOf(n.asText())));
        var seasons = new GardenRules.Seasons(LocalDate.parse(req(cfg, "season.epochMonday").asText()), order);

        List<double[]> dim = new ArrayList<>();
        req(cfg, "reward.diminishing").forEach(n -> dim.add(new double[]{n.get(0).asDouble(), n.get(1).asDouble()}));
        JsonNode goal = req(cfg, "goal");
        var rewards = new GardenRules.Rewards(req(cfg, "reward.unitsPerWater").asDouble(), dim,
                req(cfg, "reward.reviewUnit").asDouble(), req(cfg, "reward.repeatSameDayUnit").asDouble(),
                req(cfg, "reward.xpPerUnit").asDouble(), goal.get("units").asDouble(), goal.get("dueMinReviews").asInt(),
                goal.get("xp").asInt(), field(goal, "mixUnits").asDouble(), field(goal, "mixSkills").asInt(),
                schedule(req(cfg, "harvest.dailyXp")));

        JsonNode lv = req(cfg, "level.xpFormula");
        var level = new GardenRules.Level(lv.get("a").asDouble(), lv.get("p").asDouble(), lv.get("b").asDouble());

        JsonNode ch = req(cfg, "challenge");
        var challenge = new GardenRules.Challenge(ch.get("questions").asInt(), ch.get("reverse").asInt(),
                ch.get("options").asInt(), ch.get("expirySeconds").asInt(), ch.get("recentDays").asInt());

        JsonNode st = req(cfg, "starter");
        Map<String, Integer> starterItems = new LinkedHashMap<>();
        st.get("items").fields().forEachRemaining(e -> starterItems.put(e.getKey(), e.getValue().asInt()));
        List<GardenRules.Cell> cells = new ArrayList<>();
        req(cfg, "plots.starter").forEach(c -> cells.add(new GardenRules.Cell(c.get(0).asInt(), c.get(1).asInt())));
        var starter = new GardenRules.Starter(st.get("coins").asLong(), Map.copyOf(starterItems), List.copyOf(cells));

        return new GardenRules(ZoneId.of(req(cfg, "timezone").asText()), growth, seasons, quality, rewards, level,
                challenge, starter, req(cfg, "blessing.sellMultiplier").asDouble(), req(cfg, "coin.scale").asDouble(),
                Map.copyOf(crops), Map.copyOf(boosts), weather(req(cfg, "weather")), pests(req(cfg, "pest")),
                knowledge(req(cfg, "knowledge")), learning(req(cfg, "learning")));
    }

    // ------------------------------------------------------------------ Phase 3A keys (V80)

    /**
     * Farm economy (Phase 3A): market staples are the fixed-shop care items of {@code garden_item_def} (price, daily cap,
     * unlock level); the featured packs, the delivery board and the expansion beds come from {@code garden_config}.
     */
    public FarmEconomyRules loadEconomy(GardenRules rules) {
        Map<String, JsonNode> cfg = new HashMap<>();
        jdbc.query("SELECT key, value::text FROM public.garden_config WHERE key IN ('market', 'orders', 'expansion')", rs -> {
            cfg.put(rs.getString(1), parse(rs.getString(2)));
        });
        List<FarmEconomyRules.Staple> staples = new ArrayList<>();
        jdbc.query("""
                SELECT code, name_vi, coin_price, daily_cap, unlock_level FROM public.garden_item_def
                WHERE in_fixed_shop AND coin_price IS NOT NULL AND daily_cap IS NOT NULL ORDER BY coin_price, code
                """, rs -> {
            staples.add(new FarmEconomyRules.Staple(rs.getString(1), rs.getString(2), rs.getInt(3), rs.getInt(4), rs.getInt(5)));
        });
        return economy(req(cfg, "market"), req(cfg, "orders"), req(cfg, "expansion"), staples, rules);
    }

    static FarmEconomyRules economy(JsonNode m, JsonNode o, JsonNode x, List<FarmEconomyRules.Staple> staples, GardenRules rules) {
        var market = new FarmEconomyRules.Market(List.copyOf(staples), field(m, "featuredSlots").asInt(),
                field(m, "packSize").asInt(), field(m, "packDiscount").asDouble(), field(m, "packDailyCap").asInt(),
                field(m, "maxPerPurchase").asInt());
        var orders = new FarmEconomyRules.Orders(field(o, "dailySlots").asInt(), field(o, "weeklySlots").asInt(),
                field(o, "coinMultiplier").asDouble(), field(o, "growShare").asDouble(), orderKind(field(o, "daily")),
                orderKind(field(o, "weekly")), field(o, "historyLimit").asInt());
        List<FarmEconomyRules.ExpansionPlot> plots = new ArrayList<>();
        for (JsonNode p : field(x, "plots")) {
            Map<String, Integer> compost = new LinkedHashMap<>();
            field(p, "compost").fields().forEachRemaining(e -> compost.put(e.getKey(), e.getValue().asInt()));
            compost.keySet().forEach(rules::crop); // fails loudly on an unknown crop
            JsonNode cell = field(p, "cell");
            plots.add(new FarmEconomyRules.ExpansionPlot(field(p, "slot").asInt(), cell.get(0).asInt(), cell.get(1).asInt(),
                    field(p, "field").asText(), field(p, "level").asInt(), field(p, "coins").asLong(), Map.copyOf(compost)));
        }
        plots.sort(java.util.Comparator.comparingInt(FarmEconomyRules.ExpansionPlot::slot));
        return new FarmEconomyRules(market, orders, new FarmEconomyRules.Expansion(List.copyOf(plots)));
    }

    static FarmEconomyRules.OrderKind orderKind(JsonNode k) {
        Map<String, Integer> bonus = new LinkedHashMap<>();
        field(k, "bonus").fields().forEachRemaining(e -> bonus.put(e.getKey(), e.getValue().asInt()));
        JsonNode lines = field(k, "lines");
        JsonNode qty = field(k, "qty");
        return new FarmEconomyRules.OrderKind(field(k, "minLevel").asInt(), lines.get(0).asInt(), lines.get(1).asInt(),
                field(k, "multiLineLevel").asInt(), qty.get(0).asInt(), qty.get(1).asInt(), Map.copyOf(bonus),
                field(k, "seedBonus").asInt(), field(k, "goodTierLevel").asInt());
    }

    // ------------------------------------------------------------------ Phase 3B keys (V82)

    /**
     * Living knowledge (Phase 3B): the monument and mastery rules from {@code garden_config}, the skin catalogue from
     * {@code garden_skin_def} (active rows). Unknown crops, families or sources fail loudly at load time.
     */
    public LivingRules loadLiving(GardenRules rules) {
        Map<String, JsonNode> cfg = new HashMap<>();
        jdbc.query("SELECT key, value::text FROM public.garden_config WHERE key IN ('monument', 'mastery')", rs -> {
            cfg.put(rs.getString(1), parse(rs.getString(2)));
        });
        Map<String, LivingRules.SkinDef> skins = new LinkedHashMap<>();
        jdbc.query("SELECT * FROM public.garden_skin_def WHERE active ORDER BY sort_order, code", rs -> {
            var s = new LivingRules.SkinDef(rs.getString("code"), rs.getString("crop_code"), rs.getString("name_vi"),
                    rs.getString("description_vi"), rs.getString("unlock_kind"), rs.getLong("coin_price"),
                    rs.getInt("mastery_tier"), rs.getInt("learning_days"), rs.getString("art_key"), rs.getInt("sort_order"));
            rules.crop(s.cropCode()); // fails loudly on an unknown crop
            skins.put(s.code(), s);
        });
        return living(req(cfg, "monument"), req(cfg, "mastery"), skins, rules);
    }

    static LivingRules living(JsonNode m, JsonNode ma, Map<String, LivingRules.SkinDef> skins, GardenRules rules) {
        Map<LivingRules.Family, String> families = new java.util.EnumMap<>(LivingRules.Family.class);
        field(m, "families").fields().forEachRemaining(e -> {
            String source = e.getValue().asText();
            if (!"FLASHCARD".equals(source) && !rules.learning().sources().containsKey(source)) {
                throw new IllegalStateException("unknown learning source " + source);
            }
            families.put(LivingRules.Family.valueOf(e.getKey()), source);
        });
        List<String> play = new ArrayList<>();
        field(m, "play").forEach(n -> play.add(n.asText()));
        List<LivingRules.EraGate> eras = new ArrayList<>();
        field(m, "eras").forEach(n -> eras.add(new LivingRules.EraGate(n.get(0).asInt(), n.get(1).asInt(), n.get(2).asInt(),
                n.get(3).asInt())));
        eras.sort(java.util.Comparator.comparingInt(LivingRules.EraGate::era));
        var monument = new LivingRules.Monument(field(m, "minCardReviews").asInt(), field(m, "scanDays").asInt(),
                field(m, "overlapHours").asInt(), field(m, "creditBatch").asInt(), field(m, "historyLimit").asInt(),
                Map.copyOf(families), List.copyOf(play), ints(field(m, "branchTiers")), ints(field(m, "memoryTiers")),
                field(m, "minNewWords").asInt(), List.copyOf(eras), field(m, "ringEveryDays").asInt());
        List<LivingRules.MasteryTier> tiers = new ArrayList<>();
        field(ma, "tiers").forEach(n -> tiers.add(new LivingRules.MasteryTier(n.get(0).asInt(), n.get(1).asInt(), n.get(2).asInt(),
                n.get(3).asInt(), n.get(4).asInt())));
        tiers.sort(java.util.Comparator.comparingInt(LivingRules.MasteryTier::tier));
        Map<Rarity, Double> scale = new java.util.EnumMap<>(Rarity.class);
        field(ma, "rarityScale").fields().forEachRemaining(e -> scale.put(Rarity.valueOf(e.getKey()), e.getValue().asDouble()));
        return new LivingRules(monument, new LivingRules.Mastery(List.copyOf(tiers), Map.copyOf(scale)),
                java.util.Collections.unmodifiableMap(new LinkedHashMap<>(skins)));
    }

    private static List<Integer> ints(JsonNode rows) {
        List<Integer> out = new ArrayList<>();
        rows.forEach(n -> out.add(n.asInt()));
        return List.copyOf(out);
    }

    // ------------------------------------------------------------------ Phase 3C keys (V83)

    /**
     * Estate (Phase 3C): buildings, the compost bin, farmland regions, staged pest damage and the contribution rules from
     * {@code garden_config}. Unknown crops, items or tiers fail loudly at load time.
     */
    public EstateRules loadEstate(GardenRules rules) {
        Map<String, JsonNode> cfg = new HashMap<>();
        jdbc.query("SELECT key, value::text FROM public.garden_config WHERE key IN ('buildings', 'compost', 'land', 'pestDamage', 'contribution')", rs -> {
            cfg.put(rs.getString(1), parse(rs.getString(2)));
        });
        return estate(req(cfg, "buildings"), req(cfg, "compost"), req(cfg, "land"), req(cfg, "pestDamage"), req(cfg, "contribution"), rules);
    }

    static EstateRules estate(JsonNode b, JsonNode c, JsonNode l, JsonNode p, JsonNode k, GardenRules rules) {
        Map<String, EstateRules.Building> buildings = new LinkedHashMap<>();
        b.fields().forEachRemaining(e -> {
            List<EstateRules.BuildingLevel> levels = new ArrayList<>();
            for (JsonNode n : field(e.getValue(), "levels")) {
                Map<String, Double> effects = new LinkedHashMap<>();
                field(n, "effects").fields().forEachRemaining(x -> effects.put(x.getKey(), x.getValue().asDouble()));
                levels.add(new EstateRules.BuildingLevel(field(n, "level").asInt(), field(n, "minLevel").asInt(),
                        field(n, "coins").asLong(), crops(field(n, "materials"), rules), Map.copyOf(effects)));
            }
            levels.sort(java.util.Comparator.comparingInt(EstateRules.BuildingLevel::level));
            for (int i = 0; i < levels.size(); i++) {
                if (levels.get(i).level() != i + 1) throw new IllegalStateException("building levels must be 1..n: " + e.getKey());
            }
            buildings.put(e.getKey(), new EstateRules.Building(e.getKey(), field(e.getValue(), "nameVi").asText(), List.copyOf(levels)));
        });
        var compost = new EstateRules.Compost(recipe(field(c, "standard"), rules), recipe(field(c, "premium"), rules));
        List<EstateRules.Region> regions = new ArrayList<>();
        java.util.Set<Integer> slots = new java.util.HashSet<>();
        java.util.Set<String> cells = new java.util.HashSet<>();
        rules.starter().plots().forEach(cell -> cells.add(cell.x() + "," + cell.y()));
        for (JsonNode r : field(l, "regions")) {
            JsonNode g = field(r, "gate");
            List<EstateRules.LandPlot> plots = new ArrayList<>();
            for (JsonNode n : field(r, "plots")) {
                JsonNode cell = field(n, "cell");
                int slot = field(n, "slot").asInt();
                if (!slots.add(slot) || !cells.add(cell.get(0).asInt() + "," + cell.get(1).asInt())) {
                    throw new IllegalStateException("duplicate land slot or cell " + slot);
                }
                plots.add(new EstateRules.LandPlot(slot, cell.get(0).asInt(), cell.get(1).asInt(), field(n, "coins").asLong(),
                        crops(field(n, "materials"), rules)));
            }
            plots.sort(java.util.Comparator.comparingInt(EstateRules.LandPlot::slot));
            regions.add(new EstateRules.Region(field(r, "code").asText(), field(r, "nameVi").asText(), field(r, "field").asText(),
                    new EstateRules.Gate(field(g, "level").asInt(), field(g, "plots").asInt(), field(g, "ordersFilled").asInt(),
                            field(g, "harvests").asInt()), List.copyOf(plots)));
        }
        var land = new EstateRules.Land(field(l, "maxPlots").asInt(), schedule(field(l, "learningDiscount")), List.copyOf(regions));
        var pest = new EstateRules.PestDamage(field(p, "warnHours").asDouble(), field(p, "wiltHours").asDouble(),
                field(p, "leafFactor").asDouble(), field(p, "wiltFactor").asDouble(), field(p, "wiltEffectHours").asDouble(),
                field(p, "leafScore").asInt(), field(p, "wiltScore").asInt(), field(p, "tendedRelief").asDouble());
        if (pest.warnHours() < 0 || pest.wiltHours() <= pest.warnHours() || pest.leafFactor() <= 0 || pest.leafFactor() > 1
                || pest.wiltFactor() <= 0 || pest.wiltFactor() > 1 || pest.wiltEffectHours() < 0) {
            throw new IllegalStateException("invalid pestDamage configuration");
        }
        Map<String, EstateRules.Source> sources = new LinkedHashMap<>();
        field(k, "sources").fields().forEachRemaining(e -> sources.put(e.getKey(), new EstateRules.Source(e.getKey(),
                ints(field(e.getValue(), "points")), field(e.getValue(), "capped").asBoolean())));
        JsonNode caps = field(k, "caps");
        var contribution = new EstateRules.Contribution(Map.copyOf(sources), field(caps, "day").asInt(), field(caps, "week").asInt(),
                field(caps, "month").asInt(), field(k, "scanLimit").asInt(), field(k, "historyLimit").asInt());
        return new EstateRules(java.util.Collections.unmodifiableMap(buildings), compost, land, pest, contribution);
    }

    /** Produce a level or a bed consumes: crop code → quantity (an unknown crop fails loudly). */
    private static Map<String, Integer> crops(JsonNode node, GardenRules rules) {
        Map<String, Integer> out = new LinkedHashMap<>();
        node.fields().forEachRemaining(e -> {
            rules.crop(e.getKey());
            out.put(e.getKey(), e.getValue().asInt());
        });
        return java.util.Collections.unmodifiableMap(out);
    }

    private static EstateRules.Recipe recipe(JsonNode r, GardenRules rules) {
        String gives = field(r, "gives").asText();
        if (!rules.boosts().containsKey(gives)) throw new IllegalStateException("unknown compost item " + gives);
        String tier = field(r, "minTier").asText();
        rules.quality().tier(tier); // fails loudly on an unknown tier
        return new EstateRules.Recipe(field(r, "units").asInt(), tier, gives);
    }

    // ------------------------------------------------------------------ Phase 3D key (V85)

    /**
     * Farming (Phase 3D): soil moisture, supplies and the harvest bonus from {@code garden_config.farming}. {@code null}
     * when the key is not seeded (a database at V84): the garden then runs the Phase 3C rules. Unknown crops, effects or
     * categories fail loudly at load time.
     */
    public FarmingRules loadFarming(GardenRules rules) {
        List<String> rows = jdbc.queryForList("SELECT value::text FROM public.garden_config WHERE key = 'farming'", String.class);
        return rows.isEmpty() ? null : farming(parse(rows.getFirst()), rules);
    }

    static FarmingRules farming(JsonNode f, GardenRules rules) {
        JsonNode s = field(f, "soil");
        Map<Season, Double> seasonEvap = new java.util.EnumMap<>(Season.class);
        field(s, "seasonEvap").fields().forEachRemaining(e -> seasonEvap.put(Season.valueOf(e.getKey()), e.getValue().asDouble()));
        var soil = new FarmingRules.Soil(field(s, "start").asDouble(), field(s, "dryBelow").asDouble(), field(s, "wetAbove").asDouble(),
                field(s, "evapPerHour").asDouble(), field(s, "rainPerHour").asDouble(), field(s, "rainbowEvap").asDouble(),
                field(s, "dryFactor").asDouble(), field(s, "wetFactor").asDouble(), field(s, "maxStressHours").asDouble(),
                field(s, "waterGain").asDouble(), Map.copyOf(seasonEvap), schedule(field(s, "careShare")),
                field(s, "severeShare").asDouble(), field(s, "severeTierCap").asText());
        rules.quality().tier(soil.severeTierCap()); // fails loudly on an unknown tier
        if (soil.dryBelow() <= 0 || soil.wetAbove() <= soil.dryBelow() || soil.wetAbove() >= 100 || soil.start() < soil.dryBelow()
                || soil.start() > soil.wetAbove() || soil.evapPerHour() <= 0 || soil.rainPerHour() <= 0 || soil.dryFactor() <= 0
                || soil.dryFactor() > 1 || soil.wetFactor() <= 0 || soil.wetFactor() > 1 || soil.maxStressHours() < 0) {
            throw new IllegalStateException("invalid farming.soil configuration");
        }
        Map<String, Double> thirst = new LinkedHashMap<>();
        field(f, "thirst").fields().forEachRemaining(e -> {
            rules.crop(e.getKey()); // fails loudly on an unknown crop
            if (e.getValue().asDouble() <= 0) throw new IllegalStateException("invalid thirst of " + e.getKey());
            thirst.put(e.getKey(), e.getValue().asDouble());
        });
        Map<String, FarmingRules.Item> items = new LinkedHashMap<>();
        field(f, "items").fields().forEachRemaining(e -> {
            var item = new FarmingRules.Item(e.getKey(), FarmingRules.Category.valueOf(field(e.getValue(), "category").asText()),
                    FarmingRules.Effect.valueOf(field(e.getValue(), "effect").asText()), field(e.getValue(), "hours").asDouble(),
                    field(e.getValue(), "value").asDouble());
            if (item.effect() == FarmingRules.Effect.BOOST && !rules.boosts().containsKey(item.code())) {
                throw new IllegalStateException("unknown boost item " + item.code());
            }
            if (item.hours() < 0) throw new IllegalStateException("invalid hours of " + item.code());
            items.put(item.code(), item);
        });
        JsonNode b = field(f, "harvestBonus");
        var bonus = new FarmingRules.HarvestBonus(field(b, "share").asDouble(), field(b, "min").asInt(), field(b, "dailyCap").asInt());
        if (bonus.share() < 0 || bonus.share() > 0.25 || bonus.min() < 0 || bonus.dailyCap() < 0) {
            throw new IllegalStateException("invalid farming.harvestBonus configuration");
        }
        return new FarmingRules(soil, java.util.Collections.unmodifiableMap(thirst), java.util.Collections.unmodifiableMap(items), bonus);
    }

    // ------------------------------------------------------------------ Phase 2 keys (V78)

    static GardenRules.WeatherRules weather(JsonNode w) {
        Map<Season, double[]> chances = new java.util.EnumMap<>(Season.class);
        field(w, "chances").fields().forEachRemaining(e -> chances.put(Season.valueOf(e.getKey()),
                new double[]{e.getValue().get(0).asDouble(), e.getValue().get(1).asDouble()}));
        return new GardenRules.WeatherRules(java.time.Instant.parse(field(w, "startAt").asText()),
                field(w, "windowHours").asInt(), field(w, "rainSpeed").asDouble(), field(w, "rainbowMutation").asDouble(),
                field(w, "forecastWindows").asInt(), Map.copyOf(chances));
    }

    static GardenRules.PestRules pests(JsonNode p) {
        return new GardenRules.PestRules(field(p, "graceHours").asDouble(), field(p, "maxCropPests").asInt(),
                field(p, "growthFactor").asDouble(), field(p, "effectHours").asDouble(), field(p, "protectMinutes").asInt(),
                field(p, "cureXp").asInt(), field(p, "cureDailyCap").asInt(), field(p, "scanLimit").asInt());
    }

    static GardenRules.KnowledgeRules knowledge(JsonNode k) {
        List<Integer> slots = new ArrayList<>();
        field(k, "slotLevels").forEach(n -> slots.add(n.asInt()));
        List<GardenRules.StageRule> stages = new ArrayList<>();
        field(k, "stages").forEach(n -> stages.add(new GardenRules.StageRule(n.get(0).asInt(), n.get(1).asInt(),
                n.get(2).asInt(), n.get(3).asInt())));
        JsonNode g = field(k, "graduation");
        Map<String, Integer> items = new LinkedHashMap<>();
        field(g, "items").fields().forEachRemaining(e -> items.put(e.getKey(), e.getValue().asInt()));
        var graduation = new GardenRules.Graduation(field(g, "minAgeDays").asInt(), field(g, "minPerCard").asInt(),
                field(g, "questions").asInt(), field(g, "reverse").asInt(), field(g, "pass").asInt(),
                field(g, "retryMinutes").asInt(), field(g, "xp").asInt(), field(g, "essence").asInt(), Map.copyOf(items));
        JsonNode e = field(k, "essencePerDay");
        double[] perDay = new double[e.size()];
        for (int i = 0; i < perDay.length; i++) perDay[i] = e.get(i).asDouble();
        return new GardenRules.KnowledgeRules(List.copyOf(slots), field(k, "cards").asInt(), field(k, "evidenceCap").asInt(),
                List.copyOf(stages), graduation, perDay, field(k, "essenceStoreDays").asDouble(),
                field(k, "candidateLimit").asInt());
    }

    static GardenRules.LearningRules learning(JsonNode l) {
        Map<String, GardenRules.SourceRule> sources = new LinkedHashMap<>();
        field(l, "sources").fields().forEachRemaining(e -> sources.put(e.getKey(), new GardenRules.SourceRule(e.getKey(),
                field(e.getValue(), "category").asText(), field(e.getValue(), "enabled").asBoolean(),
                field(e.getValue(), "minCount").asInt())));
        Map<String, GardenRules.CategoryRule> categories = new LinkedHashMap<>();
        field(l, "categories").fields().forEachRemaining(e -> categories.put(e.getKey(), new GardenRules.CategoryRule(
                field(e.getValue(), "xp").asInt(), field(e.getValue(), "dailyCap").asInt(),
                field(e.getValue(), "fertilizerFirst").asInt())));
        return new GardenRules.LearningRules(Map.copyOf(sources), Map.copyOf(categories), field(l, "lookbackDays").asInt(),
                field(l, "batchLimit").asInt());
    }

    static List<double[]> schedule(JsonNode rows) {
        List<double[]> out = new ArrayList<>();
        rows.forEach(n -> out.add(new double[]{n.get(0).asDouble(), n.get(1).asDouble()}));
        return List.copyOf(out);
    }

    /** A required field of a JSON configuration object (fails loudly, never a code default). */
    /**
     * Phase 3G rules ({@code garden_config.social}, V88); {@code null} on a database without the key — the garden then
     * has no social islands and behaves exactly like Phase 3F.
     */
    public com.englishcoach.garden.domain.SocialRules loadSocial() {
        List<String> rows = jdbc.queryForList("SELECT value::text FROM public.garden_config WHERE key = 'social'", String.class);
        return rows.isEmpty() ? null : social(parse(rows.getFirst()));
    }

    static com.englishcoach.garden.domain.SocialRules social(JsonNode s) {
        JsonNode t = field(s, "theft");
        java.util.Set<String> excluded = new java.util.LinkedHashSet<>();
        field(t, "excludedCrops").forEach(n -> excluded.add(n.asText()));
        var theft = new com.englishcoach.garden.domain.SocialRules.Theft(field(t, "fractionBp").asInt(), field(t, "windowHours").asInt(),
                field(t, "thiefCap").asInt(), field(t, "pairCap").asInt(), field(t, "victimCap").asInt(), field(t, "shieldHours").asInt(),
                field(t, "introHours").asInt(), field(t, "reopenHours").asInt(), field(t, "ripeGraceMinutes").asInt(),
                java.util.Set.copyOf(excluded));
        JsonNode d = field(s, "discovery");
        var discovery = new com.englishcoach.garden.domain.SocialRules.Discovery(field(d, "pageSize").asInt(),
                field(d, "searchLimit").asInt(), field(d, "minQuery").asInt());
        JsonNode r = field(s, "reactions");
        List<String> codes = new ArrayList<>();
        field(r, "codes").forEach(n -> codes.add(n.asText()));
        JsonNode a = field(s, "activity");
        return new com.englishcoach.garden.domain.SocialRules(field(s, "portionsPerUnit").asInt(), theft, discovery,
                field(field(s, "visits"), "historyLimit").asInt(), field(a, "pageSize").asInt(), field(a, "reactionLimit").asInt(),
                List.copyOf(codes), field(r, "cooldownHours").asInt());
    }

    /** Phase 3H rules (livestock, guardians, feed, products): null on a database without the {@code animals} key. */
    public com.englishcoach.garden.domain.AnimalRules loadAnimals() {
        List<String> rows = jdbc.queryForList("SELECT value::text FROM public.garden_config WHERE key = 'animals'", String.class);
        return rows.isEmpty() ? null : animals(parse(rows.getFirst()));
    }

    /**
     * Phase 3H: the visibility a garden's social profile starts with while its owner has not chosen ({@code PRIVATE} from
     * V89 on); null on a database from before V89, where a profile starts open and counts as chosen.
     */
    public String loadSocialDefaultVisibility() {
        List<String> rows = jdbc.queryForList("SELECT value::text FROM public.garden_config WHERE key = 'socialOnboarding'", String.class);
        return rows.isEmpty() ? null : field(parse(rows.getFirst()), "defaultVisibility").asText();
    }

    static com.englishcoach.garden.domain.AnimalRules animals(JsonNode a) {
        JsonNode f = field(a, "feed");
        Map<String, Integer> mill = new java.util.LinkedHashMap<>();
        field(f, "mill").fields().forEachRemaining(e -> mill.put(e.getKey(), e.getValue().asInt()));
        var feed = new com.englishcoach.garden.domain.AnimalRules.Feed(field(f, "item").asText(),
                java.util.Collections.unmodifiableMap(mill), field(f, "maxHours").asInt(), field(f, "learningBonusBp").asInt());
        JsonNode w = field(a, "water");
        var water = new com.englishcoach.garden.domain.AnimalRules.Water(field(w, "item").asText(), field(w, "hours").asInt(),
                field(w, "refillBelowHours").asInt());
        List<com.englishcoach.garden.domain.AnimalRules.House> houses = new ArrayList<>();
        field(a, "houses").forEach(h -> houses.add(new com.englishcoach.garden.domain.AnimalRules.House(field(h, "code").asText(),
                field(h, "nameVi").asText(), field(h, "species").asText(), field(h, "minLevel").asInt(), field(h, "coins").asLong(),
                field(h, "capacity").asInt())));
        List<com.englishcoach.garden.domain.AnimalRules.Livestock> livestock = new ArrayList<>();
        field(a, "livestock").forEach(l -> livestock.add(new com.englishcoach.garden.domain.AnimalRules.Livestock(
                field(l, "species").asText(), field(l, "nameVi").asText(), field(l, "babyVi").asText(), field(l, "coins").asLong(),
                field(l, "growHours").asInt(), field(l, "rationFeed").asInt(), field(l, "rationHours").asInt(),
                field(l, "product").asText(), field(l, "productHours").asInt(), field(l, "storeCap").asInt())));
        List<com.englishcoach.garden.domain.AnimalRules.Product> products = new ArrayList<>();
        field(a, "products").forEach(p -> products.add(new com.englishcoach.garden.domain.AnimalRules.Product(field(p, "code").asText(),
                field(p, "nameVi").asText(), field(p, "sell").asLong())));
        JsonNode c = field(a, "compost");
        var compost = new com.englishcoach.garden.domain.AnimalRules.Compost(field(c, "product").asText(), field(c, "manure").asInt(),
                field(c, "gives").asText(), field(c, "dailyCap").asInt());
        List<com.englishcoach.garden.domain.AnimalRules.Guardian> guardians = new ArrayList<>();
        field(a, "guardians").forEach(g -> guardians.add(new com.englishcoach.garden.domain.AnimalRules.Guardian(
                field(g, "species").asText(), field(g, "nameVi").asText(), field(g, "minLevel").asInt(), field(g, "coins").asLong(),
                field(g, "rationFeed").asInt(), field(g, "rationHours").asInt(), g.path("cooldownHours").asInt(0),
                g.path("shieldHours").asInt(0), g.path("graceMinutes").asInt(0), g.path("pestCapReduction").asInt(0))));
        return com.englishcoach.garden.domain.AnimalRules.of(feed, water, field(a, "restGrowthBp").asInt(), houses, livestock,
                products, compost, guardians);
    }

    static JsonNode field(JsonNode node, String name) {
        JsonNode n = node == null ? null : node.get(name);
        if (n == null || n.isNull()) throw new IllegalStateException("missing garden_config field " + name);
        return n;
    }

    private JsonNode parse(String text) {
        try {
            return json.readTree(text);
        } catch (Exception e) {
            throw new IllegalStateException("invalid garden configuration JSON", e);
        }
    }

    private static JsonNode req(Map<String, JsonNode> cfg, String key) {
        JsonNode n = cfg.get(key);
        if (n == null || n.isNull()) throw new IllegalStateException("missing garden_config key " + key);
        return n;
    }
}
