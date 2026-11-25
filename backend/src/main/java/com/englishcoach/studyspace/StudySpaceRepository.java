package com.englishcoach.studyspace;

import com.englishcoach.studyspace.StudySpaceDtos.Snapshot;
import com.englishcoach.studyspace.StudySpaceDtos.SnapshotDetail;
import com.englishcoach.studyspace.StudySpaceDtos.Space;
import com.englishcoach.studyspace.StudySpaceDtos.SpaceSummary;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Spaces and their snapshots. Every statement carries {@code user_id}: another learner's row is never read or written. */
@Repository
public class StudySpaceRepository {

    private static final String SUMMARY = "id, name, position, is_active, default_layout IS NOT NULL AS has_default, default_saved_at, revision, updated_at";
    private static final String FULL = "id, name, position, is_active, layout, default_layout, default_saved_at, revision, updated_at";
    private static final int LOCK_SPACE = 0x5353; // "SS"

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public StudySpaceRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Serialises one learner's space writes (transaction-scoped advisory lock): limits and the single active space hold. */
    public void lockOwner(long userId) {
        jdbc.query("SELECT pg_advisory_xact_lock(?, ?)", rs -> null, LOCK_SPACE, (int) (userId ^ (userId >>> 32)));
    }

    public List<SpaceSummary> list(long userId) {
        return jdbc.query("SELECT " + SUMMARY + " FROM public.study_spaces WHERE user_id = ? ORDER BY position, created_at",
                this::summary, userId);
    }

    public int count(long userId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.study_spaces WHERE user_id = ?", Integer.class, userId);
        return n == null ? 0 : n;
    }

    public Optional<Space> find(long userId, UUID id) {
        return jdbc.query("SELECT " + FULL + " FROM public.study_spaces WHERE id = ? AND user_id = ?", this::full, id, userId)
                .stream().findFirst();
    }

    public Optional<Space> active(long userId) {
        return jdbc.query("SELECT " + FULL + " FROM public.study_spaces WHERE user_id = ? AND is_active", this::full, userId)
                .stream().findFirst();
    }

    public void insert(long userId, UUID id, String name, int position, JsonNode layout, JsonNode defaultLayout) {
        jdbc.update("""
                INSERT INTO public.study_spaces (id, user_id, name, position, is_active, layout, default_layout, default_saved_at)
                VALUES (?, ?, ?, ?, FALSE, ?::jsonb, ?::jsonb, CASE WHEN ?::jsonb IS NULL THEN NULL ELSE now() END)""",
                id, userId, name, position, text(layout), text(defaultLayout), text(defaultLayout));
    }

    public void activate(long userId, UUID id) {
        jdbc.update("UPDATE public.study_spaces SET is_active = FALSE WHERE user_id = ? AND is_active AND id <> ?", userId, id);
        jdbc.update("UPDATE public.study_spaces SET is_active = TRUE WHERE user_id = ? AND id = ?", userId, id);
    }

    public boolean rename(long userId, UUID id, String name) {
        return jdbc.update("UPDATE public.study_spaces SET name = ?, updated_at = now() WHERE id = ? AND user_id = ?", name, id, userId) == 1;
    }

    /** Replaces the current layout; with an expected revision only when it still matches. Returns the new revision, or -1. */
    public long saveLayout(long userId, UUID id, JsonNode layout, Long expectedRevision) {
        List<Long> r = jdbc.query("""
                UPDATE public.study_spaces SET layout = ?::jsonb, revision = revision + 1, updated_at = now()
                WHERE id = ? AND user_id = ? AND (?::bigint IS NULL OR revision = ?::bigint) RETURNING revision""",
                (rs, n) -> rs.getLong(1), text(layout), id, userId, expectedRevision, expectedRevision);
        return r.isEmpty() ? -1 : r.get(0);
    }

    public boolean saveDefault(long userId, UUID id, JsonNode layout) {
        return jdbc.update("""
                UPDATE public.study_spaces SET default_layout = ?::jsonb, default_saved_at = now(), updated_at = now()
                WHERE id = ? AND user_id = ?""", text(layout), id, userId) == 1;
    }

    public void delete(long userId, UUID id) {
        jdbc.update("DELETE FROM public.study_space_snapshots WHERE space_id = ? AND user_id = ?", id, userId);
        jdbc.update("DELETE FROM public.study_spaces WHERE id = ? AND user_id = ?", id, userId);
    }

    public int nextPosition(long userId) {
        Integer n = jdbc.queryForObject("SELECT coalesce(max(position) + 1, 0) FROM public.study_spaces WHERE user_id = ?", Integer.class, userId);
        return n == null ? 0 : n;
    }

    // ── Snapshots ───────────────────────────────────────────────────────────────────────────────────────────
    public void insertSnapshot(long userId, UUID spaceId, String kind, String label, JsonNode layout) {
        jdbc.update("""
                INSERT INTO public.study_space_snapshots (id, space_id, user_id, kind, label, layout)
                VALUES (?, ?, ?, ?, ?, ?::jsonb)""", UUID.randomUUID(), spaceId, userId, kind, label, text(layout));
    }

    /** A label with this mark is a room the learner saved by name: rolling versions never push it out. */
    static final String NAMED_ROOM = "★ ";

    /** Keeps the newest {@code keep} version snapshots of a space; rooms saved by name are not versions. */
    public void pruneSnapshots(long userId, UUID spaceId, int keep) {
        jdbc.update("""
                DELETE FROM public.study_space_snapshots WHERE user_id = ? AND space_id = ? AND (label IS NULL OR label NOT LIKE ?) AND id NOT IN (
                  SELECT id FROM public.study_space_snapshots WHERE user_id = ? AND space_id = ? AND (label IS NULL OR label NOT LIKE ?) ORDER BY created_at DESC LIMIT ?)""",
                userId, spaceId, NAMED_ROOM + "%", userId, spaceId, NAMED_ROOM + "%", keep);
    }

    public int countNamedRooms(long userId, UUID spaceId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.study_space_snapshots WHERE user_id = ? AND space_id = ? AND label LIKE ?", Integer.class, userId, spaceId, NAMED_ROOM + "%");
        return n == null ? 0 : n;
    }

    public int deleteSnapshot(long userId, UUID spaceId, UUID id) {
        return jdbc.update("DELETE FROM public.study_space_snapshots WHERE user_id = ? AND space_id = ? AND id = ?", userId, spaceId, id);
    }

    public List<Snapshot> snapshots(long userId, UUID spaceId) {
        return jdbc.query("""
                SELECT id, kind, label, created_at FROM public.study_space_snapshots
                WHERE user_id = ? AND space_id = ? ORDER BY created_at DESC""",
                (rs, n) -> new Snapshot(rs.getObject("id", UUID.class), rs.getString("kind"), rs.getString("label"),
                        rs.getTimestamp("created_at").toInstant()), userId, spaceId);
    }

    public Optional<SnapshotDetail> snapshot(long userId, UUID spaceId, UUID id) {
        return jdbc.query("""
                SELECT id, kind, label, created_at, layout FROM public.study_space_snapshots
                WHERE id = ? AND space_id = ? AND user_id = ?""",
                (rs, n) -> new SnapshotDetail(rs.getObject("id", UUID.class), rs.getString("kind"), rs.getString("label"),
                        rs.getTimestamp("created_at").toInstant(), node(rs.getString("layout"))), id, spaceId, userId)
                .stream().findFirst();
    }

    // ── Mapping ─────────────────────────────────────────────────────────────────────────────────────────────
    private SpaceSummary summary(ResultSet rs, int n) throws SQLException {
        Timestamp d = rs.getTimestamp("default_saved_at");
        return new SpaceSummary(rs.getObject("id", UUID.class), rs.getString("name"), rs.getInt("position"),
                rs.getBoolean("is_active"), rs.getBoolean("has_default"), d == null ? null : d.toInstant(),
                rs.getLong("revision"), rs.getTimestamp("updated_at").toInstant());
    }

    private Space full(ResultSet rs, int n) throws SQLException {
        Timestamp d = rs.getTimestamp("default_saved_at");
        return new Space(rs.getObject("id", UUID.class), rs.getString("name"), rs.getInt("position"),
                rs.getBoolean("is_active"), node(rs.getString("layout")), node(rs.getString("default_layout")),
                d == null ? null : d.toInstant(), rs.getLong("revision"), rs.getTimestamp("updated_at").toInstant());
    }

    String text(JsonNode node) {
        if (node == null || node.isNull()) return null;
        try {
            return json.writeValueAsString(node);
        } catch (JsonProcessingException e) {
            throw new StudySpaceException(400, "INVALID_LAYOUT");
        }
    }

    JsonNode node(String text) {
        if (text == null) return null;
        try {
            return json.readTree(text);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("stored study-space JSON is unreadable", e);
        }
    }
}
