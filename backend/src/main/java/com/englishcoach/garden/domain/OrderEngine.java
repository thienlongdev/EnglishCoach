package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.FarmEconomyRules.OrderKind;
import com.englishcoach.garden.domain.GardenRules.CropDef;
import com.englishcoach.garden.domain.GardenRules.Rarity;
import com.englishcoach.garden.domain.GardenRules.Season;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Delivery board (Phase 3A): what an order asks for, what it pays and whether a delivery matches it. Pure and
 * deterministic: the same user, slot, period and facts always produce the same order, so the server can materialize it
 * once and every later read sees the same frozen row.
 *
 * <p>An order only asks for crops the player can actually grow: unlocked, seed-purchasable COMMON / RARE crops whose
 * grow time at the current season fits {@code growShare} of the remaining window, in quantities the player's beds could
 * grow before expiry. When nothing fits (late at night), no order is generated. Coins are {@code coinMultiplier} × the
 * plain sell value of the requested units (never the blessing, never the delivered tier), plus a care item and, for
 * weekly orders, a few in-season rare seeds. Orders grant no XP.
 */
public final class OrderEngine {

    public enum Kind { DAILY, WEEKLY }

    /** {@code minTier}: the lowest quality tier accepted for this line. */
    public record Line(String cropCode, int qty, String minTier) {}

    public record Spec(Kind kind, List<Line> lines, long coins, Map<String, Integer> bonus) {}

    /** A delivered (or composted) line: crop, the quality tier taken from inventory and its quantity. */
    public record Supply(String cropCode, String tier, int qty) {}

    /** Validation result: {@code null} code = the supply matches exactly. */
    public record Check(String code, Map<String, Object> details) {
        public boolean ok() {
            return code == null;
        }

        static Check pass() {
            return new Check(null, Map.of());
        }
    }

    private final GardenRules rules;
    private final FarmEconomyRules economy;
    private final GardenCalendar calendar;

    public OrderEngine(GardenRules rules, FarmEconomyRules economy) {
        this.rules = rules;
        this.economy = economy;
        this.calendar = new GardenCalendar(rules);
    }

    public Kind kindOf(int slot) {
        return economy.orders().weeklySlot(slot) ? Kind.WEEKLY : Kind.DAILY;
    }

    /** Daily orders: the Vietnam day; weekly orders: the theme week (keyed by its Monday). */
    public String periodKey(Kind kind, Instant now) {
        LocalDate day = calendar.dayKey(now);
        if (kind == Kind.DAILY) return "D" + day;
        LocalDate monday = calendar.dayKey(calendar.themeEndsAt(now)).minusDays(7);
        return "W" + monday;
    }

    public Instant expiresAt(Kind kind, Instant now) {
        return kind == Kind.DAILY ? calendar.startOfDay(calendar.dayKey(now).plusDays(1)) : calendar.themeEndsAt(now);
    }

    public OrderKind rulesOf(Kind kind) {
        return kind == Kind.DAILY ? economy.orders().daily() : economy.orders().weekly();
    }

    /** Grow time of a crop planted now, at the current season factor (no weather, no care): a conservative estimate. */
    public double growSeconds(CropDef crop, Instant now) {
        var g = rules.growth();
        double speed = crop.season() == Season.ALL ? g.allSeason()
                : (calendar.theme(now) == crop.season() ? g.inSeason() : g.offSeason());
        return crop.baseSeconds() / Math.max(g.speedFloor(), speed);
    }

    /**
     * The order for one slot and period, or empty when the player's level is too low or no crop fits the remaining
     * window. {@code plots}: the player's beds (bounds the quantity that can be grown before expiry).
     */
    public Optional<Spec> generate(long userId, int slot, Instant now, int level, int plots) {
        Kind kind = kindOf(slot);
        OrderKind k = rulesOf(kind);
        if (level < k.minLevel() || plots <= 0) return Optional.empty();
        Instant expires = expiresAt(kind, now);
        double remaining = Duration.between(now, expires).toSeconds();
        double budget = remaining * economy.orders().growShare();
        String seed = "order:" + userId + ":" + slot + ":" + periodKey(kind, now);

        // weighted by sell price (Efraimidis–Spirakis keys u^(1/w), deterministic): valuable crops are asked for more often,
        // so an order is usually worth the bed time it costs, while cheap crops still appear now and then
        List<CropDef> candidates = rules.crops().values().stream()
                .filter(c -> orderable(c, level) && growSeconds(c, now) <= budget)
                .sorted(Comparator.comparingDouble((CropDef c) -> -Math.pow(
                                Math.max(1e-12, DeterministicRandom.unit(seed + ":" + c.code())), 1.0 / Math.max(1, c.sellPrice())))
                        .thenComparing(CropDef::code))
                .toList();
        if (candidates.isEmpty()) return Optional.empty();
        int wanted = level >= k.multiLineLevel() ? k.maxLines() : k.minLines();
        int n = Math.max(1, Math.min(wanted, candidates.size()));

        List<Line> lines = new ArrayList<>();
        long value = 0;
        for (int i = 0; i < n; i++) {
            CropDef c = candidates.get(i);
            long cycles = Math.max(1, (long) Math.floor(remaining / growSeconds(c, now)));
            long capacity = Math.max(1, plots * cycles / n);
            int hi = (int) Math.max(1, Math.min(k.maxQty(), capacity));
            int lo = Math.min(k.minQty(), hi);
            int qty = lo + (int) Math.floor(DeterministicRandom.unit(seed + ":qty:" + i) * (hi - lo + 1));
            qty = Math.max(lo, Math.min(hi, qty));
            String minTier = i == 0 && k.goodTierLevel() > 0 && level >= k.goodTierLevel() ? "GOOD" : lowestTier();
            lines.add(new Line(c.code(), qty, minTier));
            value += (long) c.sellPrice() * qty;
        }
        long coins = (long) Math.floor(value * economy.orders().coinMultiplier() * rules.coinScale() + 1e-9);
        Map<String, Integer> bonus = new LinkedHashMap<>(k.bonus());
        if (k.seedBonus() > 0) seedBonusCrop(seed, now, level).ifPresent(c -> bonus.merge("SEED:" + c.code(), k.seedBonus(), Integer::sum));
        return Optional.of(new Spec(kind, List.copyOf(lines), coins, Map.copyOf(bonus)));
    }

    /**
     * Coins actually paid for a delivery: the frozen base coins, times the Echo Blessing multiplier when the delivery
     * happens while the day's blessing is active — the same multiplier a sale gets, never a second learning reward.
     */
    public long payout(long baseCoins, boolean blessing) {
        return blessing ? (long) Math.floor(baseCoins * rules.blessingSellMultiplier() + 1e-9) : baseCoins;
    }

    /** Seeds given with an order: an unlocked RARE crop of the current theme, else any unlocked RARE crop, else none. */
    Optional<CropDef> seedBonusCrop(String seed, Instant now, int level) {
        Season theme = calendar.theme(now);
        Comparator<CropDef> order = Comparator.comparing((CropDef c) -> c.season() != theme)
                .thenComparingDouble(c -> DeterministicRandom.unit(seed + ":seed:" + c.code()))
                .thenComparing(CropDef::code);
        return rules.crops().values().stream()
                .filter(c -> orderable(c, level) && c.rarity() == Rarity.RARE)
                .min(order);
    }

    /** Crops an order may ask for: unlocked, seed sold for coins only, COMMON or RARE, never the QA crop. */
    static boolean orderable(CropDef c, int level) {
        return !c.qaOnly() && c.purchasable() && c.seedEssence() == 0 && c.unlockLevel() <= level
                && (c.rarity() == Rarity.COMMON || c.rarity() == Rarity.RARE);
    }

    public String lowestTier() {
        return rules.quality().tiers().stream().min(Comparator.comparingInt(GardenRules.QualityTier::minScore))
                .orElseThrow().code();
    }

    /** Rank of a tier (0 = lowest), or -1 when unknown. */
    public int rank(String tier) {
        var sorted = rules.quality().tiers().stream().sorted(Comparator.comparingInt(GardenRules.QualityTier::minScore)).toList();
        for (int i = 0; i < sorted.size(); i++) if (sorted.get(i).code().equals(tier)) return i;
        return -1;
    }

    /**
     * Exact-match check of a delivery against the frozen requirement: every supplied crop is requested, every supplied
     * tier is known and at least the line's minimum, and each requested crop is supplied in exactly its quantity.
     */
    public Check matches(List<Line> required, List<Supply> supplied) {
        Map<String, Line> req = new LinkedHashMap<>();
        required.forEach(l -> req.put(l.cropCode(), l));
        Map<String, Integer> totals = new LinkedHashMap<>();
        for (Supply s : supplied) {
            Line line = req.get(s.cropCode());
            if (line == null) return new Check("ORDER_LINES_MISMATCH", Map.of("cropCode", s.cropCode()));
            int rank = rank(s.tier());
            if (rank < 0 || s.qty() <= 0) return new Check("ORDER_LINES_MISMATCH", Map.of("cropCode", s.cropCode()));
            if (rank < rank(line.minTier())) {
                return new Check("ORDER_TIER_TOO_LOW", Map.of("cropCode", s.cropCode(), "minTier", line.minTier()));
            }
            totals.merge(s.cropCode(), s.qty(), Integer::sum);
        }
        for (Line l : required) {
            int got = totals.getOrDefault(l.cropCode(), 0);
            if (got != l.qty()) {
                return new Check("ORDER_LINES_MISMATCH", Map.of("cropCode", l.cropCode(), "required", l.qty(), "supplied", got));
            }
        }
        return Check.pass();
    }

    /** Compost lines for a bed: any tier, exact quantity per crop, nothing extra. */
    public Check compostMatches(Map<String, Integer> compost, List<Supply> supplied) {
        List<Line> lines = compost.entrySet().stream().map(e -> new Line(e.getKey(), e.getValue(), lowestTier())).toList();
        Check c = matches(lines, supplied);
        return c.ok() ? c : new Check("COMPOST_MISMATCH", c.details());
    }

    /**
     * The default delivery the client previews: the lowest qualifying tiers first (keeps the best produce for selling),
     * or empty when the stock cannot cover the line. {@code stock}: crop → tier → quantity held.
     */
    public Optional<List<Supply>> allocate(List<Line> required, Map<String, Map<String, Integer>> stock) {
        List<Supply> out = new ArrayList<>();
        for (Line l : required) {
            int need = l.qty();
            var tiers = rules.quality().tiers().stream().sorted(Comparator.comparingInt(GardenRules.QualityTier::minScore)).toList();
            for (var t : tiers) {
                if (need == 0) break;
                if (rank(t.code()) < rank(l.minTier())) continue;
                int have = stock.getOrDefault(l.cropCode(), Map.of()).getOrDefault(t.code(), 0);
                int take = Math.min(have, need);
                if (take > 0) {
                    out.add(new Supply(l.cropCode(), t.code(), take));
                    need -= take;
                }
            }
            if (need > 0) return Optional.empty();
        }
        return Optional.of(List.copyOf(out));
    }
}
