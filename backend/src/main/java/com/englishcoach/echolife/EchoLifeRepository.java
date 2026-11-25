package com.englishcoach.echolife;

import com.englishcoach.echolife.EchoLifeDtos.World;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.HashSet;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/** The world rows. Every statement carries {@code user_id}: another learner's world is never read or written. */
@Repository
public class EchoLifeRepository {

    private static final int LOCK_WORLD = 0x454c; // "EL"

    record Loaded(World world, Set<UUID> ownSpaces) {}
    record Saved(long revision, Instant updatedAt) {}

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public EchoLifeRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Serialises one learner's world writes (transaction-scoped advisory lock): the revision check and the write are one step. */
    public void lockOwner(long userId) {
        jdbc.query("SELECT pg_advisory_xact_lock(?, ?)", rs -> null, LOCK_WORLD, (int) (userId ^ (userId >>> 32)));
    }

    public Optional<World> find(long userId) {
        return jdbc.query("SELECT save_version, revision, state, updated_at FROM public.echo_life_worlds WHERE user_id = ?",
                (rs, n) -> new World(rs.getInt("save_version"), rs.getLong("revision"), parse(rs.getString("state")),
                        rs.getTimestamp("updated_at").toInstant()), userId).stream().findFirst();
    }

    /** Single round-trip read of the learner's world row (if any) and their own study space ids. */
    public Loaded findWithSpaces(long userId) {
        return jdbc.query("""
                SELECT (SELECT array_agg(id) FROM public.study_spaces WHERE user_id = ?) AS own_spaces,
                       w.save_version, w.revision, w.state, w.updated_at
                FROM (SELECT 1) AS _one
                LEFT JOIN public.echo_life_worlds w ON w.user_id = ?""",
                (rs, n) -> mapLoaded(rs), userId, userId).get(0);
    }

    /** Row-locking single round-trip read for existing worlds (steady-state saves avoid separate advisory lock + find). */
    public Optional<Loaded> findForUpdateWithSpaces(long userId) {
        return jdbc.query("""
                SELECT (SELECT array_agg(id) FROM public.study_spaces WHERE user_id = ?) AS own_spaces,
                       w.save_version, w.revision, w.state, w.updated_at
                FROM public.echo_life_worlds w
                WHERE w.user_id = ?
                FOR UPDATE""",
                (rs, n) -> mapLoaded(rs), userId, userId).stream().findFirst();
    }

    private Loaded mapLoaded(ResultSet rs) throws SQLException {
        Set<UUID> spaces = readUuids(rs.getArray("own_spaces"));
        String rawState = rs.getString("state");
        World world = rawState == null ? null : new World(
                rs.getInt("save_version"),
                rs.getLong("revision"),
                parse(rawState),
                rs.getTimestamp("updated_at").toInstant());
        return new Loaded(world, spaces);
    }

    private static Set<UUID> readUuids(Array sqlArray) throws SQLException {
        Set<UUID> out = new HashSet<>();
        if (sqlArray == null) return out;
        Object raw = sqlArray.getArray();
        if (raw instanceof Object[] arr) {
            for (Object item : arr) {
                if (item instanceof UUID u) out.add(u);
                else if (item != null) out.add(UUID.fromString(item.toString()));
            }
        }
        return out;
    }

    /** The learner's own study spaces: the only space ids a world document may name. */
    public Set<UUID> ownSpaces(long userId) {
        return new HashSet<>(jdbc.query("SELECT id FROM public.study_spaces WHERE user_id = ?", (rs, n) -> rs.getObject(1, UUID.class), userId));
    }

    public Saved insertReturning(long userId, int saveVersion, JsonNode state) {
        return jdbc.queryForObject("""
                INSERT INTO public.echo_life_worlds (user_id, save_version, revision, state) VALUES (?, ?, 1, ?::jsonb)
                RETURNING revision, updated_at""",
                (rs, n) -> new Saved(rs.getLong(1), rs.getTimestamp(2).toInstant()),
                userId, saveVersion, text(state));
    }

    public long insert(long userId, int saveVersion, JsonNode state) {
        return insertReturning(userId, saveVersion, state).revision();
    }

    /** Replaces the document when the stored revision still matches; returns the new revision + timestamp, or empty. */
    public Optional<Saved> updateReturning(long userId, int saveVersion, JsonNode state, long expectedRevision) {
        return jdbc.query("""
                UPDATE public.echo_life_worlds SET state = ?::jsonb, save_version = ?, revision = revision + 1, updated_at = now()
                WHERE user_id = ? AND revision = ? RETURNING revision, updated_at""",
                (rs, n) -> new Saved(rs.getLong(1), rs.getTimestamp(2).toInstant()),
                text(state), saveVersion, userId, expectedRevision).stream().findFirst();
    }

    /** Replaces the document when the stored revision still matches; returns the new revision, or -1. */
    public long update(long userId, int saveVersion, JsonNode state, long expectedRevision) {
        return updateReturning(userId, saveVersion, state, expectedRevision).map(Saved::revision).orElse(-1L);
    }

    private JsonNode parse(String raw) {
        try {
            return json.readTree(raw);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("echo_life_worlds.state is not JSON", e);
        }
    }

    private String text(JsonNode node) {
        try {
            return json.writeValueAsString(node);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
