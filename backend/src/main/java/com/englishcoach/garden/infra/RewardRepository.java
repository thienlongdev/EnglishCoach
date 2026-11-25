package com.englishcoach.garden.infra;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static com.englishcoach.garden.infra.GardenRepository.inst;
import static com.englishcoach.garden.infra.GardenRepository.ts;

/**
 * Phase 3F rewards (V87): the owner's policy numbers, the Premium reward record, the global issuance budget, the
 * learning-day fact the Premium reward needs and the coin purchase of a profile frame. Every statement is scoped by
 * {@code user_id}; the reward and frame-purchase records are append-only.
 */
@Repository
public class RewardRepository {

    /** The owner's policy ({@code garden_config.rewards3f}); the services never hard-code these numbers. */
    public record Rules(long premiumCoins, int premiumHours, int premiumMaxPerWindow, int premiumWindowDays, int premiumCooldownDays,
                        int premiumLearningDays, int premiumLearningWindowDays, List<Pack> packs, int voucherCapCredits,
                        int voucherCapWindowDays, int voucherValidDays, int checkoutTtlMinutes, int checkoutGraceSeconds,
                        int refundRequestDays) {
        public Pack pack(String code) {
            return packs.stream().filter(p -> p.code().equals(code)).findFirst().orElse(null);
        }
    }

    public record Pack(String code, int credits, long coins) {}

    public record PremiumReward(long id, long subscriptionId, long coinsSpent, int learningDays, Instant startsAt, Instant expiresAt,
                                Instant createdAt) {}

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private volatile Rules rules;
    private volatile boolean loaded;

    public RewardRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = GardenJdbc.of(jdbc);
        this.json = json;
    }

    /** The Phase 3F policy, or null on a database without V87 (every Phase 3F reward is then closed). Loaded once. */
    public Rules rules() {
        if (!loaded) {
            synchronized (this) {
                if (!loaded) {
                    rules = load();
                    loaded = true;
                }
            }
        }
        return rules;
    }

    private Rules load() {
        if (!Boolean.TRUE.equals(jdbc.queryForObject("SELECT to_regclass('public.garden_premium_reward') IS NOT NULL", Boolean.class))) return null;
        var cfg = jdbc.queryForList("SELECT value::text FROM public.garden_config WHERE key = 'rewards3f'", String.class);
        if (cfg.isEmpty()) return null;
        JsonNode c;
        try {
            c = json.readTree(cfg.getFirst());
        } catch (Exception e) {
            throw new IllegalStateException("garden_config.rewards3f is not valid JSON", e);
        }
        JsonNode p = c.path("premium");
        JsonNode v = c.path("voucher");
        List<Pack> packs = new ArrayList<>();
        for (JsonNode n : v.path("packs")) packs.add(new Pack(n.path("code").asText(), n.path("credits").asInt(), n.path("coins").asLong()));
        Rules r = new Rules(p.path("coins").asLong(), p.path("hours").asInt(), p.path("maxPerWindow").asInt(), p.path("windowDays").asInt(),
                p.path("cooldownDays").asInt(), p.path("learningDays").asInt(), p.path("learningWindowDays").asInt(), List.copyOf(packs),
                v.path("capCredits").asInt(), v.path("capWindowDays").asInt(), v.path("validDays").asInt(),
                c.path("checkout").path("ttlMinutes").asInt(), c.path("checkout").path("graceSeconds").asInt(),
                c.path("refund").path("requestDays").asInt());
        boolean packsOk = !packs.isEmpty() && packs.stream().allMatch(k -> !k.code().isBlank() && k.credits() > 0 && k.coins() > 0);
        if (r.premiumCoins() <= 0 || r.premiumHours() <= 0 || r.premiumMaxPerWindow() <= 0 || r.premiumWindowDays() <= 0
                || r.premiumCooldownDays() < 0 || r.premiumLearningDays() <= 0 || r.premiumLearningWindowDays() < r.premiumLearningDays()
                || !packsOk || r.voucherCapCredits() <= 0 || r.voucherCapWindowDays() <= 0 || r.voucherValidDays() <= 0
                || r.checkoutTtlMinutes() <= 0 || r.checkoutGraceSeconds() < 0 || r.refundRequestDays() <= 0) {
            throw new IllegalStateException("invalid garden_config.rewards3f");
        }
        return r;
    }

    // ----------------------------------------------------------------- learning days

    /**
     * Distinct Vietnam dates in {@code [from, to]} on which this player really studied: a day of the garden's verified
     * learning record with at least one skill fact (vocabulary review, listening, speaking, writing or exam). A day that
     * only has a game played — or a visit, or a login — is not a learning day.
     */
    public int learningDays(long userId, LocalDate from, LocalDate to) {
        Integer n = jdbc.queryForObject("""
                SELECT count(*) FROM public.garden_monument_day
                WHERE user_id = ? AND day_key BETWEEN ? AND ? AND (vocabulary OR listening OR speaking OR writing OR exam)
                """, Integer.class, userId, java.sql.Date.valueOf(from), java.sql.Date.valueOf(to));
        return n == null ? 0 : n;
    }

    // ----------------------------------------------------------------- Premium reward

    /** Newest first. */
    public List<PremiumReward> premiumRewards(long userId) {
        return jdbc.query("""
                SELECT id, subscription_id, coins_spent, learning_days, starts_at, expires_at, created_at
                FROM public.garden_premium_reward WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20
                """, (rs, n) -> new PremiumReward(rs.getLong(1), rs.getLong(2), rs.getLong(3), rs.getInt(4), inst(rs, "starts_at"),
                inst(rs, "expires_at"), inst(rs, "created_at")), userId);
    }

    public long recordPremiumReward(long userId, long subscriptionId, long coins, int learningDays, Instant startsAt, Instant expiresAt,
                                    String period, UUID opKey, Instant now) {
        Long id = jdbc.queryForObject("""
                INSERT INTO public.garden_premium_reward(user_id, subscription_id, coins_spent, learning_days, starts_at, expires_at,
                    budget_period, op_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
                """, Long.class, userId, subscriptionId, coins, learningDays, ts(startsAt), ts(expiresAt), period, opKey, ts(now));
        return id == null ? 0 : id;
    }

    // ----------------------------------------------------------------- global budget

    public int issued(String kind, String period) {
        var rows = jdbc.queryForList("SELECT issued FROM public.garden_reward_budget WHERE kind = ? AND period = ?", Integer.class, kind, period);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    /**
     * Takes {@code units} from this month's budget of a reward kind, or changes nothing: the count may not pass
     * {@code cap} and the estimated cost may not pass {@code budgetVnd}. One guarded statement, inside the caller's
     * transaction — two players racing for the last unit cannot both get it, and a failed redemption gives it back.
     */
    public boolean reserveBudget(String kind, String period, int units, int cap, long unitCostVnd, long budgetVnd) {
        if (units <= 0 || cap <= 0 || unitCostVnd <= 0 || budgetVnd <= 0) return false;
        jdbc.update("INSERT INTO public.garden_reward_budget(kind, period) VALUES (?, ?) ON CONFLICT (kind, period) DO NOTHING", kind, period);
        return jdbc.update("""
                UPDATE public.garden_reward_budget SET issued = issued + ?, cost_vnd = cost_vnd + ?, updated_at = now()
                WHERE kind = ? AND period = ? AND issued + ? <= ? AND cost_vnd + ? <= ?
                """, units, units * unitCostVnd, kind, period, units, cap, units * unitCostVnd, budgetVnd) == 1;
    }

    // ----------------------------------------------------------------- frame purchases

    /** Records the coin purchase of a frame; false when this player already bought it. */
    public boolean recordFramePurchase(long userId, String slug, long coins, UUID opKey, Instant now) {
        return jdbc.update("""
                INSERT INTO public.garden_frame_purchase(user_id, frame_slug, coins_paid, op_key, created_at)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, frame_slug) DO NOTHING
                """, userId, slug, coins, opKey, ts(now)) == 1;
    }
}
