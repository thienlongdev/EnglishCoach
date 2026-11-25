package com.englishcoach.background;

import com.englishcoach.background.BackgroundPreferenceDtos.BackgroundPreferencesResponse;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Optional;

/**
 * Persistence for {@code public.user_background_preferences}. Every statement is strictly scoped by {@code user_id};
 * there is no unscoped query or cross-user read/write.
 */
@Repository
public class BackgroundPreferenceRepository {

    private static final int LOCK_SPACE = 0x4267; // "Bg"

    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public BackgroundPreferenceRepository(JdbcTemplate jdbc, ObjectMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    /** Serializes writes for one learner using a transaction-scoped PostgreSQL advisory lock. */
    public void lockOwner(long userId) {
        jdbc.query("SELECT pg_advisory_xact_lock(?, ?)", rs -> null, LOCK_SPACE, (int) (userId ^ (userId >>> 32)));
    }

    public Optional<BackgroundPreferencesResponse> find(long userId) {
        return jdbc.query("""
                SELECT schema_version, revision, state, updated_at
                FROM public.user_background_preferences
                WHERE user_id = ?""",
                (rs, n) -> mapRow(rs), userId).stream().findFirst();
    }

    public BackgroundPreferencesResponse upsert(long userId, int schemaVersion, String stateJson) {
        return jdbc.queryForObject("""
                INSERT INTO public.user_background_preferences (user_id, schema_version, revision, state)
                VALUES (?, ?, 1, ?::jsonb)
                ON CONFLICT (user_id) DO UPDATE
                SET schema_version = EXCLUDED.schema_version,
                    revision = public.user_background_preferences.revision + 1,
                    state = EXCLUDED.state,
                    updated_at = now()
                RETURNING schema_version, revision, state, updated_at""",
                (rs, n) -> mapRow(rs), userId, schemaVersion, stateJson);
    }

    public boolean delete(long userId) {
        return jdbc.update("DELETE FROM public.user_background_preferences WHERE user_id = ?", userId) > 0;
    }

    private BackgroundPreferencesResponse mapRow(ResultSet rs) throws SQLException {
        return new BackgroundPreferencesResponse(
                rs.getInt("schema_version"),
                rs.getLong("revision"),
                parseJson(rs.getString("state")),
                rs.getTimestamp("updated_at").toInstant()
        );
    }

    private JsonNode parseJson(String raw) {
        try {
            return json.readTree(raw);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("user_background_preferences.state is not valid JSON", e);
        }
    }
}
