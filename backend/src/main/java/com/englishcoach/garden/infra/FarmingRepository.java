package com.englishcoach.garden.infra;

import com.englishcoach.garden.domain.FarmingEngine.Treatment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static com.englishcoach.garden.infra.GardenRepository.inst;
import static com.englishcoach.garden.infra.GardenRepository.ts;

/**
 * Phase 3D persistence (V84): supplies applied to plantings, the day's harvest-bonus counter and the farm records read
 * from the append-only ledger. Every statement is scoped by {@code user_id}; a treatment can only reference a planting
 * of the same owner (composite foreign key) and is never updated or deleted (trigger).
 */
@Repository
public class FarmingRepository {

    /** Net movement of one ledger asset for one reason (records view). */
    public record Flow(String asset, String reason, long total) {}

    private final GardenJdbc jdbc;

    public FarmingRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    // ----------------------------------------------------------------- treatments

    /** Every supply ever applied to these plantings (oldest first), grouped by planting. */
    public Map<Long, List<Treatment>> treatments(long userId, Collection<Long> plantingIds) {
        if (plantingIds.isEmpty()) return new HashMap<>();
        // memoized for the transaction (GardenScope) per set of plantings: the growth facts, the pest view and the pest
        // planner all ask for the same beds; insertTreatment (the only writer) evicts
        String key = "treatments:" + userId + ":" + new java.util.TreeSet<>(plantingIds);
        return GardenScope.get(key, () -> {
            Map<Long, List<Treatment>> out = new HashMap<>();
            jdbc.query("""
                            SELECT planting_id, item_code, applied_at, expires_at FROM public.garden_treatment
                            WHERE user_id = ? AND planting_id = ANY(?) ORDER BY applied_at, id
                            """,
                    ps -> {
                        ps.setLong(1, userId);
                        ps.setArray(2, ps.getConnection().createArrayOf("bigint", plantingIds.toArray()));
                    },
                    (RowCallbackHandler) rs -> out.computeIfAbsent(rs.getLong(1), k -> new ArrayList<>())
                            .add(new Treatment(rs.getString(2), inst(rs, "applied_at"), inst(rs, "expires_at"))));
            out.replaceAll((k, v) -> List.copyOf(v));
            return java.util.Collections.unmodifiableMap(out);
        });
    }

    public void insertTreatment(long userId, long plantingId, String itemCode, Instant appliedAt, Instant expiresAt, UUID op) {
        GardenScope.evictPrefix("treatments:" + userId + ":");
        jdbc.updateLater("""
                INSERT INTO public.garden_treatment(user_id, planting_id, item_code, applied_at, expires_at, op_key)
                VALUES (?, ?, ?, ?, ?, ?)
                """, userId, plantingId, itemCode, ts(appliedAt), expiresAt == null ? null : ts(expiresAt), op);
    }

    /** Instants each planting was watered with the Flashcard-review resource (moisture events), oldest first. */
    public Map<Long, List<Instant>> waterTimes(long userId, Collection<Long> plantingIds) {
        Map<Long, List<Instant>> out = new HashMap<>();
        if (plantingIds.isEmpty()) return out;
        jdbc.query("""
                        SELECT planting_id, used_at FROM public.garden_boost_use
                        WHERE user_id = ? AND planting_id = ANY(?) AND item_code = 'WATER' ORDER BY used_at
                        """,
                ps -> {
                    ps.setLong(1, userId);
                    ps.setArray(2, ps.getConnection().createArrayOf("bigint", plantingIds.toArray()));
                },
                (RowCallbackHandler) rs -> out.computeIfAbsent(rs.getLong(1), k -> new ArrayList<>()).add(inst(rs, "used_at")));
        return out;
    }

    // ----------------------------------------------------------------- harvest bonus

    public int harvestBonusPaid(long userId, LocalDate day) {
        List<Integer> rows = jdbc.queryForList(
                "SELECT harvest_bonus_coins FROM public.garden_daily_stats WHERE user_id = ? AND day_key = ?", Integer.class, userId, day);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    public void addHarvestBonus(long userId, LocalDate day, int coins) {
        if (coins <= 0) return;
        GardenScope.evictPrefix("daily:" + userId + ":");
        jdbc.updateLater("""
                INSERT INTO public.garden_daily_stats(user_id, day_key, harvest_bonus_coins) VALUES (?, ?, ?)
                ON CONFLICT (user_id, day_key) DO UPDATE
                SET harvest_bonus_coins = public.garden_daily_stats.harvest_bonus_coins + EXCLUDED.harvest_bonus_coins
                """, userId, day, coins);
    }

    // ----------------------------------------------------------------- farm records

    /** Net ledger movement of the owner's produce and coins per reason: the source of the lifetime farm records. */
    public List<Flow> produceAndCoinFlows(long userId) {
        return jdbc.query("""
                SELECT asset, reason, SUM(delta) AS total FROM public.garden_ledger
                WHERE user_id = ? AND (asset = 'COIN' OR asset LIKE 'CROP:%') GROUP BY asset, reason
                """, (rs, n) -> new Flow(rs.getString(1), rs.getString(2), rs.getLong(3)), userId);
    }
}
