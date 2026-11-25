package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.FarmingEngine.Treatment;
import com.englishcoach.garden.domain.FarmingRules.Effect;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GardenRules.QualityTier;
import com.englishcoach.garden.domain.KnowledgeEvaluator.CardFacts;
import com.englishcoach.garden.domain.WeatherCalendar.Weather;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Deterministic economy simulation over the SAME domain classes the services use (growth with seasons + weather,
 * quality, rewards, levels, Knowledge Tree evidence + essence, pest windows). Phase 2 reality: six plots, flashcard
 * reviews (water, XP), skill lessons (fertilizer, XP, capped), vocabulary games (XP, capped), daily goal variants, seeds
 * bought at planting (Epic seeds also cost essence), Knowledge Trees on real-card evidence with essence and graduation
 * (Lan Pha Lê seed), Forgotten Pests on overdue words. No shop / plot / decor sinks (Phase 3).
 *
 * <p>Every visit harvests what is ready, answers the recall questions ({@code recallCorrect} of 3; skipped for a share
 * of harvests), sells (at once, under the blessing, or on the day's last visit), claims essence when the trees are
 * healthy, replants the best crop for the gap until the next visit (strategy: profit or coins per hour) and spends free
 * care. XP is recorded per source so the cause of any pacing problem is visible.
 */
public final class EconomySimulator {

    /** {@code FAST_LOOP} (Phase 3D): coins per hour among Common crops only — the easiest repeatable loop. */
    public enum Strategy { PROFIT, COINS_PER_HOUR, FAST_LOOP }

    /**
     * @param presentEvery    days are grouped in cycles of this length; only the first {@code presentDays} of each cycle
     *                        are played (a returner who is away for days), 1 = every day
     * @param pestShare       share of played days on which one of the learner's words is overdue (a pest appears)
     * @param rescuesPests    the learner reviews the overdue word (pest weakens at study time)
     * @param plantsTrees     the learner plants Knowledge Trees and reviews their words when due
     */
    public record Persona(String code, String label, int cardsPerDay, int skillsPerDay, int gamesPerDay,
                          List<LocalTime> visits, int goalMissEveryNthDay, double skipShare, int recallCorrect,
                          LocalTime studyAt, int presentEvery, int presentDays, double pestShare, boolean rescuesPests,
                          boolean plantsTrees, Strategy strategy) {}

    /** XP by source for one day. */
    public record XpSources(long harvest, long codex, long cards, long goal, long skills, long games, long graduation,
                            long pests) {
        public long total() {
            return harvest + codex + cards + goal + skills + games + graduation + pests;
        }
    }

    /** {@code income}: net coins of the day (sales minus seed purchases). */
    public record Day(int day, boolean present, long income, long sales, long coins, long totalXp, int level,
                      int freeWater, int waterUsed, int fertilizerGained, int plantings, boolean blessing,
                      XpSources xp, int essence, int essenceGained, int graduations, int pests, int trees,
                      Map<String, Integer> planted, Map<String, Integer> tiers) {}

    // ------------------------------------------------------------------ Phase 3A (market, orders, expansion)

    /** How a persona uses the market: never, only when a fertilizer makes a crop ripe before the next visit, or always. */
    public enum MarketStyle { NONE, USEFUL, MAX }

    /** Phase 3A behaviour of a persona; {@code null} policy = the Phase 2 simulation, unchanged. */
    public record Policy(MarketStyle market, boolean orders, boolean expands) {}

    /**
     * Phase 3A flows of one day. {@code sinks} = market + expansion coins; {@code ordersOpened}: orders materialized;
     * {@code compost}: produce units composted into new beds.
     */
    public record Economy(int day, int plots, long marketSpend, long expansionSpend, long orderCoins, int ordersOpened,
                          int ordersFilled, int ordersExpired, int fertilizerBought, int premiumBought, int packsBought,
                          int compost, long seedSpend, long sales, Map<String, Integer> delivered) {
        public long sinks() {
            return marketSpend + expansionSpend;
        }
    }

    // ------------------------------------------------------------------ Phase 3C (buildings, land, compost, staged pests)

    /** Phase 3C behaviour of a persona; {@code null} = the Phase 3A simulation, unchanged. */
    public record EstatePolicy(boolean buildings, boolean land, boolean compost) {}

    /**
     * Phase 3C flows of one day: coins spent on building levels and regional beds, produce consumed by them, compost
     * batches, the verified learning days so far (the land discount) and the building levels at the end of the day.
     */
    public record Estate(int day, int plots, long buildingSpend, long landSpend, int materials, int compostBatches,
                         int learningDays, Map<String, Integer> buildings) {
        public long sinks() {
            return buildingSpend + landSpend;
        }
    }

    // ------------------------------------------------------------------ Phase 3D (soil, supplies, harvest bonus)

    /**
     * Phase 3D behaviour of a persona; {@code null} = the Phase 3C simulation, unchanged. {@code tendsSoil}: waters a
     * crop that is dry or will dry before the next visit; {@code buysWater}: buys well water when it has no water;
     * {@code protectMinSell}: buys covers, drainage, mulch and tonics for crops selling for at least this much (-1 =
     * never); {@code guardsPests}: buys sprays and nets.
     */
    public record FarmingPolicy(boolean tendsSoil, boolean buysWater, int protectMinSell, boolean guardsPests) {}

    /**
     * Phase 3D flows of one day: harvest-bonus coins, coins spent on supplies and how many were used, harvests, those
     * whose care score was reduced by stressed soil, and visits that found a dry / waterlogged crop.
     */
    public record Farming(int day, long bonusCoins, long supplySpend, int suppliesUsed, int harvests, int stressedHarvests,
                          int dryFinds, int wetFinds) {}

    public record Result(Persona persona, List<Day> days, List<Economy> economy, List<Estate> estate, List<Farming> farming) {
        public Result(Persona persona, List<Day> days) {
            this(persona, days, List.of(), List.of(), List.of());
        }

        public Result(Persona persona, List<Day> days, List<Economy> economy) {
            this(persona, days, economy, List.of(), List.of());
        }

        public Result(Persona persona, List<Day> days, List<Economy> economy, List<Estate> estate) {
            this(persona, days, economy, estate, List.of());
        }

        public long farmingSum(java.util.function.ToLongFunction<Farming> f, int fromDay, int toDay) {
            return farming.stream().filter(e -> e.day() >= fromDay && e.day() <= toDay).mapToLong(f).sum();
        }

        public long estateSum(java.util.function.ToLongFunction<Estate> f, int fromDay, int toDay) {
            return estate.stream().filter(e -> e.day() >= fromDay && e.day() <= toDay).mapToLong(f).sum();
        }

        /** First day at the end of which every building is at its top level; -1 if never. */
        public int dayAllBuildings(int topLevel) {
            return estate.stream().filter(e -> e.buildings().size() >= 3 && e.buildings().values().stream().allMatch(l -> l >= topLevel))
                    .mapToInt(Estate::day).findFirst().orElse(-1);
        }

        /** First day at the end of which the persona owns at least {@code plots} beds; -1 if never. */
        public int dayOwningPlots(int plots) {
            return economy.stream().filter(e -> e.plots() >= plots).mapToInt(Economy::day).findFirst().orElse(-1);
        }

        public long sum(java.util.function.ToLongFunction<Economy> f, int fromDay, int toDay) {
            return economy.stream().filter(e -> e.day() >= fromDay && e.day() <= toDay).mapToLong(f).sum();
        }

        public long coinsAt(int day) {
            return days.stream().filter(d -> d.day() == day).mapToLong(Day::coins).findFirst().orElse(-1);
        }

        public double avgIncome(int fromDay, int toDay) {
            return days.stream().filter(d -> d.day() >= fromDay && d.day() <= toDay).mapToLong(Day::income).average().orElse(0);
        }

        /** First day (1-based) at the END of which the level is at least {@code level}; -1 if never. */
        public int dayReaching(int level) {
            return days.stream().filter(d -> d.level() >= level).mapToInt(Day::day).findFirst().orElse(-1);
        }

        public double avg(java.util.function.ToIntFunction<Day> f, int fromDay, int toDay) {
            return days.stream().filter(d -> d.day() >= fromDay && d.day() <= toDay).mapToInt(f).average().orElse(0);
        }

        public XpSources xpUntil(int day) {
            long[] s = new long[8];
            days.stream().filter(d -> d.day() <= day).forEach(d -> {
                var x = d.xp();
                s[0] += x.harvest(); s[1] += x.codex(); s[2] += x.cards(); s[3] += x.goal();
                s[4] += x.skills(); s[5] += x.games(); s[6] += x.graduation(); s[7] += x.pests();
            });
            return new XpSources(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]);
        }

        public Map<String, Integer> plantedCounts(int fromDay, int toDay) {
            Map<String, Integer> out = new LinkedHashMap<>();
            days.stream().filter(d -> d.day() >= fromDay && d.day() <= toDay)
                    .forEach(d -> d.planted().forEach((k, v) -> out.merge(k, v, Integer::sum)));
            return out;
        }

        public Map<String, Integer> tierCounts(int fromDay, int toDay) {
            Map<String, Integer> out = new LinkedHashMap<>();
            days.stream().filter(d -> d.day() >= fromDay && d.day() <= toDay)
                    .forEach(d -> d.tiers().forEach((k, v) -> out.merge(k, v, Integer::sum)));
            return out;
        }
    }

    private static final class Plot {
        CropDef crop;
        long id;
        Instant plantedAt;
        int baseSeconds;
        double boost;
        int water;
        boolean fertilized;
        Instant pestAt;
        Instant pestReviewedAt;
        // Phase 3D: growth model 2 (soil), its care events and a per-instant cache of the soil timeline
        boolean soil;
        final List<Instant> waterTimes = new ArrayList<>();
        final List<Treatment> treatments = new ArrayList<>();
        SoilModel.Timeline timeline;
        Instant timelineAt;
        int timelineKey;
    }

    private static final class Tree {
        Instant plantedAt;
        int peak = 1;
        double banked;
        Instant since;
        int attempts;
    }

    private record Produce(String crop, String tier) {}

    /** The purchase a persona saves for: the next V80 bed, a building level or a regional bed (cheapest first). */
    private record Goal(String kind, String code, int slot, int level, long coins, Map<String, Integer> materials) {}

    /** Per-run Phase 3C state (null while the Phase 3A simulation runs). */
    private static final class Run3c {
        final EstatePolicy policy;
        final Map<String, Integer> levels = new HashMap<>();
        final Set<Integer> land = new HashSet<>();
        int orders;
        int harvests;
        int learningDays;
        long buildingSpend;
        long landSpend;
        int materials;
        int compost;

        Run3c(EstatePolicy policy) {
            this.policy = policy;
        }
    }

    private final GardenRules rules;
    private final GrowthCalculator growth;
    private final QualityCalculator quality;
    private final RewardEngine rewards;
    private final LevelCurve levels;
    private final GardenCalendar calendar;
    private final WeatherCalendar weather;
    private final KnowledgeEvaluator knowledge;
    private final FarmEconomyRules economy;
    private final MarketEngine market;
    private final OrderEngine orders;
    private final EstateEngine estate;
    private final FarmingEngine farming;
    /** the Phase 3C state of the run in progress (the simulator is single-threaded) */
    private Run3c cur;
    /** the Phase 3D state of the run in progress (null while an earlier simulation runs) */
    private Run3d cur3d;

    /** Per-run Phase 3D counters (day values are reset at the start of each day). */
    private static final class Run3d {
        final FarmingPolicy policy;
        int bonusToday;
        long bonus;
        long supplySpend;
        int supplies;
        int harvests;
        int stressed;
        int dry;
        int wet;

        Run3d(FarmingPolicy policy) {
            this.policy = policy;
        }
    }

    /** An order on the simulated board: frozen spec, its period and whether it was delivered. */
    private static final class SimOrder {
        final String period;
        final OrderEngine.Spec spec;
        final Instant expires;
        boolean filled;

        SimOrder(String period, OrderEngine.Spec spec, Instant expires) {
            this.period = period;
            this.spec = spec;
            this.expires = expires;
        }
    }

    public EconomySimulator(GardenRules rules) {
        this(rules, null);
    }

    public EconomySimulator(GardenRules rules, FarmEconomyRules economy) {
        this(rules, economy, null);
    }

    /** Phase 3C: the same simulation with the estate rules (buildings, regions, compost, staged pest damage). */
    public EconomySimulator(GardenRules rules, FarmEconomyRules economy, EstateRules estateRules) {
        this(rules, economy, estateRules, null);
    }

    /** Phase 3D: the same simulation with the farming rules (soil moisture, supplies, harvest bonus). */
    public EconomySimulator(GardenRules rules, FarmEconomyRules economy, EstateRules estateRules, FarmingRules farmingRules) {
        this.farming = farmingRules == null ? null : new FarmingEngine(rules, farmingRules);
        this.rules = rules;
        this.estate = estateRules == null ? null : new EstateEngine(estateRules);
        this.economy = economy;
        this.market = economy == null ? null : new MarketEngine(rules, economy);
        this.orders = economy == null ? null : new OrderEngine(rules, economy);
        this.growth = new GrowthCalculator(rules);
        this.quality = new QualityCalculator(rules);
        this.rewards = new RewardEngine(rules);
        this.levels = new LevelCurve(rules);
        this.calendar = new GardenCalendar(rules);
        this.weather = new WeatherCalendar(rules);
        this.knowledge = new KnowledgeEvaluator(rules);
    }

    public static List<Persona> standardPersonas() {
        var three = List.of(LocalTime.of(8, 0), LocalTime.of(13, 0), LocalTime.of(21, 0));
        var two = List.of(LocalTime.of(7, 30), LocalTime.of(21, 30));
        var eight = List.of(LocalTime.of(7, 30), LocalTime.of(9, 30), LocalTime.of(11, 30), LocalTime.of(13, 30),
                LocalTime.of(15, 30), LocalTime.of(17, 30), LocalTime.of(19, 30), LocalTime.of(21, 30));
        var noon = LocalTime.of(12, 0);
        return List.of(
                new Persona("P0", "chỉ làm vườn", 0, 0, 0, three, 1, 0.30, 2, noon, 1, 1, 0, false, false, Strategy.PROFIT),
                new Persona("P1", "học viên thường (20 thẻ)", 20, 0, 0, three, 7, 0.0, 2, noon, 1, 1, 0.25, true, true, Strategy.PROFIT),
                new Persona("P2", "học viên tích cực (60 thẻ + 2 bài kỹ năng)", 60, 2, 0, three, 0, 0.0, 2, noon, 1, 1, 0.10, true, true, Strategy.PROFIT),
                new Persona("P3", "ghé vườn thường xuyên (20 thẻ, 8 lần/ngày)", 20, 0, 0, eight, 7, 0.0, 2, noon, 1, 1, 0.25, true, true, Strategy.PROFIT),
                new Persona("P4", "quay lại sau vài ngày (2 ngày chơi / 5)", 20, 0, 0, two, 0, 0.0, 2, noon, 5, 2, 0.6, true, true, Strategy.PROFIT),
                new Persona("P5", "bỏ qua một phần việc học (10 thẻ, 1 trò chơi)", 10, 0, 1, three, 0, 0.0, 2, noon, 1, 1, 0.5, false, false, Strategy.PROFIT),
                new Persona("P6", "tối đa doanh thu (20 thẻ, 8 lần/ngày, xu/giờ)", 20, 0, 0, eight, 7, 0.0, 3, noon, 1, 1, 0.25, true, true, Strategy.COINS_PER_HOUR));
    }

    /** Phase 3A personas: the seven standard ones plus P7, an order / market exploit maximizer. */
    public static List<Persona> phase3aPersonas() {
        List<Persona> out = new ArrayList<>(standardPersonas());
        var eight = List.of(LocalTime.of(7, 30), LocalTime.of(9, 30), LocalTime.of(11, 30), LocalTime.of(13, 30),
                LocalTime.of(15, 30), LocalTime.of(17, 30), LocalTime.of(19, 30), LocalTime.of(21, 30));
        out.add(new Persona("P7", "khai thác tối đa (đơn hàng + chợ, 8 lần/ngày, xu/giờ)", 20, 0, 0, eight, 7, 0.0, 3,
                LocalTime.of(12, 0), 1, 1, 0.25, true, true, Strategy.COINS_PER_HOUR));
        return List.copyOf(out);
    }

    /** Phase 3A behaviour per persona: everyone may fill orders and buy beds; P5 never shops, P7 buys everything. */
    public static Policy phase3aPolicy(Persona p) {
        return switch (p.code()) {
            case "P5" -> new Policy(MarketStyle.NONE, true, true);
            case "P7" -> new Policy(MarketStyle.MAX, true, true);
            default -> new Policy(MarketStyle.USEFUL, true, true);
        };
    }

    public Result run(Persona persona, int days) {
        return run(persona, days, null);
    }

    /** Phase 3C behaviour per persona: everyone invests in buildings and land; only the exploit maximizer composts. */
    public static EstatePolicy phase3cPolicy(Persona p) {
        return new EstatePolicy(true, true, p.code().equals("P7") || p.code().equals("P2"));
    }

    public Result run(Persona persona, int days, Policy policy) {
        return run(persona, days, policy, null);
    }

    public Result run(Persona persona, int days, Policy policy, EstatePolicy estatePolicy) {
        return run(persona, days, policy, estatePolicy, null);
    }

    /** Phase 3D personas: the eight Phase 3A ones plus P8 (protection-heavy) and P9 (the easiest repeatable coin loop). */
    public static List<Persona> phase3dPersonas() {
        List<Persona> out = new ArrayList<>(phase3aPersonas());
        var three = List.of(LocalTime.of(8, 0), LocalTime.of(13, 0), LocalTime.of(21, 0));
        List<LocalTime> hourly = new ArrayList<>();
        for (int h = 7; h <= 22; h++) hourly.add(LocalTime.of(h, 0));
        out.add(new Persona("P8", "che chắn kỹ (20 thẻ, mua vật tư cho mọi cây, không ôn từ quá hạn)", 20, 0, 0, three, 7, 0.0, 2,
                LocalTime.of(12, 0), 1, 1, 0.5, false, true, Strategy.PROFIT));
        out.add(new Persona("P9", "vòng lặp dễ nhất (cây thường, 16 lần/ngày)", 0, 0, 0, List.copyOf(hourly), 1, 0.0, 2,
                LocalTime.of(12, 0), 1, 1, 0, false, false, Strategy.FAST_LOOP));
        return List.copyOf(out);
    }

    /** Phase 3D behaviour per persona. */
    public static FarmingPolicy phase3dPolicy(Persona p) {
        return switch (p.code()) {
            case "P4" -> new FarmingPolicy(true, false, -1, false);   // a returner waters what it finds dry, buys nothing
            case "P5", "P9" -> new FarmingPolicy(false, false, -1, false); // ignores the soil entirely
            case "P2", "P6" -> new FarmingPolicy(true, true, 200, false);
            case "P7" -> new FarmingPolicy(true, true, 200, true);
            case "P8" -> new FarmingPolicy(true, true, 0, true);
            default -> new FarmingPolicy(true, true, -1, false);       // P0, P1, P3: water only
        };
    }

    /**
     * One persona over {@code days}. {@code policy == null} reproduces the Phase 2 simulation exactly (six beds, no
     * market, no orders); otherwise the Phase 3A systems run through the same pure engines the services use.
     */
    public Result run(Persona persona, int days, Policy policy, EstatePolicy estatePolicy, FarmingPolicy farmingPolicy) {
        boolean p3 = policy != null && economy != null;
        Run3c st = p3 && estate != null && estatePolicy != null ? new Run3c(estatePolicy) : null;
        cur = st;
        Run3d fr = st != null && farming != null && farmingPolicy != null ? new Run3d(farmingPolicy) : null;
        cur3d = fr;
        List<Farming> farmingDays = new ArrayList<>();
        List<Estate> estateDays = new ArrayList<>();
        LocalDate start = rules.seasons().epochMonday();
        long coins = rules.starter().coins();
        long xp = 0;
        int essence = 0;
        Map<String, Integer> items = new HashMap<>(rules.starter().items());
        Map<Produce, Integer> produce = new HashMap<>();
        List<Plot> plots = new ArrayList<>();
        for (int i = 0; i < 6; i++) plots.add(new Plot());
        Tree[] trees = new Tree[rules.knowledge().slotLevels().size()];
        boolean firstPlanting = true;
        List<Day> out = new ArrayList<>();
        List<Economy> econ = new ArrayList<>();
        int skipCounter = 0;
        long plantingSeq = 0;
        Set<String> codex = new HashSet<>();
        int slots = p3 ? economy.orders().slots() : 0;
        SimOrder[] board = new SimOrder[slots + 1];
        Set<SimOrder> declined = new HashSet<>();
        Map<String, Integer> bought = new HashMap<>(); // offer code -> units bought on the current day
        long userId = DeterministicRandom.hash("sim-user:" + persona.code()) & 0xffffL;

        for (int d = 0; d < days; d++) {
            LocalDate day = start.plusDays(d);
            boolean present = (d % persona.presentEvery()) < persona.presentDays();
            // XP gained today by source: harvest, codex, cards, goal, skills, games, graduation, pests
            long[] xs = new long[8];
            Map<String, Integer> planted = new LinkedHashMap<>();
            Map<String, Integer> tiersToday = new LinkedHashMap<>();
            long sales = 0;
            long seedSpend = 0;
            int waterUsed = 0;
            int plantings = 0;
            int freeWater = 0;
            int fertGained = 0;
            int essenceGained = 0;
            int graduations = 0;
            int pestsToday = 0;
            boolean goal = false;
            // Phase 3A counters of the day
            long marketSpend = 0, packSpend = 0, expansionSpend = 0, orderCoins = 0;
            int opened = 0, filled = 0, expired = 0, fertBought = 0, premiumBought = 0, packsBought = 0, compost = 0;
            Map<String, Integer> delivered = new LinkedHashMap<>();
            bought.clear();
            EstateEngine.Perks perks = st == null ? EstateEngine.Perks.NONE : estate.perks(st.levels);
            List<MarketEngine.Offer> offers = p3 ? market.offers(day, perks) : List.of();
            long buildingSpend0 = st == null ? 0 : st.buildingSpend, landSpend0 = st == null ? 0 : st.landSpend;
            int materials0 = st == null ? 0 : st.materials, compost0 = st == null ? 0 : st.compost;
            int compostToday = 0;
            long bonus0 = fr == null ? 0 : fr.bonus, supply0 = fr == null ? 0 : fr.supplySpend;
            int supplies0 = fr == null ? 0 : fr.supplies, harvests0 = fr == null ? 0 : fr.harvests;
            int stressed0 = fr == null ? 0 : fr.stressed, dry0 = fr == null ? 0 : fr.dry, wet0 = fr == null ? 0 : fr.wet;
            if (fr != null) fr.bonusToday = 0;
            Instant studyAt = at(day, persona.studyAt());
            if (present) {
                boolean missGoal = persona.goalMissEveryNthDay() == 1
                        || (persona.goalMissEveryNthDay() > 1 && (d + 1) % persona.goalMissEveryNthDay() == 0);
                // learning: distinct cards (R2) studied once a day; a goal-miss day studies half of them
                int cards = missGoal ? persona.cardsPerDay() / 2 : persona.cardsPerDay();
                var stats = RewardEngine.DayStats.empty();
                for (int c = 0; c < cards; c++) {
                    var delta = rewards.applyReview(stats, true);
                    stats = delta.after();
                    freeWater += delta.water();
                    xs[2] += delta.xp();
                }
                items.merge("WATER", freeWater, Integer::sum);
                int skills = 0;
                for (int s = 0; s < persona.skillsPerDay(); s++) {
                    var credit = rewards.creditActivity("SKILL", skills);
                    if (credit.credited()) skills++;
                    xs[4] += credit.xp();
                    fertGained += credit.fertilizer();
                }
                int games = 0;
                for (int g = 0; g < persona.gamesPerDay(); g++) {
                    var credit = rewards.creditActivity("GAME", games);
                    if (credit.credited()) games++;
                    xs[5] += credit.xp();
                }
                items.merge("FERTILIZER", fertGained, Integer::sum);
                // the due queue never empties for these personas (large NEW backlogs): unit or mixed goal only
                goal = rewards.goalReached(stats, 1, skills);
                if (goal) xs[3] += rules.rewards().goalXp();
                xp += xs[2] + xs[3] + xs[4] + xs[5];
                // Phase 3C: a verified learning day (five different cards or one credited lesson) lowers land prices
                if (st != null && (cards >= 5 || skills > 0 || games > 0)) st.learningDays++;
            }
            boolean pestDay = present && persona.pestShare() > 0
                    && DeterministicRandom.unit("sim-pest:" + persona.code() + ":" + d) < persona.pestShare();
            boolean pestPlaced = false;
            double rawHarvestXp = 0;

            List<LocalTime> visits = present ? persona.visits() : List.of();
            for (int v = 0; v < visits.size(); v++) {
                Instant now = at(day, visits.get(v));
                Instant next = nextVisit(persona, d, v, start);
                boolean blessing = goal && !now.isBefore(studyAt);
                boolean rainbow = weather.at(now) == Weather.RAINBOW;

                // 3A-0. the state read materializes the board: a new period replaces an unfilled order (expired)
                if (p3 && policy.orders()) {
                    for (int s = 1; s <= slots; s++) {
                        var kind = orders.kindOf(s);
                        String period = orders.periodKey(kind, now);
                        SimOrder cur = board[s];
                        if (cur != null && cur.period.equals(period)) continue;
                        if (cur != null && !cur.filled) expired++;
                        if (cur != null) declined.remove(cur);
                        board[s] = null;
                        var spec = orders.generate(userId, s, now, levels.level(xp), plots.size());
                        if (spec.isPresent()) {
                            board[s] = new SimOrder(period, spec.get(), orders.expiresAt(kind, now));
                            opened++;
                        }
                    }
                }

                // 0. pests (the server spawns on the state read that opens the visit): one overdue word settles on
                //    the oldest crop, ripe or growing; a rescuer reviews it before harvesting
                if (pestDay && !pestPlaced) {
                    Plot host = plots.stream().filter(p -> p.crop != null && p.pestAt == null
                                    && (fr == null || !farming.active(p.treatments, Effect.PEST_NET, now))
                                    && !now.isBefore(p.plantedAt.plus(Duration.ofMinutes(rules.pests().protectMinutes()))))
                            .min(Comparator.comparing(p -> p.plantedAt)).orElse(null);
                    if (host != null) {
                        pestPlaced = true;
                        host.pestAt = now;
                        pestsToday++;
                        if (persona.rescuesPests()) {
                            host.pestReviewedAt = now;
                            xs[7] += rules.pests().cureXp();
                            xp += rules.pests().cureXp();
                        }
                    }
                }
                // 1. harvest
                for (Plot p : plots) {
                    if (p.crop == null) continue;
                    var snap = growth.evaluate(facts(p, now), now);
                    if (!snap.ready()) continue;
                    boolean skip = persona.skipShare() > 0 && (skipCounter++ % 10) < Math.round(persona.skipShare() * 10);
                    boolean clean = p.pestAt == null || (p.pestReviewedAt != null && !p.pestReviewedAt.isAfter(now));
                    boolean tended = p.water > 0 || p.fertilized || (p.soil && !p.treatments.isEmpty());
                    var input = new QualityCalculator.Input(persona.recallCorrect(), skip, clean,
                            quality.seasonFit(p.crop, p.plantedAt, now), tended,
                            quality.fresh(p.baseSeconds, snap.readyAt(), now, perks.freshBonus()));
                    // Phase 3C: the damage stage of an unreviewed pest decides the pest part (a warning costs nothing)
                    QualityCalculator.Result q;
                    if (st == null) {
                        q = quality.score(input);
                    } else if (fr == null) {
                        q = quality.score(input, estate.harvestPestScore(pestFacts(p), now, rules.quality().pestClean()));
                    } else {
                        // Phase 3D: a spray softens an unresolved pest, the soil the crop ripened with scales the care
                        // points, and the closed harvest pays its small coin bonus under the day's cap
                        int pestScore = farming.sprayedPestScore(estate.harvestPestScore(pestFacts(p), now, rules.quality().pestClean()),
                                p.treatments, now, rules.quality().pestClean());
                        int carePoints = tended ? rules.quality().cared() : 0;
                        if (p.soil) {
                            var care = farming.care(tended, timeline(p, now).at(snap.readyAt()),
                                    farming.everApplied(p.treatments, Effect.TONIC, now));
                            carePoints = care.points();
                            if (care.factor() < 1) fr.stressed++;
                            q = farming.capped(quality.score(input, pestScore, carePoints), care);
                        } else {
                            q = quality.score(input, pestScore, carePoints);
                        }
                        int bonus = farming.grantedBonus(farming.harvestBonus(p.crop), fr.bonusToday);
                        fr.bonusToday += bonus;
                        fr.bonus += bonus;
                        fr.harvests++;
                        coins += bonus;
                    }
                    if (st != null) st.harvests++;
                    produce.merge(new Produce(p.crop.code(), q.tier().code()), 1, Integer::sum);
                    tiersToday.merge(q.tier().code(), 1, Integer::sum);
                    int raw = quality.harvestXp(p.crop, q.tier());
                    long hx = rewards.harvestXpGain(rawHarvestXp, raw);
                    rawHarvestXp += raw;
                    xs[0] += hx;
                    xp += hx;
                    var forms = new ArrayList<>(List.of(q.tier().code()));
                    if (calendar.moonlit(now)) forms.add("MOONLIT");
                    if (rainbow) forms.add("RAINBOW");
                    if (quality.mutated(p.id, rainbow)) forms.add("MUTATED");
                    for (String f : forms) {
                        if (codex.add(p.crop.code() + ":" + f)) {
                            xs[1] += rules.quality().newFormXp();
                            xp += rules.quality().newFormXp();
                        }
                    }
                    p.crop = null;
                }
                // 3A-1. deliver orders the stock covers, when the order is worth at least ~a sale of those units
                if (p3 && policy.orders()) {
                    for (int s = 1; s <= slots; s++) {
                        SimOrder o = board[s];
                        if (o == null || o.filled || declined.contains(o) || !now.isBefore(o.expires)) continue;
                        var alloc = orders.allocate(o.spec.lines(), stock(produce));
                        if (alloc.isEmpty()) continue;
                        long saleValue = 0;
                        for (var sup : alloc.get()) {
                            saleValue += quality.unitSellPrice(rules.crop(sup.cropCode()), rules.quality().tier(sup.tier()), blessing) * sup.qty();
                        }
                        long paid = orders.payout(o.spec.coins(), blessing);
                        long value = paid;
                        for (var b : o.spec.bonus().entrySet()) value += itemValue(b.getKey()) * b.getValue();
                        if (value < 0.9 * saleValue) {
                            declined.add(o); // a blessing-day sale beats this order: the persona sells instead
                            continue;
                        }
                        for (var sup : alloc.get()) {
                            produce.merge(new Produce(sup.cropCode(), sup.tier()), -sup.qty(), Integer::sum);
                            delivered.merge(sup.cropCode(), sup.qty(), Integer::sum);
                        }
                        produce.values().removeIf(q -> q <= 0);
                        coins += paid;
                        orderCoins += paid;
                        o.spec.bonus().forEach((k, q) -> items.merge(k, q, Integer::sum));
                        o.filled = true;
                        filled++;
                        if (st != null) st.orders++;
                    }
                }
                // 3C. the storehouse's compost bin: surplus cheap produce becomes fertilizer (capped per day)
                if (st != null && st.policy.compost() && v == visits.size() - 1) {
                    var recipe = estate.rules().compost().standard();
                    Map<Produce, Integer> keep = reserve(produce, board, declined, now, plots.size(), xp, coins, goal, policy);
                    while (compostToday < estate.perks(st.levels).compostDaily() && items.getOrDefault("FERTILIZER", 0) < 2) {
                        int need = recipe.units();
                        List<Produce> cheap = produce.keySet().stream()
                                .sorted(Comparator.comparingDouble((Produce k) -> rules.crop(k.crop()).sellPrice()
                                        * rules.quality().tier(k.tier()).sellMultiplier()).thenComparing(Produce::crop).thenComparing(Produce::tier)).toList();
                        Map<Produce, Integer> take = new LinkedHashMap<>();
                        for (Produce k : cheap) {
                            if (need == 0) break;
                            int free = produce.getOrDefault(k, 0) - keep.getOrDefault(k, 0);
                            int t = Math.min(Math.max(0, free), need);
                            if (t > 0) {
                                take.put(k, t);
                                need -= t;
                            }
                        }
                        if (need > 0) break;
                        take.forEach((k, t) -> produce.merge(k, -t, Integer::sum));
                        produce.values().removeIf(q -> q <= 0);
                        items.merge(recipe.gives(), 1, Integer::sum);
                        compostToday++;
                        st.compost++;
                        st.materials += recipe.units();
                    }
                }
                // 2. sell (Phase 3A personas keep what open orders and the next bed need)
                boolean lastVisit = v == visits.size() - 1;
                if (persona.code().equals("P0") || blessing || lastVisit) {
                    Map<Produce, Integer> keep = p3 ? reserve(produce, board, declined, now, plots.size(), xp, coins, goal, policy) : Map.of();
                    long sale = 0;
                    for (var e : produce.entrySet()) {
                        int qty = e.getValue() - keep.getOrDefault(e.getKey(), 0);
                        if (qty <= 0) continue;
                        QualityTier tier = rules.quality().tier(e.getKey().tier());
                        sale += quality.unitSellPrice(rules.crop(e.getKey().crop()), tier, blessing) * qty;
                    }
                    produce.clear();
                    keep.forEach((k, q) -> {
                        if (q > 0) produce.put(k, q);
                    });
                    sales += sale;
                    coins += sale;
                }
                // 3A-2. buy the next bed: level + coins + composted produce (lowest tiers first).
                //       Phase 3C: the same step also buys building levels and regional beds, cheapest goal first
                if (p3 && policy.expands()) {
                    for (int bought3c = 0; bought3c < (st == null ? 1 : 3); bought3c++) {
                        Goal g = cheapestGoal(plots.size(), xp);
                        if (g == null || coins < g.coins() + (st == null ? 100 : LIQUIDITY * 4)) break;
                        var alloc = orders.allocate(g.materials().entrySet().stream()
                                .map(e -> new OrderEngine.Line(e.getKey(), e.getValue(), orders.lowestTier())).toList(), stock(produce));
                        if (alloc.isEmpty()) break;
                        int units = 0;
                        for (var sup : alloc.get()) {
                            produce.merge(new Produce(sup.cropCode(), sup.tier()), -sup.qty(), Integer::sum);
                            units += sup.qty();
                        }
                        produce.values().removeIf(q -> q <= 0);
                        coins -= g.coins();
                        switch (g.kind()) {
                            case "BED" -> {
                                compost += units;
                                expansionSpend += g.coins();
                                plots.add(new Plot());
                            }
                            case "BUILDING" -> {
                                st.levels.put(g.code(), g.level());
                                st.buildingSpend += g.coins();
                                st.materials += units;
                            }
                            default -> {
                                st.land.add(g.slot());
                                st.landSpend += g.coins();
                                st.materials += units;
                                plots.add(new Plot());
                            }
                        }
                    }
                }
                // 3A-3. market (MAX: every staple and pack up to its cap on the first visit)
                if (p3 && policy.market() == MarketStyle.MAX && v == 0) {
                    for (var o : offers) {
                        if (levels.level(xp) < o.unlockLevel()) continue;
                        while (bought.getOrDefault(o.code(), 0) < o.dailyCap() && coins >= o.price() + 300) {
                            coins -= o.price();
                            bought.merge(o.code(), 1, Integer::sum);
                            items.merge(o.item(), o.unitQty(), Integer::sum);
                            if (o.kind() == MarketEngine.Kind.PACK) {
                                packSpend += o.price();
                                packsBought++;
                            } else {
                                marketSpend += o.price();
                                if (o.item().equals("FERTILIZER_PREMIUM")) premiumBought++;
                                else fertBought++;
                            }
                        }
                    }
                }
                // 3. Knowledge Trees (first visit of the day): plant, evidence, essence, graduation
                if (persona.plantsTrees() && v == 0) {
                    for (int s = 0; s < trees.length; s++) {
                        if (trees[s] == null && levels.level(xp) >= rules.knowledge().slotLevels().get(s)) {
                            Tree t = new Tree();
                            t.plantedAt = now;
                            t.since = now;
                            trees[s] = t;
                        }
                        Tree t = trees[s];
                        if (t == null) continue;
                        var ev = knowledge.evaluate(t.plantedAt, t.peak, treeCards(t, now), now, false, null);
                        if (ev.stage() > t.peak) {
                            t.banked = knowledge.essenceAccrued(t.banked, t.since, t.peak, now);
                            t.since = now;
                            t.peak = ev.stage();
                        }
                        double acc = knowledge.essenceAccrued(t.banked, t.since, t.peak, now);
                        int claim = (int) Math.floor(acc + 1e-9);
                        if (claim > 0 && ev.health() == KnowledgeEvaluator.Health.HEALTHY) {
                            essence += claim;
                            essenceGained += claim;
                            t.banked = acc - claim;
                            t.since = now;
                        }
                        if (ev.graduationEligible()) {
                            t.attempts++;
                            boolean pass = persona.recallCorrect() >= 3 || t.attempts >= 2
                                    || DeterministicRandom.unit("sim-grad:" + persona.code() + ":" + d + ":" + s) < 0.7;
                            if (pass) {
                                var g = rules.knowledge().graduation();
                                xs[6] += g.xp();
                                xp += g.xp();
                                essence += g.essence();
                                essenceGained += g.essence();
                                g.items().forEach((k, q) -> items.merge(k, q, Integer::sum));
                                graduations++;
                                trees[s] = null;
                            }
                        }
                    }
                }
                // 4. plant (Phase 3A: crops still missing for an open order or the next bed come first)
                for (Plot p : plots) {
                    if (p.crop != null) continue;
                    CropDef demand = p3 ? demandCrop(produce, plots, board, declined, now, xp, coins, goal, items, policy) : null;
                    final CropDef pick = demand != null ? demand
                            : bestCrop(persona.strategy(), levels.level(xp), coins, essence, items, now, next, firstPlanting);
                    if (pick == null) continue;
                    String seedKey = "SEED:" + pick.code();
                    // USEFUL shoppers buy today's featured pack of the crop they are about to plant (cheaper seeds)
                    if (p3 && policy.market() == MarketStyle.USEFUL && items.getOrDefault(seedKey, 0) == 0) {
                        var pack = offers.stream().filter(o -> o.kind() == MarketEngine.Kind.PACK && pick.code().equals(o.cropCode())).findFirst();
                        if (pack.isPresent() && levels.level(xp) >= pack.get().unlockLevel()
                                && bought.getOrDefault(pack.get().code(), 0) < pack.get().dailyCap() && coins >= pack.get().price() * 3) {
                            coins -= pack.get().price();
                            packSpend += pack.get().price();
                            packsBought++;
                            bought.merge(pack.get().code(), 1, Integer::sum);
                            items.merge(seedKey, pack.get().unitQty(), Integer::sum);
                        }
                    }
                    if (items.getOrDefault(seedKey, 0) > 0) items.merge(seedKey, -1, Integer::sum);
                    else {
                        coins -= pick.seedPrice();
                        seedSpend += pick.seedPrice();
                        essence -= pick.seedEssence();
                    }
                    p.crop = pick;
                    p.id = ++plantingSeq;
                    p.plantedAt = now;
                    p.baseSeconds = firstPlanting && pick.code().equals(rules.growth().tutorialCrop())
                            ? rules.growth().tutorialSeconds() : pick.baseSeconds();
                    p.boost = 0;
                    p.water = 0;
                    p.fertilized = false;
                    p.pestAt = null;
                    p.pestReviewedAt = null;
                    // Phase 3D: every planting but the one-minute tutorial crop has soil
                    p.soil = fr != null && p.baseSeconds == pick.baseSeconds();
                    p.waterTimes.clear();
                    p.treatments.clear();
                    p.timeline = null;
                    firstPlanting = false;
                    plantings++;
                    planted.merge(pick.code(), 1, Integer::sum);
                }
                // 6. care: free water / fertilizer on the longest growing crops first
                List<Plot> growing = plots.stream().filter(p -> p.crop != null)
                        .sorted(Comparator.comparingInt((Plot p) -> -p.baseSeconds)).toList();
                for (Plot p : growing) {
                    var before = growth.evaluate(facts(p, now), now);
                    if (before.ready()) continue;
                    // 3D. soil and supplies: what a player sees on the plot card decides what it spends
                    if (fr != null) {
                        var fp = fr.policy;
                        List<String> want = new ArrayList<>();
                        boolean protect = fp.protectMinSell() >= 0 && p.crop.sellPrice() >= fp.protectMinSell() && p.baseSeconds >= 3 * 3600;
                        if (p.soil) {
                            var c = timeline(p, now).at(now);
                            Instant ripe = before.readyAt();
                            boolean soon = c.nextChangeAt() != null && c.nextChangeAt().isBefore(next) && (ripe == null || c.nextChangeAt().isBefore(ripe));
                            boolean dries = c.status() == SoilModel.Status.DRY || (soon && c.nextStatus() == SoilModel.Status.DRY);
                            boolean floods = c.status() == SoilModel.Status.WET || (soon && c.nextStatus() == SoilModel.Status.WET);
                            if (c.status() == SoilModel.Status.DRY) fr.dry++;
                            if (c.status() == SoilModel.Status.WET) fr.wet++;
                            if (fp.tendsSoil() && dries) {
                                var w0 = rules.boosts().get("WATER");
                                if (w0 != null && p.water < w0.perPlantingLimit() && items.getOrDefault("WATER", 0) > 0
                                        && p.boost + w0.fraction() <= rules.growth().maxBoost() + 1e-9) {
                                    items.merge("WATER", -1, Integer::sum);
                                    p.boost += w0.fraction();
                                    p.water++;
                                    waterUsed++;
                                    p.waterTimes.add(now);
                                } else if (fp.buysWater()) {
                                    long paid = takeSupply("WELL_WATER", coins, levels.level(xp), offers, bought, items);
                                    if (paid >= 0) {
                                        coins -= paid;
                                        fr.supplySpend += paid;
                                        fr.supplies++;
                                        p.treatments.add(new Treatment("WELL_WATER", now, null));
                                    }
                                }
                            }
                            if (protect && fp.protectMinSell() == 0) {
                                // the over-spender covers everything it may, needed or not
                                if (c.status() == SoilModel.Status.WET && !farming.active(p.treatments, Effect.DRAINAGE, now)) want.add("DRAINAGE");
                                else if (floods && !farming.active(p.treatments, Effect.RAIN_COVER, now)) want.add("RAIN_COVER");
                                if (p.baseSeconds >= 8 * 3600 && !farming.everApplied(p.treatments, Effect.MULCH, now)) want.add("MULCH");
                                if (dries && !farming.active(p.treatments, Effect.SHADE, now)) want.add("SHADE_NET");
                                if (!farming.everApplied(p.treatments, Effect.TONIC, now) && farming.soil().careFactor(c.stressShare()) < 1
                                        && before.fraction() > 0.5) want.add("CROP_TONIC");
                            } else if (protect) {
                                // the careful player reads the plot card: a supply is bought only when the forecast says
                                // it lifts the crop over a quality line and that is worth more than its price
                                boolean blessed = goal;
                                for (int round = 0; round < 2; round++) {
                                    double lossNow = soilLoss(p, now, null);
                                    if (lossNow <= 0) break;
                                    String best = null;
                                    double bestGain = 0;
                                    for (String code : List.of("MULCH", "SHADE_NET", "RAIN_COVER", "DRAINAGE", "CROP_TONIC")) {
                                        var item = farming.rules().item(code);
                                        boolean used = item.hours() <= 0 || item.effect() == Effect.TONIC
                                                ? farming.everApplied(p.treatments, item.effect(), now) : farming.active(p.treatments, item.effect(), now);
                                        if (used || want.contains(code)) continue;
                                        var offer = offers.stream().filter(o -> code.equals(o.item())).findFirst().orElse(null);
                                        if (offer == null) continue;
                                        double saved = (lossNow - soilLoss(p, now, code)) * p.crop.sellPrice() * (blessed ? rules.blessingSellMultiplier() : 1);
                                        double gain = saved - offer.price();
                                        if (gain > bestGain) {
                                            bestGain = gain;
                                            best = code;
                                        }
                                    }
                                    if (best == null) break;
                                    long paid = takeSupply(best, coins, levels.level(xp), offers, bought, items);
                                    if (paid < 0) break;
                                    coins -= paid;
                                    fr.supplySpend += paid;
                                    fr.supplies++;
                                    p.treatments.add(new Treatment(best, now, farming.expiresAt(farming.rules().item(best), now)));
                                }
                            }
                        }
                        if (fp.guardsPests()) {
                            if (p.pestAt != null && p.pestReviewedAt == null && !farming.active(p.treatments, Effect.PEST_SPRAY, now)
                                    && (protect || p.crop.sellPrice() >= 200)) want.add("ORGANIC_SPRAY");
                            if (protect && p.pestAt == null && !farming.active(p.treatments, Effect.PEST_NET, now)
                                    && (fp.protectMinSell() == 0 || p.crop.sellPrice() >= 500)) want.add("INSECT_NET");
                        }
                        for (String code : want) {
                            long paid = takeSupply(code, coins, levels.level(xp), offers, bought, items);
                            if (paid < 0) continue;
                            coins -= paid;
                            fr.supplySpend += paid;
                            fr.supplies++;
                            p.treatments.add(new Treatment(code, now, farming.expiresAt(farming.rules().item(code), now)));
                        }
                    }
                    // USEFUL shoppers buy a fertilizer only when it makes this crop ripe before the next visit
                    if (p3 && policy.market() == MarketStyle.USEFUL && !p.fertilized
                            && items.getOrDefault("FERTILIZER", 0) == 0 && items.getOrDefault("FERTILIZER_PREMIUM", 0) == 0
                            && before.readyAt() != null && before.readyAt().isAfter(next)) {
                        for (String code : List.of("FERTILIZER", "FERTILIZER_PREMIUM")) {
                            var offer = offers.stream().filter(o -> o.item().equals(code)).findFirst().orElse(null);
                            var boostItem = rules.boosts().get(code);
                            if (offer == null || boostItem == null || levels.level(xp) < offer.unlockLevel()
                                    || bought.getOrDefault(offer.code(), 0) >= offer.dailyCap() || coins < offer.price() + 200
                                    || p.boost + boostItem.fraction() > rules.growth().maxBoost() + 1e-9) continue;
                            double savedBoost = p.boost;
                            p.boost += boostItem.fraction();
                            var after = growth.evaluate(facts(p, now), now);
                            p.boost = savedBoost;
                            if (after.readyAt() == null || after.readyAt().isAfter(next)) continue;
                            coins -= offer.price();
                            marketSpend += offer.price();
                            bought.merge(offer.code(), 1, Integer::sum);
                            items.merge(code, 1, Integer::sum);
                            if (code.equals("FERTILIZER_PREMIUM")) premiumBought++;
                            else fertBought++;
                            break;
                        }
                    }
                    if (p3 && !p.fertilized && items.getOrDefault("FERTILIZER_PREMIUM", 0) > 0 && rules.boosts().containsKey("FERTILIZER_PREMIUM")) {
                        double f = rules.boosts().get("FERTILIZER_PREMIUM").fraction();
                        if (p.boost + f <= rules.growth().maxBoost() + 1e-9) {
                            items.merge("FERTILIZER_PREMIUM", -1, Integer::sum);
                            p.boost += f;
                            p.fertilized = true;
                        }
                    }
                    if (!p.fertilized && items.getOrDefault("FERTILIZER", 0) > 0 && rules.boosts().containsKey("FERTILIZER")) {
                        double f = rules.boosts().get("FERTILIZER").fraction();
                        if (p.boost + f <= rules.growth().maxBoost() + 1e-9) {
                            items.merge("FERTILIZER", -1, Integer::sum);
                            p.boost += f;
                            p.fertilized = true;
                        }
                    }
                    var w = rules.boosts().get("WATER");
                    while (w != null && p.water < w.perPlantingLimit() && items.getOrDefault("WATER", 0) > 0
                            && p.boost + w.fraction() <= rules.growth().maxBoost() + 1e-9) {
                        items.merge("WATER", -1, Integer::sum);
                        p.boost += w.fraction();
                        p.water++;
                        waterUsed++;
                        p.waterTimes.add(now);
                    }
                }
            }
            // an order whose window closed on a day the persona was away also lapses (nothing is lost)
            if (p3) {
                Instant endOfDay = calendar.startOfDay(day.plusDays(1));
                for (int s = 1; s <= slots; s++) {
                    SimOrder o = board[s];
                    if (o != null && !o.filled && !endOfDay.isBefore(o.expires) && !present) {
                        expired++;
                        declined.remove(o);
                        board[s] = null;
                    }
                }
            }
            var dayXp = new XpSources(xs[0], xs[1], xs[2], xs[3], xs[4], xs[5], xs[6], xs[7]);
            int liveTrees = (int) java.util.Arrays.stream(trees).filter(java.util.Objects::nonNull).count();
            long income = p3 ? sales + orderCoins - seedSpend - packSpend : sales - seedSpend;
            if (fr != null) {
                income += (fr.bonus - bonus0) - (fr.supplySpend - supply0);
                farmingDays.add(new Farming(d + 1, fr.bonus - bonus0, fr.supplySpend - supply0, fr.supplies - supplies0,
                        fr.harvests - harvests0, fr.stressed - stressed0, fr.dry - dry0, fr.wet - wet0));
            }
            out.add(new Day(d + 1, present, income, sales, coins, xp, levels.level(xp), freeWater, waterUsed,
                    fertGained, plantings, goal, dayXp, essence, essenceGained, graduations, pestsToday, liveTrees,
                    planted, tiersToday));
            if (p3) {
                econ.add(new Economy(d + 1, plots.size(), marketSpend + packSpend, expansionSpend, orderCoins, opened, filled,
                        expired, fertBought, premiumBought, packsBought, compost, seedSpend + packSpend, sales, delivered));
            }
            if (st != null) {
                estateDays.add(new Estate(d + 1, plots.size(), st.buildingSpend - buildingSpend0, st.landSpend - landSpend0,
                        st.materials - materials0, st.compost - compost0, st.learningDays, Map.copyOf(st.levels)));
            }
        }
        cur = null;
        cur3d = null;
        return new Result(persona, out, econ, estateDays, farmingDays);
    }

    /**
     * One unit of a supply for use now: from the persona's stock, else bought at today's market under its daily cap and
     * level. Returns the coins paid (0 from stock), or -1 when it is not available.
     */
    private long takeSupply(String code, long coins, int level, List<MarketEngine.Offer> offers, Map<String, Integer> bought,
                            Map<String, Integer> items) {
        if (items.getOrDefault(code, 0) > 0) {
            items.merge(code, -1, Integer::sum);
            return 0;
        }
        var offer = offers.stream().filter(o -> code.equals(o.item())).findFirst().orElse(null);
        if (offer == null || level < offer.unlockLevel() || bought.getOrDefault(offer.code(), 0) >= offer.dailyCap()
                || coins < offer.price() + LIQUIDITY) return -1;
        bought.merge(offer.code(), 1, Integer::sum);
        return offer.price();
    }

    /**
     * Share of the sale price a bed is expected to lose to stressed soil when it ripens, by the forecast known at
     * {@code now} — optionally with one more supply applied now. The quality lines: more than the severe share = capped
     * tier, a reduced care score = about a third of a tier step.
     */
    private double soilLoss(Plot p, Instant now, String extraItem) {
        List<Treatment> applied = new ArrayList<>(p.treatments);
        if (extraItem != null) applied.add(new Treatment(extraItem, now, farming.expiresAt(farming.rules().item(extraItem), now)));
        var tl = farming.soil().timeline(p.plantedAt, farming.rules().thirstOf(p.crop.code()), farming.soilEvents(p.waterTimes, applied),
                now.plus(Duration.ofDays(rules.growth().estimateHorizonDays())), weather.revealedUntil(now));
        List<GrowthCalculator.Slowdown> slow = new ArrayList<>(farming.suppress(estate.slowdowns(pestFacts(p), List.of()), applied));
        slow.addAll(tl.slowdowns());
        var snap = growth.evaluate(new GrowthCalculator.PlantingFacts(p.plantedAt, p.baseSeconds, p.boost, p.crop.season(), slow), now);
        if (snap.readyAt() == null) return 0;
        var care = farming.care(true, tl.at(snap.readyAt()), farming.everApplied(applied, Effect.TONIC, now));
        if (care.tierCap() != null) return 0.20;
        return care.factor() < 1 ? 0.06 : 0;
    }

    /** The soil timeline of a simulated bed at {@code now} (rebuilt only when the instant or its care events change). */
    private SoilModel.Timeline timeline(Plot p, Instant now) {
        int key = p.waterTimes.size() * 131 + p.treatments.size();
        if (p.timeline == null || !now.equals(p.timelineAt) || p.timelineKey != key) {
            p.timeline = farming.soil().timeline(p.plantedAt, farming.rules().thirstOf(p.crop.code()),
                    farming.soilEvents(p.waterTimes, p.treatments), now.plus(Duration.ofDays(rules.growth().estimateHorizonDays())),
                    weather.revealedUntil(now));
            p.timelineAt = now;
            p.timelineKey = key;
        }
        return p.timeline;
    }

    /** Produce by crop and tier, in the engine's stock shape. */
    private static Map<String, Map<String, Integer>> stock(Map<Produce, Integer> produce) {
        Map<String, Map<String, Integer>> out = new HashMap<>();
        produce.forEach((k, q) -> {
            if (q > 0) out.computeIfAbsent(k.crop(), c -> new HashMap<>()).merge(k.tier(), q, Integer::sum);
        });
        return out;
    }

    /** Market value of a reward item (staple price, seed price) for the persona's deliver-or-sell decision. */
    private long itemValue(String item) {
        if (item.startsWith("SEED:")) return rules.crop(item.substring(5)).seedPrice();
        var staple = economy.staple(item);
        return staple == null ? 0 : staple.price();
    }

    /** Coins a persona keeps liquid before it holds produce back for orders or a bed. */
    private static final long LIQUIDITY = 500;

    /**
     * An open order the persona works towards: still valid and worth at least 90 % of selling the same units (NORMAL
     * tier, with the blessing on a goal day) — otherwise a sensible player just sells.
     */
    private boolean pursued(SimOrder o, Set<SimOrder> declined, Instant now, boolean blessingDay) {
        if (o == null || o.filled || declined.contains(o) || !now.isBefore(o.expires)) return false;
        long sale = 0;
        for (var l : o.spec.lines()) {
            sale += quality.unitSellPrice(rules.crop(l.cropCode()), rules.quality().tier(l.minTier()), blessingDay) * l.qty();
        }
        long value = orders.payout(o.spec.coins(), blessingDay);
        for (var b : o.spec.bonus().entrySet()) value += itemValue(b.getKey()) * b.getValue();
        return value >= 0.9 * sale;
    }

    /**
     * The cheapest purchase open to the persona at its level: the next V80 bed and, in a Phase 3C run, the next level of
     * each building and the next bed of every region whose gate of farm facts is met. Null when nothing is open.
     */
    private Goal cheapestGoal(int plots, long xp) {
        int level = levels.level(xp);
        Run3c st = cur;
        int v80 = plots - 6 - (st == null ? 0 : st.land.size());
        List<Goal> open = new ArrayList<>();
        if (economy.expansion().plots().size() > v80) {
            var bed = economy.expansion().plots().get(v80);
            if (level >= bed.level()) open.add(new Goal("BED", "V80", bed.slot(), 0, bed.coins(), bed.compost()));
        }
        if (st != null && st.policy.buildings()) {
            for (var b : estate.rules().buildings().values()) {
                estate.nextLevel(b.code(), st.levels.getOrDefault(b.code(), 0)).filter(l -> level >= l.minLevel())
                        .ifPresent(l -> open.add(new Goal("BUILDING", b.code(), 0, l.level(), l.coins(), l.materials())));
            }
        }
        if (st != null && st.policy.land()) {
            for (var r : estate.rules().land().regions()) {
                if (!estate.gate(r, level, plots, st.orders, st.harvests).open()) continue;
                r.plots().stream().filter(p -> !st.land.contains(p.slot())).findFirst().ifPresent(p ->
                        open.add(new Goal("LAND", r.code(), p.slot(), 0, estate.landPrice(p, st.learningDays), p.materials())));
            }
        }
        return open.stream().min(Comparator.comparingLong(Goal::coins).thenComparing(Goal::kind).thenComparing(Goal::code)).orElse(null);
    }

    /** The cheapest open purchase once the persona can afford half of it (then it starts keeping its produce). */
    private Goal saving(int plots, long xp, long coins, Policy policy) {
        if (!policy.expands()) return null;
        Goal g = cheapestGoal(plots, xp);
        return g != null && coins >= g.coins() / 2 ? g : null;
    }

    /** The pests of a simulated bed in the engine's shape (one pest at most). */
    private static List<PestPlanner.PestFacts> pestFacts(Plot p) {
        if (p.pestAt == null) return List.of();
        return List.of(new PestPlanner.PestFacts(p.id, p.id, PestPlanner.Host.CROP, p.id, null, p.pestAt, p.pestReviewedAt, null));
    }

    /** Units kept back from a sale: open (not declined) order lines first, then the next bed's compost once in reach. */
    private Map<Produce, Integer> reserve(Map<Produce, Integer> produce, SimOrder[] board, Set<SimOrder> declined,
                                          Instant now, int plots, long xp, long coins, boolean blessingDay, Policy policy) {
        List<OrderEngine.Line> needs = new ArrayList<>();
        if (coins < LIQUIDITY) return Map.of(); // a broke player sells first: never hold stock instead of buying seeds
        for (SimOrder o : board) {
            if (pursued(o, declined, now, blessingDay)) needs.addAll(o.spec.lines());
        }
        var nextBed = saving(plots, xp, coins, policy);
        if (nextBed != null) nextBed.materials().forEach((c, q) -> needs.add(new OrderEngine.Line(c, q, orders.lowestTier())));
        Map<Produce, Integer> left = new HashMap<>(produce);
        Map<Produce, Integer> keep = new HashMap<>();
        var tiers = rules.quality().tiers().stream().sorted(Comparator.comparingInt(QualityTier::minScore)).toList();
        for (var line : needs) {
            int need = line.qty();
            for (var t : tiers) {
                if (need == 0) break;
                if (orders.rank(t.code()) < orders.rank(line.minTier())) continue;
                var key = new Produce(line.cropCode(), t.code());
                int take = Math.min(left.getOrDefault(key, 0), need);
                if (take > 0) {
                    left.merge(key, -take, Integer::sum);
                    keep.merge(key, take, Integer::sum);
                    need -= take;
                }
            }
        }
        return keep;
    }

    /**
     * A crop still missing for an open order (ripe before it expires) or for the next bed's compost, that the persona
     * can plant now; {@code null} when nothing is missing.
     */
    private CropDef demandCrop(Map<Produce, Integer> produce, List<Plot> plots, SimOrder[] board, Set<SimOrder> declined,
                               Instant now, long xp, long coins, boolean blessingDay, Map<String, Integer> items, Policy policy) {
        Map<String, Integer> need = new LinkedHashMap<>();
        Map<String, Instant> deadline = new HashMap<>();
        if (coins < LIQUIDITY) return null;
        for (SimOrder o : board) {
            if (!pursued(o, declined, now, blessingDay)) continue;
            for (var l : o.spec.lines()) {
                need.merge(l.cropCode(), l.qty(), Integer::sum);
                deadline.merge(l.cropCode(), o.expires, (a, b) -> a.isBefore(b) ? a : b);
            }
        }
        var nextBed = saving(plots.size(), xp, coins, policy);
        if (nextBed != null) nextBed.materials().forEach((c, q) -> need.merge(c, q, Integer::sum));
        if (need.isEmpty()) return null;
        produce.forEach((k, q) -> need.computeIfPresent(k.crop(), (c, n) -> n - q));
        plots.forEach(p -> {
            if (p.crop != null) need.computeIfPresent(p.crop.code(), (c, n) -> n - 1);
        });
        int level = levels.level(xp);
        // a bed is spent on an order crop only when that crop is worth at least half of the best crop the persona could
        // plant now (a player does not give up a watermelon cycle for a handful of wheat); compost is always grown
        int bestSell = rules.crops().values().stream()
                .filter(c -> !c.qaOnly() && c.purchasable() && c.seedEssence() == 0 && c.unlockLevel() <= level)
                .mapToInt(CropDef::sellPrice).max().orElse(0);
        Map<String, Integer> compostNeed = nextBed != null ? nextBed.materials() : Map.of();
        for (var e : need.entrySet()) {
            if (e.getValue() <= 0) continue;
            CropDef c = rules.crop(e.getKey());
            if (c.unlockLevel() > level) continue;
            if (!compostNeed.containsKey(c.code()) && c.sellPrice() < 0.5 * bestSell) continue;
            boolean held = items.getOrDefault("SEED:" + c.code(), 0) > 0;
            if (!held && (!c.purchasable() || coins < c.seedPrice())) continue;
            Instant due = deadline.get(c.code());
            if (due != null) {
                var snap = growth.evaluate(new GrowthCalculator.PlantingFacts(now, c.baseSeconds(), 0, c.season()), now);
                if (snap.readyAt() == null || snap.readyAt().isAfter(due)) continue;
            }
            return c;
        }
        return null;
    }

    private GrowthCalculator.PlantingFacts facts(Plot p, Instant now) {
        List<GrowthCalculator.Slowdown> slow = new ArrayList<>();
        if (cur != null) {
            // Phase 3C: staged damage (warning, leaf damage, wilting); care given after the pest appeared is not modelled
            slow.addAll(estate.slowdowns(pestFacts(p), List.of()));
            if (cur3d != null) {
                // Phase 3D: a spray cuts its window out of the pest damage; the soil adds its own slowdowns
                if (!p.treatments.isEmpty()) slow = new ArrayList<>(farming.suppress(slow, p.treatments));
                if (p.soil) slow.addAll(timeline(p, now).slowdowns());
            }
        } else if (p.pestAt != null) {
            Instant end = p.pestAt.plus(Duration.ofMinutes(Math.round(rules.pests().effectHours() * 60)));
            if (p.pestReviewedAt != null && p.pestReviewedAt.isBefore(end)) end = p.pestReviewedAt;
            if (end.isAfter(p.pestAt)) slow.add(new GrowthCalculator.Slowdown(p.pestAt, end, rules.pests().growthFactor()));
        }
        return new GrowthCalculator.PlantingFacts(p.plantedAt, p.baseSeconds, p.boost, p.crop.season(), slow);
    }

    /** The persona reviews each tree word when the scheduler makes it due ("good" → every 3 days). */
    private List<CardFacts> treeCards(Tree t, Instant now) {
        long age = Duration.between(t.plantedAt, now).toDays();
        int reviewDays = (int) Math.max(0, 1 + age / 3);
        List<CardFacts> cards = new ArrayList<>();
        for (int i = 0; i < rules.knowledge().cards(); i++) {
            cards.add(new CardFacts(i + 1, "w" + i, "nghĩa " + i, true, "LEARNED", false, reviewDays, now));
        }
        return cards;
    }

    private Instant at(LocalDate day, LocalTime time) {
        return calendar.startOfDay(day).plus(Duration.between(LocalTime.MIDNIGHT, time));
    }

    /** The next visit after visit {@code v} of day {@code d} (skipping days the persona is away). */
    private Instant nextVisit(Persona persona, int d, int v, LocalDate start) {
        List<LocalTime> visits = persona.visits();
        if (v + 1 < visits.size()) return at(start.plusDays(d), visits.get(v + 1));
        int nd = d + 1;
        while ((nd % persona.presentEvery()) >= persona.presentDays()) nd++;
        return at(start.plusDays(nd), visits.getFirst());
    }

    /**
     * The best purchasable unlocked crop that is ready by the next visit: highest profit (sell − seed; held seeds are
     * free) or highest profit per hour of growth (revenue maximizer). Falls back to the fastest crop.
     */
    private CropDef bestCrop(Strategy strategy, int level, long coins, int essence, Map<String, Integer> items, Instant now,
                             Instant next, boolean firstPlanting) {
        CropDef best = null;
        double bestValue = -1;
        CropDef fastest = null;
        for (CropDef c : rules.crops().values()) {
            if (c.qaOnly() || c.unlockLevel() > level) continue;
            if (strategy == Strategy.FAST_LOOP && c.rarity() != GardenRules.Rarity.COMMON) continue;
            boolean held = items.getOrDefault("SEED:" + c.code(), 0) > 0;
            if (!held && (!c.purchasable() || coins < c.seedPrice() || essence < c.seedEssence())) continue;
            int base = firstPlanting && c.code().equals(rules.growth().tutorialCrop()) ? rules.growth().tutorialSeconds() : c.baseSeconds();
            var snap = growth.evaluate(new GrowthCalculator.PlantingFacts(now, base, 0, c.season()), now);
            if (fastest == null || c.baseSeconds() < fastest.baseSeconds()) fastest = c;
            if (snap.readyAt() == null || snap.readyAt().isAfter(next)) continue;
            double inSeason = c.season() == GardenRules.Season.ALL || calendar.theme(now) == c.season() ? 1.0 : 0.85;
            double profit = (c.sellPrice() * inSeason - (held ? 0 : c.seedPrice())) + c.harvestXp() * 0.01;
            double value = strategy != Strategy.PROFIT
                    ? profit / Math.max(1, Duration.between(now, snap.readyAt()).toSeconds() / 3600.0)
                    : profit;
            if (value > bestValue) {
                bestValue = value;
                best = c;
            }
        }
        return best != null ? best : fastest;
    }
}
