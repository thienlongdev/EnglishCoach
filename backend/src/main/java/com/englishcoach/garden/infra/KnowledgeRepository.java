package com.englishcoach.garden.infra;

import com.englishcoach.garden.api.GardenException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static com.englishcoach.garden.infra.GardenRepository.inst;
import static com.englishcoach.garden.infra.GardenRepository.ts;

/**
 * Knowledge Trees, their five card bindings and the Memory Forest (Phase 2). Every statement is scoped by
 * {@code user_id}. Flashcard facts are READ ONLY and scoped by {@code flashcards.user_id}; overdue uses the Flashcard
 * module's own due predicate ({@code status <> 'MASTERED' AND next_review_date <= LOCALTIMESTAMP}) shifted by the grace.
 */
@Repository
public class KnowledgeRepository {

    public record TreeRow(long id, int slot, String species, Instant plantedAt, String status, int peakStage,
                          double essenceBanked, Instant essenceSince, int attempts, Instant retryAt, Instant graduatedAt) {}

    public record TreeCardRow(long treeId, int position, long flashcardId, String word, String meaningVi) {}

    /** A card as the Flashcard module sees it now (absent = deleted, archived or not the player's). */
    public record LiveCard(long flashcardId, String status, boolean overdue, boolean due) {}

    /** Distinct garden-zone days a card was reviewed since an instant (Flashcard review log) and the last review. */
    public record ReviewEvidence(int days, Instant lastAt) {}

    public record Candidate(long flashcardId, String word, String meaningVi, String ipa, String status, Long deckId,
                            String deckTitle, boolean overdue, boolean bound) {}

    public record Deck(Long deckId, String title, int cards) {}

    private static final String OVERDUE = "(f.status <> 'MASTERED' AND f.next_review_date IS NOT NULL "
            + "AND f.next_review_date <= LOCALTIMESTAMP - (? * interval '1 hour'))";
    private static final String DUE = "(f.status <> 'MASTERED' AND (f.next_review_date IS NULL OR f.next_review_date <= LOCALTIMESTAMP))";

    private final JdbcTemplate jdbc;

    public KnowledgeRepository(JdbcTemplate jdbc) {
        this.jdbc = GardenJdbc.of(jdbc);
    }

    private static TreeRow tree(ResultSet rs) throws SQLException {
        return new TreeRow(rs.getLong("id"), rs.getInt("slot"), rs.getString("species"), inst(rs, "planted_at"),
                rs.getString("status"), rs.getInt("peak_stage"), rs.getBigDecimal("essence_banked").doubleValue(),
                inst(rs, "essence_since"), rs.getInt("graduation_attempts"), inst(rs, "graduation_retry_at"),
                inst(rs, "graduated_at"));
    }

    public List<TreeRow> activeTrees(long userId) {
        return jdbc.query("SELECT * FROM public.garden_knowledge_tree WHERE user_id = ? AND status = 'ACTIVE' ORDER BY slot",
                (rs, n) -> tree(rs), userId);
    }

    public TreeRow tree(long userId, long treeId) {
        var rows = jdbc.query("SELECT * FROM public.garden_knowledge_tree WHERE user_id = ? AND id = ?", (rs, n) -> tree(rs),
                userId, treeId);
        if (rows.isEmpty()) throw new GardenException(404, "TREE_NOT_FOUND");
        return rows.getFirst();
    }

    public TreeRow activeTree(long userId, long treeId) {
        TreeRow t = tree(userId, treeId);
        if (!"ACTIVE".equals(t.status())) throw GardenException.conflict("TREE_NOT_ACTIVE");
        return t;
    }

    public List<TreeCardRow> cards(long userId, Collection<Long> treeIds) {
        if (treeIds.isEmpty()) return List.of();
        return jdbc.query("""
                SELECT tree_id, position, flashcard_id, word, meaning_vi FROM public.garden_knowledge_card
                WHERE user_id = ? AND tree_id = ANY(?) ORDER BY tree_id, position
                """, ps -> {
            ps.setLong(1, userId);
            ps.setArray(2, ps.getConnection().createArrayOf("bigint", treeIds.toArray()));
        }, (rs, n) -> new TreeCardRow(rs.getLong(1), rs.getInt(2), rs.getLong(3), rs.getString(4), rs.getString(5)));
    }

    /** The player's current facts for the given card ids (cards that are gone are simply absent). */
    public Map<Long, LiveCard> liveCards(long userId, Collection<Long> flashcardIds, double graceHours) {
        Map<Long, LiveCard> out = new HashMap<>();
        if (flashcardIds.isEmpty()) return out;
        jdbc.query("SELECT f.id, f.status, " + OVERDUE + " AS overdue, " + DUE + " AS due FROM public.flashcards f "
                        + "WHERE f.user_id = ? AND f.id = ANY(?) AND (f.state = 0 OR f.state IS NULL)",
                ps -> {
                    ps.setDouble(1, graceHours);
                    ps.setLong(2, userId);
                    ps.setArray(3, ps.getConnection().createArrayOf("bigint", flashcardIds.toArray()));
                },
                (RowCallbackHandler) rs -> out.put(rs.getLong(1), new LiveCard(rs.getLong(1), rs.getString(2),
                        rs.getBoolean(3), rs.getBoolean(4))));
        return out;
    }

    /** Evidence of each card since {@code since}: distinct review days in the ingested {@code FLASHCARD_REVIEW} log. */
    /**
     * Tree evidence reads the Flashcard module's own review log ({@code learning_activity_events}, READ ONLY, one row per
     * review: {@code source_ref = cardId:reviewCount}) — never the garden's reward ingest, which only looks back a few
     * days: a review done while the learner stayed away from the garden still grows the tree. Bounded by the
     * (user_id, occurred_at) index from the planting instant.
     */
    public Map<Long, ReviewEvidence> reviewEvidence(long userId, Collection<Long> flashcardIds, Instant since, ZoneId zone) {
        Map<Long, ReviewEvidence> out = new HashMap<>();
        if (flashcardIds.isEmpty()) return out;
        List<String> refs = flashcardIds.stream().map(String::valueOf).toList();
        jdbc.query("""
                SELECT split_part(source_ref, ':', 1) AS card, count(DISTINCT (occurred_at AT TIME ZONE ?)::date),
                       max(occurred_at) AS last_at
                FROM public.learning_activity_events
                WHERE user_id = ? AND activity_type = 'FLASHCARD_REVIEWED' AND occurred_at >= ?
                  AND split_part(source_ref, ':', 1) = ANY(?)
                GROUP BY 1
                """, ps -> {
            ps.setString(1, zone.getId());
            ps.setLong(2, userId);
            ps.setTimestamp(3, ts(since));
            ps.setArray(4, ps.getConnection().createArrayOf("varchar", refs.toArray()));
        }, (RowCallbackHandler) rs -> out.put(Long.parseLong(rs.getString(1)),
                new ReviewEvidence(rs.getInt(2), inst(rs, "last_at"))));
        return out;
    }

    public long insertTree(long userId, int slot, String species, Instant now) {
        return jdbc.queryForObject("""
                INSERT INTO public.garden_knowledge_tree(user_id, slot, species, planted_at, essence_since)
                VALUES (?, ?, ?, ?, ?) RETURNING id
                """, Long.class, userId, slot, species, ts(now), ts(now));
    }

    public void insertCard(long userId, long treeId, int position, long flashcardId, String word, String meaningVi) {
        jdbc.update("""
                INSERT INTO public.garden_knowledge_card(tree_id, user_id, position, flashcard_id, word, meaning_vi)
                VALUES (?, ?, ?, ?, ?, ?)
                """, treeId, userId, position, flashcardId, word, meaningVi);
    }

    public boolean slotOccupied(long userId, int slot) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_knowledge_tree WHERE user_id = ? AND slot = ? AND status = 'ACTIVE'",
                Integer.class, userId, slot);
        return n != null && n > 0;
    }

    /** Cards of the list already bound to a growing tree. */
    public List<Long> boundCards(long userId, Collection<Long> flashcardIds) {
        if (flashcardIds.isEmpty()) return List.of();
        return jdbc.query("""
                SELECT flashcard_id FROM public.garden_knowledge_card WHERE user_id = ? AND released_at IS NULL AND flashcard_id = ANY(?)
                """, ps -> {
            ps.setLong(1, userId);
            ps.setArray(2, ps.getConnection().createArrayOf("bigint", flashcardIds.toArray()));
        }, (rs, n) -> rs.getLong(1));
    }

    /** Raises the stored peak (never lowers it) and banks the essence of the previous stage. */
    public void raisePeak(long userId, long treeId, int peak, double banked, Instant since) {
        jdbc.update("""
                UPDATE public.garden_knowledge_tree SET peak_stage = ?, essence_banked = ?, essence_since = ?
                WHERE user_id = ? AND id = ? AND status = 'ACTIVE' AND peak_stage < ?
                """, peak, BigDecimal.valueOf(banked), ts(since), userId, treeId, peak);
    }

    public boolean claimEssence(long userId, long treeId, double banked, Instant since) {
        return jdbc.update("""
                UPDATE public.garden_knowledge_tree SET essence_banked = ?, essence_since = ?
                WHERE user_id = ? AND id = ? AND status = 'ACTIVE'
                """, BigDecimal.valueOf(banked), ts(since), userId, treeId) == 1;
    }

    /** ACTIVE → GRADUATED exactly once (0 rows ⇒ already graduated or released). */
    public boolean graduate(long userId, long treeId, Instant now) {
        return jdbc.update("""
                UPDATE public.garden_knowledge_tree SET status = 'GRADUATED', graduated_at = ?
                WHERE user_id = ? AND id = ? AND status = 'ACTIVE'
                """, ts(now), userId, treeId) == 1;
    }

    public boolean release(long userId, long treeId, Instant now) {
        return jdbc.update("""
                UPDATE public.garden_knowledge_tree SET status = 'RELEASED', released_at = ?
                WHERE user_id = ? AND id = ? AND status = 'ACTIVE'
                """, ts(now), userId, treeId) == 1;
    }

    public void releaseCards(long userId, long treeId, Instant now) {
        jdbc.update("UPDATE public.garden_knowledge_card SET released_at = ? WHERE user_id = ? AND tree_id = ? AND released_at IS NULL",
                ts(now), userId, treeId);
    }

    public void recordFailedGraduation(long userId, long treeId, Instant retryAt) {
        jdbc.update("""
                UPDATE public.garden_knowledge_tree SET graduation_attempts = graduation_attempts + 1, graduation_retry_at = ?
                WHERE user_id = ? AND id = ? AND status = 'ACTIVE'
                """, ts(retryAt), userId, treeId);
    }

    // ----------------------------------------------------------------- Memory Forest

    public int forestCount(long userId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.garden_knowledge_tree WHERE user_id = ? AND status = 'GRADUATED'",
                Integer.class, userId);
        return n == null ? 0 : n;
    }

    /** Graduated trees, newest first; {@code beforeId} pages backwards (keyset on (graduated_at, id)). */
    public List<TreeRow> forest(long userId, Long beforeId, int limit) {
        if (beforeId == null) {
            return jdbc.query("""
                    SELECT * FROM public.garden_knowledge_tree WHERE user_id = ? AND status = 'GRADUATED'
                    ORDER BY graduated_at DESC, id DESC LIMIT ?
                    """, (rs, n) -> tree(rs), userId, limit);
        }
        return jdbc.query("""
                SELECT t.* FROM public.garden_knowledge_tree t
                JOIN public.garden_knowledge_tree b ON b.user_id = t.user_id AND b.id = ?
                WHERE t.user_id = ? AND t.status = 'GRADUATED' AND (t.graduated_at, t.id) < (b.graduated_at, b.id)
                ORDER BY t.graduated_at DESC, t.id DESC LIMIT ?
                """, (rs, n) -> tree(rs), beforeId, userId, limit);
    }

    /** Species counts of the whole forest (the island shows the history even when the list is paged). */
    public Map<String, Integer> forestSpecies(long userId) {
        Map<String, Integer> out = new HashMap<>();
        jdbc.query("SELECT species, count(*) FROM public.garden_knowledge_tree WHERE user_id = ? AND status = 'GRADUATED' GROUP BY species",
                (RowCallbackHandler) rs -> out.put(rs.getString(1), rs.getInt(2)), userId);
        return out;
    }

    // ----------------------------------------------------------------- planting candidates (read only)

    public List<Deck> decks(long userId) {
        return jdbc.query("""
                SELECT f.deck_id, COALESCE(vd.title, ''), count(*) FROM public.flashcards f
                LEFT JOIN public.vocab_decks vd ON vd.id = f.deck_id
                WHERE f.user_id = ? AND (f.state = 0 OR f.state IS NULL)
                GROUP BY f.deck_id, vd.title ORDER BY count(*) DESC LIMIT 30
                """, (rs, n) -> new Deck((Long) rs.getObject(1, Long.class), rs.getString(2), rs.getInt(3)), userId);
    }

    public List<Candidate> candidates(long userId, Long deckId, String search, double graceHours, int limit) {
        String q = search == null ? "" : search.trim().toLowerCase(java.util.Locale.ROOT);
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder("SELECT f.id, d.word, d.general_translation_vi, d.ipa, f.status, f.deck_id, vd.title, ")
                .append(OVERDUE).append(" AS overdue, EXISTS (SELECT 1 FROM public.garden_knowledge_card k WHERE k.user_id = f.user_id ")
                .append("AND k.flashcard_id = f.id AND k.released_at IS NULL) AS bound FROM public.flashcards f ")
                .append("JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id ")
                .append("LEFT JOIN public.vocab_decks vd ON vd.id = f.deck_id ")
                .append("WHERE f.user_id = ? AND (f.state = 0 OR f.state IS NULL) AND COALESCE(d.general_translation_vi, '') <> '' ");
        args.add(graceHours);
        args.add(userId);
        if (deckId != null) {
            sql.append("AND f.deck_id = ? ");
            args.add(deckId);
        }
        if (!q.isEmpty()) {
            sql.append("AND lower(d.word) LIKE ? ");
            args.add("%" + q.replace("%", "").replace("_", "") + "%");
        }
        sql.append("ORDER BY (f.status = 'LEARNED') DESC, (f.status = 'MASTERED') DESC, f.updated_at DESC NULLS LAST, f.id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), (rs, n) -> new Candidate(rs.getLong(1), rs.getString(2), rs.getString(3),
                rs.getString(4), rs.getString(5), (Long) rs.getObject(6, Long.class), rs.getString(7), rs.getBoolean(8),
                rs.getBoolean(9)), args.toArray());
    }

    /** The cards a player submitted for planting, read with ownership + validity (missing ids are not the player's). */
    public List<Candidate> ownedCards(long userId, Collection<Long> flashcardIds, double graceHours) {
        if (flashcardIds.isEmpty()) return List.of();
        return jdbc.query("SELECT f.id, d.word, d.general_translation_vi, d.ipa, f.status, f.deck_id, NULL, " + OVERDUE
                        + " AS overdue, FALSE FROM public.flashcards f JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id "
                        + "WHERE f.user_id = ? AND f.id = ANY(?) AND (f.state = 0 OR f.state IS NULL)",
                ps -> {
                    ps.setDouble(1, graceHours);
                    ps.setLong(2, userId);
                    ps.setArray(3, ps.getConnection().createArrayOf("bigint", flashcardIds.toArray()));
                },
                (rs, n) -> new Candidate(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5),
                        (Long) rs.getObject(6, Long.class), null, rs.getBoolean(8), false));
    }
}
