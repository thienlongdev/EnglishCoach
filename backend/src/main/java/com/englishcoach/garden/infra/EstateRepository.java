package com.englishcoach.garden.infra;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;

import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.englishcoach.garden.infra.GardenRepository.inst;
import static com.englishcoach.garden.infra.GardenRepository.ts;

/**
 * Phase 3C SQL (V83): building levels, farm facts for land gates, the Echo Contribution ledger and the reward catalogue /
 * redemptions. Every player statement is scoped by {@code user_id}; every invariant lives in a conditional statement
 * whose row count is checked (a building rises one level at a time, a fact is credited once, a balance never goes
 * negative, a global reward limit is never exceeded). Callers hold the per-user advisory lock. Nothing here reads or
 * writes another module.
 */
@Repository
public class EstateRepository {

    public record RewardDef(String code, String kind, String nameVi, String descriptionVi, int cost, int perUserLimit,
                            Integer globalLimit, int minLearningDays, int minGardenDays, String delivery, String payload,
                            boolean enabled, int sortOrder) {}

    public record Redemption(long id, String rewardCode, int cost, String status, String delivery, String deliveryRef,
                             Instant createdAt) {}

    public record Entry(long id, String source, String sourceRef, int points, int nominal, boolean capped, LocalDate day,
                        Instant createdAt) {}

    public record Account(int balance, int earned, int spent) {}

    /** A fact waiting to be credited: its reference, its tier (1 when it has none) and the instant it happened. */
    public record Fact(String ref, int tier, Instant at) {}

    private final JdbcTemplate jdbc;

    public EstateRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    // ----------------------------------------------------------------- buildings

    /**
     * Raises a building from {@code fromLevel} to {@code fromLevel + 1} exactly once: the first level is an insert that
     * loses to a concurrent one, later levels a conditional update on the current level (the V83 trigger also refuses
     * any other step). False ⇒ the building is no longer at {@code fromLevel}.
     */
    public boolean raiseBuilding(long userId, String code, int fromLevel, long coins, UUID op, Instant now) {
        GardenScope.evict("buildings:" + userId);
        if (fromLevel == 0) {
            return jdbc.update("""
                    INSERT INTO public.garden_building(user_id, code, level, coins_paid, upgraded_at, op_key) VALUES (?, ?, 1, ?, ?, ?)
                    ON CONFLICT (user_id, code) DO NOTHING
                    """, userId, code, coins, ts(now), op) == 1;
        }
        return jdbc.update("""
                UPDATE public.garden_building SET level = level + 1, coins_paid = coins_paid + ?, upgraded_at = ?, op_key = ?
                WHERE user_id = ? AND code = ? AND level = ?
                """, coins, ts(now), op, userId, code, fromLevel) == 1;
    }

    // ----------------------------------------------------------------- farm facts (land gates)

    /** Closed harvests of this garden over every crop (the mastery counters; QA crops never count). */
    public int harvests(long userId) {
        Integer n = jdbc.queryForObject("SELECT COALESCE(sum(harvests), 0) FROM public.garden_crop_mastery WHERE user_id = ?",
                Integer.class, userId);
        return n == null ? 0 : n;
    }

    // ----------------------------------------------------------------- contribution

    public void ensureAccount(long userId, Instant now) {
        // an existing account needs no insert (the caller holds the garden lock): one write less on every state read
        if (!jdbc.queryForList("SELECT 1 FROM public.garden_contribution WHERE user_id = ?", Integer.class, userId).isEmpty()) return;
        jdbc.update("INSERT INTO public.garden_contribution(user_id, updated_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING",
                userId, ts(now));
    }

    public Account account(long userId) {
        var rows = jdbc.query("SELECT balance, earned, spent FROM public.garden_contribution WHERE user_id = ?",
                (rs, n) -> new Account(rs.getInt(1), rs.getInt(2), rs.getInt(3)), userId);
        return rows.isEmpty() ? new Account(0, 0, 0) : rows.getFirst();
    }

    /** Verified learning days not credited yet, oldest first (bounded). */
    public List<Fact> uncreditedDays(long userId, int limit) {
        return jdbc.query("""
                SELECT d.day_key FROM public.garden_monument_day d
                WHERE d.user_id = ? AND NOT EXISTS (SELECT 1 FROM public.garden_contribution_entry e
                      WHERE e.user_id = d.user_id AND e.source = 'LEARNING_DAY' AND e.source_ref = d.day_key::text)
                ORDER BY d.day_key LIMIT ?
                """, (rs, n) -> new Fact(rs.getDate(1).toLocalDate().toString(), 1, null), userId, limit);
    }

    /** Verified days with at least two skill families (vocabulary, listening, speaking, writing, exam) not credited yet. */
    public List<Fact> uncreditedBreadthDays(long userId, int limit) {
        return jdbc.query("""
                SELECT d.day_key FROM public.garden_monument_day d
                WHERE d.user_id = ?
                  AND (d.vocabulary::int + d.listening::int + d.speaking::int + d.writing::int + d.exam::int) >= 2
                  AND NOT EXISTS (SELECT 1 FROM public.garden_contribution_entry e
                      WHERE e.user_id = d.user_id AND e.source = 'BREADTH_DAY' AND e.source_ref = d.day_key::text)
                ORDER BY d.day_key LIMIT ?
                """, (rs, n) -> new Fact(rs.getDate(1).toLocalDate().toString(), 1, null), userId, limit);
    }

    /** Graduated trees the monument credited (new words) that have no contribution entry yet. */
    public List<Fact> uncreditedGraduations(long userId, int limit) {
        return jdbc.query("""
                SELECT c.tree_id, c.graduated_at FROM public.garden_monument_credit c
                WHERE c.user_id = ? AND c.credited AND NOT EXISTS (SELECT 1 FROM public.garden_contribution_entry e
                      WHERE e.user_id = c.user_id AND e.source = 'GRADUATION' AND e.source_ref = c.tree_id::text)
                ORDER BY c.graduated_at, c.tree_id LIMIT ?
                """, (rs, n) -> new Fact(String.valueOf(rs.getLong(1)), 1, inst(rs, "graduated_at")), userId, limit);
    }

    /** Delivered weekly orders without a contribution entry yet. */
    public List<Fact> uncreditedWeeklyOrders(long userId, int limit) {
        return jdbc.query("""
                SELECT o.id, o.filled_at FROM public.garden_order o
                WHERE o.user_id = ? AND o.status = 'FILLED' AND o.kind = 'WEEKLY' AND NOT EXISTS (
                      SELECT 1 FROM public.garden_contribution_entry e
                      WHERE e.user_id = o.user_id AND e.source = 'WEEKLY_ORDER' AND e.source_ref = o.id::text)
                ORDER BY o.filled_at, o.id LIMIT ?
                """, (rs, n) -> new Fact(String.valueOf(rs.getLong(1)), 1, inst(rs, "filled_at")), userId, limit);
    }

    /**
     * Permanent milestones of the given kinds (ERA, BRANCH, MEMORY, RING, MASTERY) without a contribution entry yet, by
     * kind, oldest first, at most {@code limit} of each kind — ONE statement for all kinds (it was one per kind on
     * every state read).
     */
    public Map<String, List<Fact>> uncreditedMilestones(long userId, Collection<String> kinds, int limit) {
        Map<String, List<Fact>> out = new java.util.LinkedHashMap<>();
        kinds.forEach(k -> out.put(k, new java.util.ArrayList<>()));
        jdbc.query("""
                SELECT kind, code, tier, reached_at FROM (
                    SELECT m.kind, m.code, m.tier, m.reached_at, m.id, row_number() OVER (PARTITION BY m.kind ORDER BY m.id) AS rn
                    FROM public.garden_milestone m
                    WHERE m.user_id = ? AND m.kind = ANY(?) AND NOT EXISTS (SELECT 1 FROM public.garden_contribution_entry e
                          WHERE e.user_id = m.user_id AND e.source = m.kind AND e.source_ref = m.code || ':' || m.tier)) x
                WHERE rn <= ? ORDER BY id
                """, ps -> {
            ps.setLong(1, userId);
            ps.setArray(2, ps.getConnection().createArrayOf("text", kinds.toArray()));
            ps.setInt(3, limit);
        }, (RowCallbackHandler) rs -> out.get(rs.getString(1))
                .add(new Fact(rs.getString(2) + ":" + rs.getInt(3), rs.getInt(3), inst(rs, "reached_at"))));
        return out;
    }

    public boolean hasEntry(long userId, String source, String ref) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_contribution_entry WHERE user_id = ? AND source = ? AND source_ref = ?",
                Integer.class, userId, source, ref);
        return n != null && n > 0;
    }

    /** Capped points already granted for facts of a Vietnam-day range (the caps follow the day a fact happened). */
    public int cappedPoints(long userId, LocalDate from, LocalDate toExclusive) {
        Integer n = jdbc.queryForObject("""
                SELECT COALESCE(sum(points), 0) FROM public.garden_contribution_entry
                WHERE user_id = ? AND capped AND day_key >= ? AND day_key < ?
                """, Integer.class, userId, Date.valueOf(from), Date.valueOf(toExclusive));
        return n == null ? 0 : n;
    }

    /** Records a fact once; returns its entry id, or null when the fact was credited before (replay, concurrent read). */
    public Long insertEntry(long userId, String source, String ref, int points, int nominal, boolean capped, LocalDate day, Instant now) {
        var ids = jdbc.queryForList("""
                INSERT INTO public.garden_contribution_entry(user_id, source, source_ref, points, nominal, capped, day_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, source, source_ref) DO NOTHING RETURNING id
                """, Long.class, userId, source, ref, points, nominal, capped, Date.valueOf(day), ts(now));
        return ids.isEmpty() ? null : ids.getFirst();
    }

    public void addEarned(long userId, int points, Instant now) {
        if (points <= 0) return;
        jdbc.update("UPDATE public.garden_contribution SET balance = balance + ?, earned = earned + ?, updated_at = ? WHERE user_id = ?",
                points, points, ts(now), userId);
    }

    /** Conditional debit: never below zero (0 rows ⇒ not enough contribution, nothing changes). */
    public boolean spend(long userId, int points, Instant now) {
        return jdbc.update("""
                UPDATE public.garden_contribution SET balance = balance - ?, spent = spent + ?, updated_at = ?
                WHERE user_id = ? AND balance >= ?
                """, points, points, ts(now), userId, points) == 1;
    }

    private static Entry entry(ResultSet rs) throws SQLException {
        return new Entry(rs.getLong("id"), rs.getString("source"), rs.getString("source_ref"), rs.getInt("points"),
                rs.getInt("nominal"), rs.getBoolean("capped"), rs.getDate("day_key").toLocalDate(), inst(rs, "created_at"));
    }

    /** Newest first; {@code beforeId} pages backwards (keyset on id). */
    public List<Entry> entries(long userId, Long beforeId, int limit) {
        if (beforeId == null) {
            return jdbc.query("SELECT * FROM public.garden_contribution_entry WHERE user_id = ? ORDER BY id DESC LIMIT ?",
                    (rs, n) -> entry(rs), userId, limit);
        }
        return jdbc.query("SELECT * FROM public.garden_contribution_entry WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
                (rs, n) -> entry(rs), userId, beforeId, limit);
    }

    // ----------------------------------------------------------------- rewards

    private static RewardDef reward(ResultSet rs) throws SQLException {
        Object global = rs.getObject("global_limit");
        return new RewardDef(rs.getString("code"), rs.getString("kind"), rs.getString("name_vi"), rs.getString("description_vi"),
                rs.getInt("cost"), rs.getInt("per_user_limit"), global == null ? null : ((Number) global).intValue(),
                rs.getInt("min_learning_days"), rs.getInt("min_garden_days"), rs.getString("delivery"), rs.getString("payload_text"),
                rs.getBoolean("enabled"), rs.getInt("sort_order"));
    }

    private static final String REWARD_COLUMNS = "r.*, r.payload::text AS payload_text";

    /** The visible catalogue (configuration: changes only with a migration). */
    public List<RewardDef> rewards() {
        return jdbc.query("SELECT " + REWARD_COLUMNS + " FROM public.garden_reward_def r WHERE r.active ORDER BY r.sort_order, r.code",
                (rs, n) -> reward(rs));
    }

    public RewardDef reward(String code) {
        var rows = jdbc.query("SELECT " + REWARD_COLUMNS + " FROM public.garden_reward_def r WHERE r.active AND r.code = ?",
                (rs, n) -> reward(rs), code);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** Redemptions of a reward by this player that still stand (a reversed one frees its place). */
    public int redeemedBy(long userId, String rewardCode) {
        Integer n = jdbc.queryForObject("""
                SELECT count(*) FROM public.garden_reward_redemption WHERE user_id = ? AND reward_code = ? AND status = 'FULFILLED'
                """, Integer.class, userId, rewardCode);
        return n == null ? 0 : n;
    }

    public java.util.Map<String, Integer> redeemedBy(long userId) {
        java.util.Map<String, Integer> out = new java.util.HashMap<>();
        jdbc.query("""
                SELECT reward_code, count(*) FROM public.garden_reward_redemption WHERE user_id = ? AND status = 'FULFILLED'
                GROUP BY reward_code
                """, (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getInt(2)), userId);
        return out;
    }

    /** Units of every limited reward issued so far (all players): the catalogue shows what is left. */
    public java.util.Map<String, Integer> issued() {
        java.util.Map<String, Integer> out = new java.util.HashMap<>();
        jdbc.query("SELECT reward_code, redeemed FROM public.garden_reward_counter",
                (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getInt(2)));
        return out;
    }

    /**
     * Takes one unit of a reward's global stock: the counter row is locked by the update, so players redeeming at the
     * same moment are serialized and the limit can never be exceeded. False ⇒ the stock is exhausted.
     */
    public boolean takeGlobal(String rewardCode, int globalLimit) {
        jdbc.update("INSERT INTO public.garden_reward_counter(reward_code, redeemed) VALUES (?, 0) ON CONFLICT (reward_code) DO NOTHING",
                rewardCode);
        return jdbc.update("UPDATE public.garden_reward_counter SET redeemed = redeemed + 1 WHERE reward_code = ? AND redeemed < ?",
                rewardCode, globalLimit) == 1;
    }

    public long insertRedemption(long userId, String rewardCode, int cost, String delivery, String deliveryRef, UUID op, Instant now) {
        return jdbc.queryForObject("""
                INSERT INTO public.garden_reward_redemption(user_id, reward_code, cost, delivery, delivery_ref, op_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
                """, Long.class, userId, rewardCode, cost, delivery, deliveryRef, op, ts(now));
    }

    public List<Redemption> redemptions(long userId, int limit) {
        List<Redemption> out = new ArrayList<>();
        jdbc.query("SELECT * FROM public.garden_reward_redemption WHERE user_id = ? ORDER BY id DESC LIMIT ?", (RowCallbackHandler) rs ->
                out.add(new Redemption(rs.getLong("id"), rs.getString("reward_code"), rs.getInt("cost"), rs.getString("status"),
                        rs.getString("delivery"), rs.getString("delivery_ref"), inst(rs, "created_at"))), userId, limit);
        return out;
    }
}
