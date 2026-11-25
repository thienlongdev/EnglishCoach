package com.englishcoach.garden.infra;

import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.ChallengeGenerator.Word;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * All Echo Garden SQL (JdbcTemplate, schema {@code public}). Every statement is scoped by {@code user_id}; every write
 * that protects an invariant is a conditional UPDATE or a constrained INSERT whose row count is checked (READ COMMITTED
 * is sufficient because each invariant lives on one row, GDD 03 §9). Callers hold the per-user advisory lock.
 * Read-only access to other modules: {@code learning_activity_events}, {@code flashcards}, {@code dictionary_entries}.
 */
@Repository
public class GardenRepository {

    /** {@code settings}: the garden's own preferences as stored JSON text (the voluntary guide's record lives there). */
    public record Profile(long userId, long totalXp, long coins, Instant createdAt, Instant lastVisitAt,
                          Instant lastRewardSeenAt, int onboardingStep, String settings) {}

    public record Plot(long id, int slot, int gridX, int gridY, Instant unlockedAt) {}

    /**
     * {@code skinCode}: the cosmetic skin snapshotted at planting time (Phase 3B), null = the base crop art.
     * {@code growthModel} (V84): 1 = the Phase 1-3C growth rules, 2 = Phase 3D (soil moisture); fixed at planting time.
     */
    public record Planting(long id, long plotId, String cropCode, Instant plantedAt, int baseSeconds, boolean tutorial,
                           double boostFraction, int waterCount, String fertilizerCode, String skinCode, int growthModel) {

        public boolean soil() {
            return growthModel >= 2;
        }
    }

    public record Item(String code, String tier, int qty) {}

    public record Operation(String opType, String requestHash, String response) {}

    public record Review(long id, String sourceRef, Instant occurredAt) {}

    public record Daily(LocalDate day, double rawUnits, double effectiveUnits, double waterCarry, int reviews,
                        Instant goalDoneAt, int skillCount, int gameCount, double harvestXpRaw, int pestCures) {

        public Daily(LocalDate day, double rawUnits, double effectiveUnits, double waterCarry, int reviews, Instant goalDoneAt) {
            this(day, rawUnits, effectiveUnits, waterCarry, reviews, goalDoneAt, 0, 0, 0, 0);
        }
    }

    public record Challenge(UUID id, List<Long> targetIds, String questions, Instant createdAt, Instant expiresAt,
                            Instant completedAt, String result) {}

    private final GardenJdbc jdbc;

    public GardenRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    public JdbcTemplate jdbc() {
        return jdbc;
    }

    /** Serialises every garden mutation of one user (released at commit / rollback). */
    public void lock(long userId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtext(?))", (RowCallbackHandler) rs -> {}, "garden:" + userId);
    }

    /**
     * Phase 5: the same lock and, in the SAME exchange with the database, the first read of every probe (see
     * {@link GardenJdbc#lockThen}). The server takes the lock first and runs the reads after it.
     */
    public void lock(long userId, Runnable... probes) {
        jdbc.lockThen("SELECT pg_advisory_xact_lock(hashtext(?))", "garden:" + userId, probes);
    }

    /**
     * Phase 3G: the locks of two gardens in one statement, taken in ascending lock-key order (the same keys as
     * {@link #lock}), so two players acting on each other's islands at the same moment can never wait on each other.
     */
    public void lockPair(long userA, long userB) {
        jdbc.query("""
                SELECT pg_advisory_xact_lock(s.h) FROM (
                    SELECT DISTINCT hashtext(k)::bigint AS h FROM unnest(?::text[]) AS k ORDER BY 1) s
                """, ps -> ps.setArray(1, ps.getConnection().createArrayOf("text", new String[]{"garden:" + userA, "garden:" + userB})),
                (RowCallbackHandler) rs -> {});
    }

    // ----------------------------------------------------------------- profile

    public boolean createProfile(long userId, Instant now) {
        GardenScope.evict("profile:" + userId);
        return jdbc.update("INSERT INTO public.garden_profile(user_id, created_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING",
                userId, ts(now)) == 1;
    }

    /** Memoized for the transaction ({@link GardenScope}); every write of the row evicts it. */
    public Profile profile(long userId) {
        return GardenScope.get("profile:" + userId, () -> {
            var rows = jdbc.query("SELECT * FROM public.garden_profile WHERE user_id = ?", (rs, n) -> new Profile(
                    rs.getLong("user_id"), rs.getLong("total_xp"), rs.getLong("coins"), inst(rs, "created_at"),
                    inst(rs, "last_visit_at"), inst(rs, "last_reward_seen_at"), rs.getInt("onboarding_step"),
                    rs.getString("settings")), userId);
            return rows.isEmpty() ? null : rows.getFirst();
        });
    }

    /** Conditional coin change: never below zero (row count 0 ⇒ insufficient funds). */
    public boolean changeCoins(long userId, long delta) {
        GardenScope.evict("profile:" + userId);
        if (delta > 0) {
            // a credit cannot fail the balance guard and every caller ignores its result (the garden exists: ensure)
            jdbc.updateLater("UPDATE public.garden_profile SET coins = coins + ? WHERE user_id = ? AND coins + ? >= 0", delta, userId, delta);
            return true;
        }
        return jdbc.update("UPDATE public.garden_profile SET coins = coins + ? WHERE user_id = ? AND coins + ? >= 0",
                delta, userId, delta) == 1;
    }

    public long addXp(long userId, long delta) {
        GardenScope.evict("profile:" + userId);
        return jdbc.queryForObject("UPDATE public.garden_profile SET total_xp = total_xp + ? WHERE user_id = ? RETURNING total_xp",
                Long.class, delta, userId);
    }

    public void advanceOnboarding(long userId, int step) {
        GardenScope.evict("profile:" + userId);
        jdbc.updateLater("UPDATE public.garden_profile SET onboarding_step = GREATEST(onboarding_step, ?) WHERE user_id = ?", step, userId);
    }

    /**
     * The voluntary guide's record ({@code settings.guide}) and the floor of the old tutorial step, in one statement.
     * Nothing else of the garden is written; the caller holds the garden lock and decided the new record from the old.
     */
    public void saveGuide(long userId, String guideJson, int onboardingFloor) {
        GardenScope.evict("profile:" + userId);
        jdbc.updateLater("""
                UPDATE public.garden_profile
                   SET settings = jsonb_set(settings, '{guide}', ?::jsonb, true),
                       onboarding_step = GREATEST(onboarding_step, ?)
                 WHERE user_id = ?
                """, guideJson, onboardingFloor, userId);
    }

    public void touchVisit(long userId, Instant now) {
        GardenScope.evict("profile:" + userId);
        jdbc.updateLater("UPDATE public.garden_profile SET last_visit_at = ? WHERE user_id = ?", ts(now), userId);
    }

    public void markRewardsSeen(long userId, Instant now) {
        GardenScope.evict("profile:" + userId);
        jdbc.updateLater("UPDATE public.garden_profile SET last_reward_seen_at = ? WHERE user_id = ?", ts(now), userId);
    }

    // ----------------------------------------------------------------- plots / plantings

    public void createPlot(long userId, int slot, int gridX, int gridY, Instant now) {
        GardenScope.evict("plots:" + userId);
        jdbc.update("""
                INSERT INTO public.garden_plot(user_id, kind, slot_index, grid_x, grid_y, unlocked_at)
                VALUES (?, 'CROP', ?, ?, ?, ?) ON CONFLICT (user_id, kind, slot_index) DO NOTHING
                """, userId, slot, gridX, gridY, ts(now));
    }

    /** Memoized for the transaction; a new bed ({@link #createPlot}, an expansion or land purchase) evicts it. */
    public List<Plot> plots(long userId) {
        return GardenScope.get("plots:" + userId, () -> List.copyOf(jdbc.query(
                "SELECT * FROM public.garden_plot WHERE user_id = ? AND kind = 'CROP' ORDER BY slot_index",
                (rs, n) -> new Plot(rs.getLong("id"), rs.getInt("slot_index"), rs.getInt("grid_x"), rs.getInt("grid_y"),
                        inst(rs, "unlocked_at")), userId)));
    }

    public Plot plot(long userId, long plotId) {
        var rows = jdbc.query("SELECT * FROM public.garden_plot WHERE user_id = ? AND id = ? AND kind = 'CROP'",
                (rs, n) -> new Plot(rs.getLong("id"), rs.getInt("slot_index"), rs.getInt("grid_x"), rs.getInt("grid_y"),
                        inst(rs, "unlocked_at")), userId, plotId);
        if (rows.isEmpty()) throw new GardenException(404, "PLOT_NOT_FOUND");
        return rows.getFirst();
    }

    private static Planting planting(ResultSet rs) throws SQLException {
        return new Planting(rs.getLong("id"), rs.getLong("plot_id"), rs.getString("crop_code"), inst(rs, "planted_at"),
                rs.getInt("base_seconds"), rs.getBoolean("tutorial"), rs.getBigDecimal("boost_fraction").doubleValue(),
                rs.getInt("water_count"), rs.getString("fertilizer_code"), rs.getString("skin_code"), rs.getInt("growth_model"));
    }

    public List<Planting> activePlantings(long userId) {
        return jdbc.query("SELECT * FROM public.garden_planting WHERE user_id = ? AND harvested_at IS NULL",
                (rs, n) -> planting(rs), userId);
    }

    public Planting activePlanting(long userId, long plantingId) {
        var rows = jdbc.query("SELECT * FROM public.garden_planting WHERE user_id = ? AND id = ?",
                (rs, n) -> rs.getTimestamp("harvested_at") == null ? planting(rs) : null, userId, plantingId);
        if (rows.isEmpty()) throw new GardenException(404, "PLANTING_NOT_FOUND");
        if (rows.getFirst() == null) throw GardenException.conflict("ALREADY_HARVESTED");
        return rows.getFirst();
    }

    public boolean plotOccupied(long userId, long plotId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_planting WHERE user_id = ? AND plot_id = ? AND harvested_at IS NULL",
                Integer.class, userId, plotId);
        return n != null && n > 0;
    }

    public long countPlantings(long userId) {
        Long n = jdbc.queryForObject("SELECT count(*) FROM public.garden_planting WHERE user_id = ?", Long.class, userId);
        return n == null ? 0 : n;
    }

    /** {@code skinCode}: a skin of this crop the player owns (both enforced by foreign keys), or null. */
    public long insertPlanting(long userId, long plotId, String crop, Instant plantedAt, int baseSeconds, boolean tutorial,
                               String skinCode, int growthModel) {
        return jdbc.queryForObject("""
                INSERT INTO public.garden_planting(user_id, plot_id, crop_code, planted_at, base_seconds, tutorial, skin_code,
                    growth_model)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
                """, Long.class, userId, plotId, crop, ts(plantedAt), baseSeconds, tutorial, skinCode, growthModel);
    }

    /**
     * Conditional boost (GDD 03 §9): fails (0 rows) when the planting was harvested, the water limit is reached, a
     * fertilizer was already used or the boost cap would be exceeded.
     */
    public boolean applyBoost(long userId, long plantingId, double fraction, boolean water, String fertilizer,
                              int waterLimit, double maxBoost) {
        BigDecimal f = BigDecimal.valueOf(fraction);
        BigDecimal cap = BigDecimal.valueOf(maxBoost);
        if (water) {
            return jdbc.update("""
                    UPDATE public.garden_planting SET boost_fraction = boost_fraction + ?, water_count = water_count + 1
                    WHERE user_id = ? AND id = ? AND harvested_at IS NULL AND water_count < ? AND boost_fraction + ? <= ?
                    """, f, userId, plantingId, waterLimit, f, cap) == 1;
        }
        return jdbc.update("""
                UPDATE public.garden_planting SET boost_fraction = boost_fraction + ?, fertilizer_code = ?
                WHERE user_id = ? AND id = ? AND harvested_at IS NULL AND fertilizer_code IS NULL AND boost_fraction + ? <= ?
                """, f, fertilizer, userId, plantingId, f, cap) == 1;
    }

    public void recordBoostUse(long userId, long plantingId, String item, Instant now, UUID opKey) {
        jdbc.updateLater("INSERT INTO public.garden_boost_use(planting_id, user_id, item_code, used_at, op_key) VALUES (?, ?, ?, ?, ?)",
                plantingId, userId, item, ts(now), opKey);
    }

    /**
     * Phase 3C: when each of these plantings was watered or fertilized (a few rows per planting), so a pest's growth
     * penalty can be softened from the first care given after the pest appeared.
     */
    public Map<Long, List<Instant>> careTimes(long userId, java.util.Collection<Long> plantingIds) {
        Map<Long, List<Instant>> out = new java.util.HashMap<>();
        if (plantingIds.isEmpty()) return out;
        jdbc.query("SELECT planting_id, used_at FROM public.garden_boost_use WHERE user_id = ? AND planting_id = ANY(?) ORDER BY used_at",
                ps -> {
                    ps.setLong(1, userId);
                    ps.setArray(2, ps.getConnection().createArrayOf("bigint", plantingIds.toArray()));
                },
                (RowCallbackHandler) rs -> out.computeIfAbsent(rs.getLong(1), k -> new ArrayList<>()).add(inst(rs, "used_at")));
        return out;
    }

    /** Phase 3C: the level of every building this garden owns (a building it never bought is absent = level 0). */
    public Map<String, Integer> buildingLevels(long userId) {
        // memoized for the transaction; EstateRepository evicts it when a building is bought or upgraded
        return GardenScope.get("buildings:" + userId, () -> {
            Map<String, Integer> out = new java.util.HashMap<>();
            jdbc.query("SELECT code, level FROM public.garden_building WHERE user_id = ?",
                    (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getInt(2)), userId);
            return Map.copyOf(out);
        });
    }

    /** Closes a planting exactly once (0 rows ⇒ already harvested by a concurrent request). */
    public boolean markHarvested(long userId, long plantingId, Instant now, String tier, int score, String flagsJson) {
        return jdbc.update("""
                UPDATE public.garden_planting SET harvested_at = ?, harvest_tier = ?, harvest_score = ?, harvest_flags = ?::jsonb
                WHERE user_id = ? AND id = ? AND harvested_at IS NULL
                """, ts(now), tier, score, flagsJson, userId, plantingId) == 1;
    }

    // ----------------------------------------------------------------- inventory / ledger

    /** Memoized for the transaction; {@link #changeItem} (the only writer of the table) evicts it. */
    public List<Item> inventory(long userId) {
        return GardenScope.get("inventory:" + userId, () -> List.copyOf(jdbc.query(
                "SELECT item_code, tier, qty FROM public.garden_inventory WHERE user_id = ? AND qty > 0 ORDER BY item_code, tier",
                (rs, n) -> new Item(rs.getString(1), rs.getString(2), rs.getInt(3)), userId)));
    }

    public int itemQty(long userId, String item, String tier) {
        var rows = jdbc.queryForList("SELECT qty FROM public.garden_inventory WHERE user_id = ? AND item_code = ? AND tier = ?",
                Integer.class, userId, item, tier);
        return rows.isEmpty() ? 0 : rows.getFirst();
    }

    /** Adds (upsert) or removes (conditional, never below zero) inventory; false ⇒ not enough items. */
    public boolean changeItem(long userId, String item, String tier, int delta) {
        GardenScope.evict("inventory:" + userId);
        if (delta >= 0) {
            // adding never fails and nobody reads its row count: it leaves with the ledger line that follows it
            jdbc.updateLater("""
                    INSERT INTO public.garden_inventory(user_id, item_code, tier, qty) VALUES (?, ?, ?, ?)
                    ON CONFLICT (user_id, item_code, tier) DO UPDATE SET qty = public.garden_inventory.qty + EXCLUDED.qty
                    """, userId, item, tier, delta);
            return true;
        }
        return jdbc.update("UPDATE public.garden_inventory SET qty = qty + ? WHERE user_id = ? AND item_code = ? AND tier = ? AND qty + ? >= 0",
                delta, userId, item, tier, delta) == 1;
    }

    public void ledger(long userId, String asset, String tier, long delta, String reason, String refType, String refId,
                       UUID opKey, Instant now) {
        if (delta == 0) return;
        jdbc.updateLater("""
                INSERT INTO public.garden_ledger(user_id, asset, tier, delta, reason, ref_type, ref_id, op_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, userId, asset, tier, delta, reason, refType, refId, opKey, ts(now));
    }

    /** Ledger totals per asset since an instant (rewards basket). */
    public Map<String, Long> ledgerSince(long userId, String reason, Instant since) {
        Map<String, Long> out = new java.util.HashMap<>();
        jdbc.query("SELECT asset, sum(delta) FROM public.garden_ledger WHERE user_id = ? AND reason = ? AND created_at > ? GROUP BY asset",
                (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getLong(2)), userId, reason, ts(since));
        return out;
    }

    // ----------------------------------------------------------------- idempotency

    public Operation operation(long userId, UUID key) {
        var rows = jdbc.query("SELECT op_type, request_hash, response::text FROM public.garden_operation WHERE user_id = ? AND idem_key = ?",
                (rs, n) -> new Operation(rs.getString(1), rs.getString(2), rs.getString(3)), userId, key);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public void saveOperation(long userId, UUID key, String opType, String hash, String responseJson, Instant now) {
        jdbc.updateLater("""
                INSERT INTO public.garden_operation(user_id, idem_key, op_type, request_hash, status, response, created_at)
                VALUES (?, ?, ?, ?, 'DONE', ?::jsonb, ?)
                """, userId, key, opType, hash, responseJson, ts(now));
    }

    // ----------------------------------------------------------------- learning ingest (read-only on other modules)

    public Review[] reviewsAfter(long userId, Instant afterOccurred, long afterId, Instant notBefore, int limit) {
        return jdbc.query("""
                SELECT id, source_ref, occurred_at FROM public.learning_activity_events
                WHERE user_id = ? AND activity_type = 'FLASHCARD_REVIEWED' AND occurred_at >= ?
                  AND (occurred_at, id) > (?, ?)
                ORDER BY occurred_at, id LIMIT ?
                """, (rs, n) -> new Review(rs.getLong(1), rs.getString(2), inst(rs, "occurred_at")),
                userId, ts(notBefore), ts(afterOccurred), afterId, limit).toArray(Review[]::new);
    }

    /** One ingest cursor: the instant and the source row id it has reached. */
    public record Cursor(Instant occurredAt, long sourceId) {}

    /**
     * Every ingest cursor of a garden in ONE statement (source -> cursor), memoized for the transaction. The flashcard
     * ingest and each learning source used to read their cursor with a statement of their own.
     */
    public Map<String, Cursor> cursors(long userId) {
        return GardenScope.get("cursors:" + userId, () -> {
            Map<String, Cursor> out = new java.util.HashMap<>();
            jdbc.query("SELECT source, last_occurred_at, last_source_id FROM public.garden_ingest_cursor WHERE user_id = ?",
                    (RowCallbackHandler) rs -> out.put(rs.getString(1), new Cursor(inst(rs, "last_occurred_at"), rs.getLong(3))), userId);
            return Map.copyOf(out);
        });
    }

    public Instant cursorTime(long userId, String source) {
        Cursor c = cursors(userId).get(source);
        return c == null ? null : c.occurredAt();
    }

    public long cursorId(long userId, String source) {
        Cursor c = cursors(userId).get(source);
        return c == null ? 0 : c.sourceId();
    }

    /** Stores a cursor; a cursor that has not moved is not written again (no write on an idle state read). */
    public void saveCursor(long userId, String source, Instant occurredAt, long sourceId) {
        Cursor current = cursors(userId).get(source);
        if (current != null && current.sourceId() == sourceId && current.occurredAt() != null && current.occurredAt().equals(occurredAt)) return;
        GardenScope.evict("cursors:" + userId);
        jdbc.updateLater("""
                INSERT INTO public.garden_ingest_cursor(user_id, source, last_occurred_at, last_source_id) VALUES (?, ?, ?, ?)
                ON CONFLICT (user_id, source) DO UPDATE SET last_occurred_at = EXCLUDED.last_occurred_at,
                                                            last_source_id = EXCLUDED.last_source_id
                """, userId, source, ts(occurredAt), sourceId);
    }

    /** Inserts a learning event once (unique source, source_ref); returns its id, or null when already ingested. */
    public Long insertLearningEvent(long userId, String source, String sourceRef, String subjectRef, Instant occurredAt,
                                    LocalDate day, double units, String metaJson, Instant now) {
        var ids = jdbc.queryForList("""
                INSERT INTO public.garden_learning_event(user_id, source, source_ref, subject_ref, occurred_at, day_key, units, meta, ingested_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?) ON CONFLICT (source, source_ref) DO NOTHING RETURNING id
                """, Long.class, userId, source, sourceRef, subjectRef, ts(occurredAt), day, BigDecimal.valueOf(units), metaJson, ts(now));
        return ids.isEmpty() ? null : ids.getFirst();
    }

    public int learningEventsIngestedSince(long userId, Instant since) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_learning_event WHERE user_id = ? AND source = 'FLASHCARD_REVIEW' AND ingested_at > ?",
                Integer.class, userId, ts(since));
        return n == null ? 0 : n;
    }

    /** Credited skill lessons / games ingested since an instant (rewards basket). */
    public long lessonsIngestedSince(long userId, Instant since) {
        Long n = jdbc.queryForObject("SELECT count(*) FROM public.garden_learning_event WHERE user_id = ? AND source <> 'FLASHCARD_REVIEW' AND units > 0 AND ingested_at > ?",
                Long.class, userId, ts(since));
        return n == null ? 0 : n;
    }

    public boolean subjectSeenOnDay(long userId, String source, LocalDate day, String subjectRef) {
        Integer n = jdbc.queryForObject("""
                SELECT count(*) FROM public.garden_learning_event
                WHERE user_id = ? AND day_key = ? AND source = ? AND subject_ref = ?
                """, Integer.class, userId, day, source, subjectRef);
        return n != null && n > 0;
    }

    /** Memoized for the transaction; every write of the garden's day row evicts it. */
    public Daily daily(long userId, LocalDate day) {
        return GardenScope.get("daily:" + userId + ":" + day, () -> {
            var rows = jdbc.query("SELECT * FROM public.garden_daily_stats WHERE user_id = ? AND day_key = ?", (rs, n) -> new Daily(
                    day, rs.getDouble("flash_units_raw"), rs.getDouble("flash_units_effective"), rs.getDouble("water_carry"),
                    rs.getInt("reviews_count"), inst(rs, "goal_done_at"), rs.getInt("skill_count"), rs.getInt("game_count"),
                    rs.getDouble("harvest_xp_raw"), rs.getInt("pest_cures")), userId, day);
            return rows.isEmpty() ? new Daily(day, 0, 0, 0, 0, null) : rows.getFirst();
        });
    }

    /** Phase 2 day counters (credited skill lessons / games, raw harvest XP, rewarded pest cures): atomic increments. */
    public void addDailyCounters(long userId, LocalDate day, int skills, int games, double harvestXpRaw, int pestCures) {
        GardenScope.evictPrefix("daily:" + userId + ":");
        jdbc.updateLater("""
                INSERT INTO public.garden_daily_stats(user_id, day_key, skill_count, game_count, harvest_xp_raw, pest_cures)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (user_id, day_key) DO UPDATE SET skill_count = public.garden_daily_stats.skill_count + EXCLUDED.skill_count,
                    game_count = public.garden_daily_stats.game_count + EXCLUDED.game_count,
                    harvest_xp_raw = public.garden_daily_stats.harvest_xp_raw + EXCLUDED.harvest_xp_raw,
                    pest_cures = public.garden_daily_stats.pest_cures + EXCLUDED.pest_cures
                """, userId, day, skills, games, BigDecimal.valueOf(harvestXpRaw), pestCures);
    }

    /** Records the goal instant of a day once (Phase 2 goal variants evaluated after all sources are ingested). */
    public boolean markGoal(long userId, LocalDate day, Instant at) {
        GardenScope.evictPrefix("daily:" + userId + ":");
        return jdbc.update("""
                INSERT INTO public.garden_daily_stats(user_id, day_key, goal_done_at) VALUES (?, ?, ?)
                ON CONFLICT (user_id, day_key) DO UPDATE SET goal_done_at = EXCLUDED.goal_done_at
                WHERE public.garden_daily_stats.goal_done_at IS NULL
                """, userId, day, ts(at)) == 1;
    }

    public void saveDaily(long userId, Daily d) {
        GardenScope.evictPrefix("daily:" + userId + ":");
        jdbc.updateLater("""
                INSERT INTO public.garden_daily_stats(user_id, day_key, flash_units_raw, flash_units_effective, water_carry, reviews_count, goal_done_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (user_id, day_key) DO UPDATE SET flash_units_raw = EXCLUDED.flash_units_raw,
                    flash_units_effective = EXCLUDED.flash_units_effective, water_carry = EXCLUDED.water_carry,
                    reviews_count = EXCLUDED.reviews_count,
                    goal_done_at = COALESCE(public.garden_daily_stats.goal_done_at, EXCLUDED.goal_done_at)
                """, userId, d.day(), BigDecimal.valueOf(d.rawUnits()), BigDecimal.valueOf(d.effectiveUnits()),
                BigDecimal.valueOf(d.waterCarry()), d.reviews(), ts(d.goalDoneAt()));
    }

    /** Due cards exactly as the Flashcard module counts them (FlashcardRepository#findDueFlashcards). */
    public long dueCount(long userId) {
        Long n = jdbc.queryForObject("""
                SELECT count(*) FROM public.flashcards
                WHERE user_id = ? AND (state = 0 OR state IS NULL) AND status <> 'MASTERED'
                  AND (next_review_date IS NULL OR next_review_date <= LOCALTIMESTAMP)
                """, Long.class, userId);
        return n == null ? 0 : n;
    }

    // ----------------------------------------------------------------- recall words (read-only)

    private static final String WORD_SELECT = """
            SELECT f.id, d.word, d.general_translation_vi, d.ipa FROM public.flashcards f
            JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id
            WHERE f.user_id = ? AND (f.state = 0 OR f.state IS NULL) AND COALESCE(d.general_translation_vi, '') <> ''
            """;

    private static Word word(ResultSet rs) throws SQLException {
        Object id = rs.getObject(1);
        return new Word(id == null ? null : ((Number) id).longValue(), rs.getString(2), rs.getString(3), rs.getString(4));
    }

    /** Priority groups (GDD 03 §8): overdue learned cards, recently studied cards, other studied cards, unstudied cards. */
    public List<List<Word>> recallGroups(long userId, int recentDays) {
        List<List<Word>> groups = new ArrayList<>();
        groups.add(jdbc.query(WORD_SELECT + " AND f.status = 'LEARNED' AND f.next_review_date <= LOCALTIMESTAMP ORDER BY f.next_review_date LIMIT 30",
                (rs, n) -> word(rs), userId));
        groups.add(jdbc.query(WORD_SELECT + " AND f.status IN ('LEARNED','MASTERED') AND f.updated_at >= LOCALTIMESTAMP - make_interval(days => ?) ORDER BY f.updated_at DESC LIMIT 30",
                (rs, n) -> word(rs), userId, recentDays));
        groups.add(jdbc.query(WORD_SELECT + " AND f.status IN ('LEARNED','MASTERED') ORDER BY f.id LIMIT 60",
                (rs, n) -> word(rs), userId));
        groups.add(jdbc.query(WORD_SELECT + " ORDER BY f.id LIMIT 60", (rs, n) -> word(rs), userId));
        return groups;
    }

    /** SYSTEM starter vocabulary (shared dictionary, A1/A2 with a Vietnamese translation), sampled per seed. */
    public List<Word> starterVocabulary(String seed, int limit) {
        return jdbc.query("""
                SELECT NULL::bigint, word, general_translation_vi, ipa FROM public.dictionary_entries
                WHERE owner_user_id IS NULL AND cefr IN ('A1','A2') AND COALESCE(general_translation_vi, '') <> '' AND word ~ '^[A-Za-z][A-Za-z -]{1,24}$'
                ORDER BY md5(word || ?) LIMIT ?
                """, (rs, n) -> word(rs), seed, limit);
    }

    // ----------------------------------------------------------------- challenges

    public void insertChallenge(long userId, UUID id, List<Long> targets, String questionsJson, Instant now, Instant expires) {
        insertChallenge(userId, id, "HARVEST", targets, questionsJson, now, expires);
    }

    public void insertChallenge(long userId, UUID id, String kind, List<Long> targets, String questionsJson, Instant now,
                                Instant expires) {
        jdbc.update("""
                INSERT INTO public.garden_challenge(id, user_id, kind, target_ids, questions, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?::jsonb, ?, ?)
                """, ps -> {
            ps.setObject(1, id);
            ps.setLong(2, userId);
            ps.setString(3, kind);
            ps.setArray(4, ps.getConnection().createArrayOf("bigint", targets.toArray()));
            ps.setString(5, questionsJson);
            ps.setTimestamp(6, ts(now));
            ps.setTimestamp(7, ts(expires));
        });
    }

    public Challenge challenge(long userId, UUID id) {
        return challenge(userId, id, "HARVEST");
    }

    public Challenge challenge(long userId, UUID id, String kind) {
        var rows = jdbc.query("SELECT * FROM public.garden_challenge WHERE user_id = ? AND id = ? AND kind = ?", (rs, n) -> {
            Array arr = rs.getArray("target_ids");
            List<Long> targets = new ArrayList<>();
            for (Object o : (Object[]) arr.getArray()) targets.add(((Number) o).longValue());
            return new Challenge(rs.getObject("id", UUID.class), targets, rs.getString("questions"), inst(rs, "created_at"),
                    inst(rs, "expires_at"), inst(rs, "completed_at"), rs.getString("result"));
        }, userId, id, kind);
        if (rows.isEmpty()) throw new GardenException(404, "CHALLENGE_NOT_FOUND");
        return rows.getFirst();
    }

    /** Closes a challenge once and only before it expires (0 rows ⇒ already completed or expired). */
    public boolean completeChallenge(long userId, UUID id, Instant now, String resultJson) {
        return jdbc.update("""
                UPDATE public.garden_challenge SET completed_at = ?, result = ?::jsonb
                WHERE user_id = ? AND id = ? AND completed_at IS NULL AND expires_at > ?
                """, ts(now), resultJson, userId, id, ts(now)) == 1;
    }

    // ----------------------------------------------------------------- codex / event log

    public boolean recordCodexForm(long userId, String crop, String form, Instant now) {
        return jdbc.update("INSERT INTO public.garden_codex(user_id, crop_code, form, first_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
                userId, crop, form, ts(now)) == 1;
    }

    public void log(long userId, String type, String payloadJson, Instant now) {
        jdbc.updateLater("INSERT INTO public.garden_event_log(user_id, type, payload, created_at) VALUES (?, ?, ?::jsonb, ?)",
                userId, type, payloadJson, ts(now));
    }

    // ----------------------------------------------------------------- helpers

    /** Ledger totals per asset for several reasons since an instant (rewards basket). */
    public Map<String, Long> ledgerSince(long userId, List<String> reasons, Instant since) {
        Map<String, Long> out = new java.util.HashMap<>();
        jdbc.query("SELECT asset, sum(delta) FROM public.garden_ledger WHERE user_id = ? AND reason = ANY(?) AND created_at > ? GROUP BY asset",
                ps -> {
                    ps.setLong(1, userId);
                    ps.setArray(2, ps.getConnection().createArrayOf("varchar", reasons.toArray()));
                    ps.setTimestamp(3, ts(since));
                },
                (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getLong(2)));
        return out;
    }

    public int essence(long userId) {
        Integer n = jdbc.queryForObject("SELECT essence FROM public.garden_profile WHERE user_id = ?", Integer.class, userId);
        return n == null ? 0 : n;
    }

    /** Conditional essence change: never below zero (CHECK + row count). */
    public boolean changeEssence(long userId, long delta) {
        GardenScope.evict("profile:" + userId);
        return jdbc.update("UPDATE public.garden_profile SET essence = essence + ? WHERE user_id = ? AND essence + ? >= 0",
                delta, userId, delta) == 1;
    }

    static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    static Instant inst(ResultSet rs, String col) throws SQLException {
        Timestamp t = rs.getTimestamp(col);
        return t == null ? null : t.toInstant();
    }
}
