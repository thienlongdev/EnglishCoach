package com.englishcoach.garden.infra;

import com.englishcoach.garden.api.GardenException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.englishcoach.garden.infra.GardenRepository.inst;
import static com.englishcoach.garden.infra.GardenRepository.ts;

/**
 * Phase 3A farm-economy SQL (V80): market purchase counters, materialized delivery orders and expansion beds. Every
 * statement is scoped by {@code user_id}; caps, the single delivery and the single bed purchase are protected by
 * conditional statements whose row counts are checked (plus the frozen-order trigger and CHECK constraints). Callers
 * hold the per-user advisory lock.
 */
@Repository
public class EconomyRepository {

    /** A materialized order; {@code lines}, {@code bonus} and {@code delivered} are JSON text. */
    public record OrderRow(long id, int slot, String kind, String periodKey, String lines, long baseCoins, String bonus,
                           Instant createdAt, Instant expiresAt, String status, Instant filledAt, Long paidCoins,
                           Boolean blessing, String delivered) {}

    private final JdbcTemplate jdbc;

    public EconomyRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    // ----------------------------------------------------------------- market

    /** Purchase units of every offer bought by the user on a Vietnam day. */
    public Map<String, Integer> marketUnits(long userId, LocalDate day) {
        // memoized for the transaction (GardenScope): the market, the compost bins and the animals all read the day's
        // counters; addMarketUnits (the only writer) evicts them
        return GardenScope.get("market:" + userId + ":" + day, () -> {
            Map<String, Integer> out = new HashMap<>();
            jdbc.query("SELECT offer_code, units FROM public.garden_market_purchase WHERE user_id = ? AND day_key = ?",
                    (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getInt(2)), userId, day);
            return Map.copyOf(out);
        });
    }

    /**
     * Adds {@code units} to the day's counter only while the total stays within {@code cap} (insert or conditional
     * update); false ⇒ the cap would be exceeded and nothing changed.
     */
    public boolean addMarketUnits(long userId, LocalDate day, String offerCode, int units, int cap, Instant now) {
        if (units <= 0 || units > cap) return false;
        GardenScope.evictPrefix("market:" + userId + ":");
        return jdbc.update("""
                INSERT INTO public.garden_market_purchase(user_id, day_key, offer_code, units, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (user_id, day_key, offer_code) DO UPDATE
                    SET units = public.garden_market_purchase.units + EXCLUDED.units, updated_at = EXCLUDED.updated_at
                    WHERE public.garden_market_purchase.units + EXCLUDED.units <= ?
                """, userId, day, offerCode, units, ts(now), cap) == 1;
    }

    // ----------------------------------------------------------------- orders

    private static OrderRow order(ResultSet rs) throws SQLException {
        Object paid = rs.getObject("paid_coins");
        Object blessing = rs.getObject("blessing");
        return new OrderRow(rs.getLong("id"), rs.getInt("slot"), rs.getString("kind"), rs.getString("period_key"),
                rs.getString("lines"), rs.getLong("base_coins"), rs.getString("bonus"), inst(rs, "created_at"),
                inst(rs, "expires_at"), rs.getString("status"), inst(rs, "filled_at"),
                paid == null ? null : ((Number) paid).longValue(), blessing == null ? null : (Boolean) blessing,
                rs.getString("delivered"));
    }

    private static final String ORDER_COLUMNS = """
            id, slot, kind, period_key, lines::text AS lines, base_coins, bonus::text AS bonus, created_at, expires_at,
            status, filled_at, paid_coins, blessing, delivered::text AS delivered
            """;

    /** The orders of the given periods (current board), keyed by slot. */
    public Map<Integer, OrderRow> board(long userId, Map<Integer, String> periodBySlot) {
        Map<Integer, OrderRow> out = new LinkedHashMap<>();
        if (periodBySlot.isEmpty()) return out;
        List<String> keys = new ArrayList<>(new java.util.LinkedHashSet<>(periodBySlot.values()));
        jdbc.query("SELECT " + ORDER_COLUMNS + " FROM public.garden_order WHERE user_id = ? AND period_key = ANY(?)", ps -> {
            ps.setLong(1, userId);
            ps.setArray(2, ps.getConnection().createArrayOf("varchar", keys.toArray()));
        }, (RowCallbackHandler) rs -> {
            OrderRow r = order(rs);
            if (r.periodKey().equals(periodBySlot.get(r.slot()))) out.put(r.slot(), r);
        });
        return out;
    }

    /** Inserts the order of a slot and period once; false when it already exists (concurrent read or replay). */
    public boolean insertOrder(long userId, int slot, String kind, String periodKey, String linesJson, long baseCoins,
                               String bonusJson, Instant createdAt, Instant expiresAt) {
        return jdbc.update("""
                INSERT INTO public.garden_order(user_id, slot, kind, period_key, lines, base_coins, bonus, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?::jsonb, ?, ?::jsonb, ?, ?) ON CONFLICT (user_id, slot, period_key) DO NOTHING
                """, userId, slot, kind, periodKey, linesJson, baseCoins, bonusJson, ts(createdAt), ts(expiresAt)) == 1;
    }

    /** An order of this user (404 for an unknown or foreign id). */
    public OrderRow order(long userId, long orderId) {
        var rows = jdbc.query("SELECT " + ORDER_COLUMNS + " FROM public.garden_order WHERE user_id = ? AND id = ?",
                (rs, n) -> order(rs), userId, orderId);
        if (rows.isEmpty()) throw new GardenException(404, "ORDER_NOT_FOUND");
        return rows.getFirst();
    }

    /** Closes an order exactly once and only before it expires (0 rows ⇒ already delivered or expired). */
    public boolean fill(long userId, long orderId, Instant now, long paidCoins, boolean blessing, String deliveredJson, UUID op) {
        return jdbc.update("""
                UPDATE public.garden_order SET status = 'FILLED', filled_at = ?, paid_coins = ?, blessing = ?, delivered = ?::jsonb, fill_op = ?
                WHERE user_id = ? AND id = ? AND status = 'OPEN' AND expires_at > ?
                """, ts(now), paidCoins, blessing, deliveredJson, op, userId, orderId, ts(now)) == 1;
    }

    /** Delivered units per crop over every filled order of the user (the delivery record), one bounded aggregate. */
    public Map<String, Integer> deliveryRecord(long userId) {
        Map<String, Integer> out = new LinkedHashMap<>();
        jdbc.query("""
                SELECT d->>'cropCode', sum((d->>'qty')::int) FROM public.garden_order o, jsonb_array_elements(o.delivered) d
                WHERE o.user_id = ? AND o.status = 'FILLED' GROUP BY 1 ORDER BY 1
                """, (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getInt(2)), userId);
        return out;
    }

    public int filledCount(long userId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_order WHERE user_id = ? AND status = 'FILLED'",
                Integer.class, userId);
        return n == null ? 0 : n;
    }

    // ----------------------------------------------------------------- expansion

    /** Creates an expansion bed once (unique user + kind + slot); returns its id, or null when it already exists. */
    public Long insertPlot(long userId, int slot, int gridX, int gridY, Instant now) {
        GardenScope.evict("plots:" + userId);
        var ids = jdbc.queryForList("""
                INSERT INTO public.garden_plot(user_id, kind, slot_index, grid_x, grid_y, unlocked_at)
                VALUES (?, 'CROP', ?, ?, ?, ?) ON CONFLICT (user_id, kind, slot_index) DO NOTHING RETURNING id
                """, Long.class, userId, slot, gridX, gridY, ts(now));
        return ids.isEmpty() ? null : ids.getFirst();
    }
}
