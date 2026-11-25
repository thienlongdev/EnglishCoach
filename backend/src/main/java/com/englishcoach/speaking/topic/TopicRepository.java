package com.englishcoach.speaking.topic;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Account-scoped draw history and favourites of "Nói theo chủ đề". Every statement is scoped by {@code user_id}. */
@Repository
public class TopicRepository {

    /** History window read for anti-repetition (bounded: one indexed range scan). */
    static final int HISTORY_WINDOW = 400;
    static final int FAVORITE_LIMIT = 200;
    private static final int LOCK_SPACE = 0x5370; // "Sp"

    public record Draw(long id, UUID requestId, String itemId, String style, String origin, String status,
                       Integer targetSeconds, Integer spokenSeconds, Boolean reachedTarget, boolean recorded,
                       Instant drawnAt) {}

    public record Stats(int drawn, int finished, int reachedTarget, int spokenSeconds, int distinctSpoken,
                        Instant lastPracticeAt) {}

    private final JdbcTemplate jdbc;

    public TopicRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Serialises the draws of one learner (transaction-scoped advisory lock): concurrent spins see each other. */
    public void lockOwner(long userId) {
        jdbc.query("SELECT pg_advisory_xact_lock(?, ?)", rs -> null, LOCK_SPACE, (int) (userId ^ (userId >>> 32)));
    }

    /** The learner's most recent draws, newest first. */
    public List<Draw> recent(long userId, int limit) {
        return jdbc.query("SELECT * FROM public.speaking_topic_draws WHERE user_id = ? ORDER BY drawn_at DESC, id DESC LIMIT ?",
                this::row,
                userId, limit);
    }

    public long insert(long userId, UUID requestId, String itemId, String style, String bankVersion, String origin) {
        Long id = jdbc.queryForObject("""
                INSERT INTO public.speaking_topic_draws (user_id, request_id, item_id, style, bank_version, origin)
                VALUES (?, ?, ?, ?, ?, ?) RETURNING id""", Long.class, userId, requestId, itemId, style, bankVersion, origin);
        return id == null ? 0 : id;
    }

    /** Marks a shown-but-unspoken draw as skipped (only the owner's, only while still DRAWN). */
    public void skip(long userId, long drawId) {
        jdbc.update("UPDATE public.speaking_topic_draws SET status = 'SKIPPED' WHERE id = ? AND user_id = ? AND status = 'DRAWN'",
                drawId, userId);
    }

    /** DRAWN → STARTED. Returns the draw's status after the call, or null when the learner owns no such draw. */
    public String start(long userId, long drawId, int targetSeconds) {
        List<String> rows = jdbc.queryForList("""
                WITH moved AS (
                    UPDATE public.speaking_topic_draws SET status = 'STARTED', started_at = CURRENT_TIMESTAMP, target_seconds = ?
                    WHERE id = ? AND user_id = ? AND status = 'DRAWN' RETURNING status)
                SELECT status FROM moved
                UNION ALL
                SELECT status FROM public.speaking_topic_draws WHERE id = ? AND user_id = ? AND NOT EXISTS (SELECT 1 FROM moved)""",
                String.class, targetSeconds, drawId, userId, drawId, userId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /**
     * STARTED → FINISHED. The stored speaking time is the client's measurement bounded by the server's own wall clock since
     * the start (+2 s for request latency), so a client can never record more speaking than time actually passed.
     * Returns the stored draw, or null when the learner owns no such draw.
     */
    public Draw finish(long userId, long drawId, int spokenSeconds, boolean recorded) {
        jdbc.update("""
                UPDATE public.speaking_topic_draws d SET status = 'FINISHED', finished_at = CURRENT_TIMESTAMP, recorded = ?,
                    spoken_seconds = b.spoken, reached_target = b.spoken >= d.target_seconds - 1
                FROM (SELECT LEAST(?, 1200, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at)))::int + 2)) AS spoken
                      FROM public.speaking_topic_draws WHERE id = ? AND user_id = ?) b
                WHERE d.id = ? AND d.user_id = ? AND d.status = 'STARTED'""",
                recorded, spokenSeconds, drawId, userId, drawId, userId);
        List<Draw> rows = jdbc.query("SELECT * FROM public.speaking_topic_draws WHERE id = ? AND user_id = ?",
                this::row,
                drawId, userId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    public Stats stats(long userId) {
        return jdbc.queryForObject("""
                SELECT count(*) AS drawn,
                       count(*) FILTER (WHERE status = 'FINISHED') AS finished,
                       count(*) FILTER (WHERE reached_target) AS reached,
                       COALESCE(sum(spoken_seconds), 0) AS spoken,
                       count(DISTINCT item_id) FILTER (WHERE status = 'FINISHED') AS distinct_spoken,
                       max(finished_at) AS last_at
                FROM public.speaking_topic_draws WHERE user_id = ?""",
                (rs, n) -> new Stats(rs.getInt("drawn"), rs.getInt("finished"), rs.getInt("reached"), rs.getInt("spoken"),
                        rs.getInt("distinct_spoken"),
                        rs.getTimestamp("last_at") == null ? null : rs.getTimestamp("last_at").toInstant()),
                userId);
    }

    /** Most recent rounds the learner actually started (a merely drawn or skipped topic is not practice). */
    public List<Draw> recentRounds(long userId, int limit) {
        return jdbc.query("""
                SELECT * FROM public.speaking_topic_draws WHERE user_id = ? AND status IN ('STARTED','FINISHED')
                ORDER BY drawn_at DESC, id DESC LIMIT ?""",
                this::row,
                userId, limit);
    }

    public List<String> favorites(long userId) {
        return jdbc.queryForList("SELECT item_id FROM public.speaking_topic_favorites WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
                String.class, userId, FAVORITE_LIMIT);
    }

    /** Adds a favourite unless the learner already has {@link #FAVORITE_LIMIT}. Returns false when the limit refused it. */
    public boolean addFavorite(long userId, String itemId) {
        int changed = jdbc.update("""
                INSERT INTO public.speaking_topic_favorites (user_id, item_id)
                SELECT ?, ? WHERE (SELECT count(*) FROM public.speaking_topic_favorites WHERE user_id = ?) < ?
                ON CONFLICT (user_id, item_id) DO NOTHING""", userId, itemId, userId, FAVORITE_LIMIT);
        if (changed == 1) return true;
        Integer present = jdbc.queryForObject("SELECT count(*) FROM public.speaking_topic_favorites WHERE user_id = ? AND item_id = ?",
                Integer.class, userId, itemId);
        return present != null && present > 0;
    }

    public void removeFavorite(long userId, String itemId) {
        jdbc.update("DELETE FROM public.speaking_topic_favorites WHERE user_id = ? AND item_id = ?", userId, itemId);
    }

    private Draw row(ResultSet rs, int n) throws SQLException {
        return new Draw(rs.getLong("id"), rs.getObject("request_id", UUID.class), rs.getString("item_id"),
                rs.getString("style"), rs.getString("origin"), rs.getString("status"),
                (Integer) rs.getObject("target_seconds"), (Integer) rs.getObject("spoken_seconds"),
                (Boolean) rs.getObject("reached_target"), rs.getBoolean("recorded"), rs.getTimestamp("drawn_at").toInstant());
    }
}
