package com.englishcoach.garden.infra;

import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.PestPlanner.Host;
import com.englishcoach.garden.domain.PestPlanner.PestFacts;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static com.englishcoach.garden.infra.GardenRepository.inst;
import static com.englishcoach.garden.infra.GardenRepository.ts;

/**
 * Forgotten Pests (Phase 2). Every statement is scoped by {@code user_id}; partial unique indexes keep at most one
 * active pest per card and per planting, so a concurrent or repeated reconcile can never spawn duplicates. Flashcard
 * facts are read only, through the Flashcard module's own due predicate.
 */
@Repository
public class PestRepository {

    public record PestRow(long id, long flashcardId, String word, String host, Long plantingId, Long treeId,
                          Instant spawnedAt, Instant reviewedAt, Instant clearedAt, String clearReason, boolean rewarded) {

        public PestFacts facts() {
            return new PestFacts(id, flashcardId, Host.valueOf(host), plantingId, treeId, spawnedAt, reviewedAt, clearedAt);
        }
    }

    /** A card overdue by more than the grace, oldest due date first ({@code meaningVi} / {@code ipa} for the panel). */
    public record OverdueRow(long flashcardId, String word) {}

    public record CardInfo(long flashcardId, String word, String meaningVi, String ipa, String status, boolean overdue,
                           boolean due) {}

    private final GardenJdbc jdbc;

    public PestRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    private static PestRow row(ResultSet rs) throws SQLException {
        return new PestRow(rs.getLong("id"), rs.getLong("flashcard_id"), rs.getString("word"), rs.getString("host"),
                (Long) rs.getObject("planting_id", Long.class), (Long) rs.getObject("tree_id", Long.class),
                inst(rs, "spawned_at"), inst(rs, "reviewed_at"), inst(rs, "cleared_at"), rs.getString("clear_reason"),
                rs.getBoolean("rewarded"));
    }

    public List<PestRow> active(long userId) {
        return jdbc.query("SELECT * FROM public.garden_pest WHERE user_id = ? AND cleared_at IS NULL ORDER BY spawned_at, id",
                (rs, n) -> row(rs), userId);
    }

    /** Every pest (active or past) that ever sat on these plantings: growth slowdowns + harvest quality. */
    public List<PestRow> forPlantings(long userId, Collection<Long> plantingIds) {
        if (plantingIds.isEmpty()) return List.of();
        return jdbc.query("SELECT * FROM public.garden_pest WHERE user_id = ? AND planting_id = ANY(?) ORDER BY spawned_at, id",
                ps -> {
                    ps.setLong(1, userId);
                    ps.setArray(2, ps.getConnection().createArrayOf("bigint", plantingIds.toArray()));
                }, (rs, n) -> row(rs));
    }

    public PestRow pest(long userId, long pestId) {
        var rows = jdbc.query("SELECT * FROM public.garden_pest WHERE user_id = ? AND id = ?", (rs, n) -> row(rs), userId, pestId);
        if (rows.isEmpty()) throw new GardenException(404, "PEST_NOT_FOUND");
        return rows.getFirst();
    }

    /** Inserts a pest unless the card / planting already hosts one (partial unique indexes); returns the id or null. */
    public Long insert(long userId, long flashcardId, String word, Host host, Long plantingId, Long treeId, Instant now) {
        var ids = jdbc.queryForList("""
                INSERT INTO public.garden_pest(user_id, flashcard_id, word, host, planting_id, tree_id, spawned_at)
                VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id
                """, Long.class, userId, flashcardId, word, host.name(), plantingId, treeId, ts(now));
        return ids.isEmpty() ? null : ids.getFirst();
    }

    public void markReviewed(long userId, long pestId, Instant reviewedAt) {
        jdbc.updateLater("UPDATE public.garden_pest SET reviewed_at = ? WHERE user_id = ? AND id = ? AND reviewed_at IS NULL",
                ts(reviewedAt), userId, pestId);
    }

    /** Clears an active pest once (0 rows ⇒ already cleared by a concurrent request). */
    public boolean clear(long userId, long pestId, Instant now, String reason, boolean rewarded) {
        return jdbc.update("""
                UPDATE public.garden_pest SET cleared_at = ?, clear_reason = ?, rewarded = ?
                WHERE user_id = ? AND id = ? AND cleared_at IS NULL
                """, ts(now), reason, rewarded, userId, pestId) == 1;
    }

    /** Clears every active pest of a planting (it was harvested) / a tree (it graduated or was released). */
    public void clearForPlanting(long userId, long plantingId, Instant now) {
        jdbc.updateLater("UPDATE public.garden_pest SET cleared_at = ?, clear_reason = 'HOST_GONE' WHERE user_id = ? AND planting_id = ? AND cleared_at IS NULL",
                ts(now), userId, plantingId);
    }

    public void clearForTree(long userId, long treeId, Instant now) {
        jdbc.updateLater("UPDATE public.garden_pest SET cleared_at = ?, clear_reason = 'HOST_GONE' WHERE user_id = ? AND tree_id = ? AND cleared_at IS NULL",
                ts(now), userId, treeId);
    }

    /**
     * Overdue cards of the player (bounded): the Flashcard due predicate shifted by the grace; never MASTERED, never a
     * card that was never studied ({@code next_review_date IS NULL}), never an archived card.
     */
    public List<OverdueRow> overdue(long userId, double graceHours, int limit) {
        return jdbc.query("""
                SELECT f.id, d.word FROM public.flashcards f JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id
                WHERE f.user_id = ? AND (f.state = 0 OR f.state IS NULL) AND f.status <> 'MASTERED'
                  AND f.next_review_date IS NOT NULL AND f.next_review_date <= LOCALTIMESTAMP - (? * interval '1 hour')
                ORDER BY f.next_review_date, f.id LIMIT ?
                """, (rs, n) -> new OverdueRow(rs.getLong(1), rs.getString(2)), userId, graceHours, limit);
    }

    /** Card facts for the pest panel (owner-scoped; absent when the card is gone). */
    public List<CardInfo> cardInfo(long userId, Collection<Long> flashcardIds, double graceHours) {
        if (flashcardIds.isEmpty()) return List.of();
        return jdbc.query("""
                SELECT f.id, d.word, d.general_translation_vi, d.ipa, f.status,
                       (f.status <> 'MASTERED' AND f.next_review_date IS NOT NULL
                        AND f.next_review_date <= LOCALTIMESTAMP - (? * interval '1 hour')) AS overdue,
                       (f.status <> 'MASTERED' AND (f.next_review_date IS NULL OR f.next_review_date <= LOCALTIMESTAMP)) AS due
                FROM public.flashcards f JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id
                WHERE f.user_id = ? AND f.id = ANY(?) AND (f.state = 0 OR f.state IS NULL)
                """, ps -> {
            ps.setDouble(1, graceHours);
            ps.setLong(2, userId);
            ps.setArray(3, ps.getConnection().createArrayOf("bigint", flashcardIds.toArray()));
        }, (rs, n) -> new CardInfo(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5),
                rs.getBoolean(6), rs.getBoolean(7)));
    }

    /**
     * The first genuine review of each waiting pest's card at or after that pest's own appearance, from the Flashcard
     * module's own review log (READ ONLY; not the garden's few-days reward ingest, so a review done while away from the
     * garden still counts). ONE statement for all pests (pest id → instant; a pest without such a review is absent),
     * bounded by the (user_id, occurred_at) index from the oldest appearance.
     */
    public Map<Long, Instant> firstReviews(long userId, List<PestRow> waiting) {
        Map<Long, Instant> out = new HashMap<>();
        if (waiting.isEmpty()) return out;
        Long[] ids = waiting.stream().map(PestRow::id).toArray(Long[]::new);
        String[] cards = waiting.stream().map(p -> String.valueOf(p.flashcardId())).toArray(String[]::new);
        Timestamp[] since = waiting.stream().map(p -> ts(p.spawnedAt())).toArray(Timestamp[]::new);
        Instant oldest = waiting.stream().map(PestRow::spawnedAt).min(Instant::compareTo).orElseThrow();
        jdbc.query("""
                SELECT w.id, min(e.occurred_at) AS first_at
                FROM unnest(?::bigint[], ?::text[], ?::timestamptz[]) AS w(id, card, since)
                JOIN public.learning_activity_events e ON e.user_id = ? AND e.activity_type = 'FLASHCARD_REVIEWED'
                     AND e.occurred_at >= ? AND e.occurred_at >= w.since AND split_part(e.source_ref, ':', 1) = w.card
                GROUP BY w.id
                """, ps -> {
            ps.setArray(1, ps.getConnection().createArrayOf("bigint", ids));
            ps.setArray(2, ps.getConnection().createArrayOf("text", cards));
            ps.setArray(3, ps.getConnection().createArrayOf("timestamptz", since));
            ps.setLong(4, userId);
            ps.setTimestamp(5, ts(oldest));
        }, (RowCallbackHandler) rs -> out.put(rs.getLong(1), inst(rs, "first_at")));
        return out;
    }

    /**
     * Plantings among {@code plantingIds} from which a pest was already sent away by a genuine review, with the instant
     * of the latest such cure. A cured crop stays clean until it is harvested, and the newest of these instants starts
     * the garden's quiet period (Phase 4): the next overdue word may not take the cured pest's place at once.
     */
    public Map<Long, Instant> curedPlantings(long userId, Collection<Long> plantingIds) {
        Map<Long, Instant> out = new HashMap<>();
        if (plantingIds.isEmpty()) return out;
        jdbc.query("""
                SELECT planting_id, max(cleared_at) AS cured_at FROM public.garden_pest
                WHERE planting_id = ANY(?) AND user_id = ? AND clear_reason = 'SPRAYED' GROUP BY planting_id
                """, ps -> {
            ps.setArray(1, ps.getConnection().createArrayOf("bigint", plantingIds.toArray()));
            ps.setLong(2, userId);
        }, (RowCallbackHandler) rs -> out.put(rs.getLong(1), inst(rs, "cured_at")));
        return out;
    }
}
