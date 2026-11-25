package com.englishcoach.grammar;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.io.IOException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

/**
 * The Grammar Academy's own tables. Every statement is scoped by {@code user_id}. The database is a network round trip away,
 * so a hot path is one statement: an attempt writes its row and its topic counters in a single CTE.
 */
@Repository
public class GrammarRepository {

    public record State(String slug, Instant firstOpenedAt, Instant lastOpenedAt, Instant studiedAt, int practiceScored, double practicePoints,
                        Integer lastCheckPct, Integer bestCheckPct, Instant lastCheckAt, Instant masteredAt, int reviewStage,
                        Instant reviewDueAt, boolean needsReview) {}

    public record Profile(String startLevel, String startBasis) {}

    public record CheckItem(String topic, int version, JsonNode exercise) {}

    public record Session(UUID id, long userId, String kind, String scope, List<String> exerciseIds, List<CheckItem> items, Instant startedAt, Instant submittedAt,
                          Integer pct, Integer scoredItems, String resultJson) {}

    public record Wrong(String misconceptions, String topic, String exerciseId, String answer, Instant at) {}

    public record NewAttempt(long userId, UUID requestId, String topic, String exerciseId, String type, int version, String mode,
                             String outcome, Double score, String answer, String tags, UUID sessionId) {}

    public record Report(long id, long userId, String topic, String exerciseId, String kind, String answer, String message, Instant createdAt) {}

    private final NamedParameterJdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public GrammarRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    /** All Grammar commands for one learner serialize inside their caller's transaction, including quota checks. */
    public void lockLearner(long userId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended('grammar:' || CAST(:u AS text), 0))", params(userId), rs -> {});
    }

    public Optional<NewAttempt> attempt(long userId, UUID requestId) {
        return jdbc.query("""
                SELECT * FROM public.grammar_attempt WHERE user_id = :u AND request_id = :r
                """, params(userId).addValue("r", requestId), (rs, i) -> new NewAttempt(userId, requestId,
                rs.getString("topic_slug"), rs.getString("exercise_id"), rs.getString("exercise_type"), rs.getInt("content_version"),
                rs.getString("mode"), rs.getString("outcome"), rs.getBigDecimal("score") == null ? null : rs.getBigDecimal("score").doubleValue(), rs.getString("answer_text"),
                rs.getString("misconceptions"), rs.getObject("session_id", UUID.class))).stream().findFirst();
    }

    public void open(long userId, String slug, int version) {
        jdbc.update("""
                INSERT INTO public.grammar_topic_state (user_id, topic_slug, content_version) VALUES (:u, :s, :v)
                ON CONFLICT (user_id, topic_slug) DO UPDATE SET last_opened_at = now(), content_version = :v
                """, params(userId).addValue("s", slug).addValue("v", version));
    }

    public void studied(long userId, String slug, int version) {
        jdbc.update("""
                INSERT INTO public.grammar_topic_state (user_id, topic_slug, content_version, studied_at) VALUES (:u, :s, :v, now())
                ON CONFLICT (user_id, topic_slug) DO UPDATE SET last_opened_at = now(), content_version = :v,
                    studied_at = COALESCE(public.grammar_topic_state.studied_at, now())
                """, params(userId).addValue("s", slug).addValue("v", version));
    }

    /** One statement, one round trip. A repeated request id writes nothing. Returns whether this was the learner's first attempt of the local day. */
    public InsertOutcome insertPractice(NewAttempt a) {
        MapSqlParameterSource p = attemptParams(a);
        return jdbc.queryForObject("""
                WITH before AS (
                    SELECT EXISTS (SELECT 1 FROM public.grammar_attempt
                        WHERE user_id = :u AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh') AS active
                ), ins AS (
                    INSERT INTO public.grammar_attempt (user_id, request_id, topic_slug, exercise_id, exercise_type, content_version, mode, outcome, score, answer_text, misconceptions, session_id)
                    VALUES (:u, :r, :t, :e, :ty, :v, :m, :o, :sc, :ans, :tags, :sid)
                    ON CONFLICT (user_id, request_id) DO NOTHING
                    RETURNING 1
                ), st AS (
                    INSERT INTO public.grammar_topic_state (user_id, topic_slug, content_version, practice_scored, practice_points)
                    SELECT :u, :t, :v, CASE WHEN CAST(:sc AS numeric) IS NULL THEN 0 ELSE 1 END, COALESCE(CAST(:sc AS numeric), 0) FROM ins
                    ON CONFLICT (user_id, topic_slug) DO UPDATE SET
                        last_opened_at = now(),
                        practice_scored = public.grammar_topic_state.practice_scored + EXCLUDED.practice_scored,
                        practice_points = public.grammar_topic_state.practice_points + EXCLUDED.practice_points
                    RETURNING 1
                )
                SELECT (SELECT count(*) FROM ins) AS inserted, (SELECT active FROM before) AS active
                """, p, (rs, i) -> new InsertOutcome(rs.getInt("inserted") > 0, !rs.getBoolean("active")));
    }

    public record InsertOutcome(boolean inserted, boolean firstToday) {}

    public void insertCheckAttempts(List<NewAttempt> attempts) {
        if (attempts.isEmpty()) return;
        jdbc.batchUpdate("""
                INSERT INTO public.grammar_attempt (user_id, request_id, topic_slug, exercise_id, exercise_type, content_version, mode, outcome, score, answer_text, misconceptions, session_id)
                VALUES (:u, :r, :t, :e, :ty, :v, :m, :o, :sc, :ans, :tags, :sid)
                """, attempts.stream().map(this::attemptParams).toArray(MapSqlParameterSource[]::new));
    }

    private MapSqlParameterSource attemptParams(NewAttempt a) {
        return params(a.userId()).addValue("r", a.requestId()).addValue("t", a.topic()).addValue("e", a.exerciseId())
                .addValue("ty", a.type()).addValue("v", a.version()).addValue("m", a.mode()).addValue("o", a.outcome())
                .addValue("sc", a.score(), java.sql.Types.NUMERIC).addValue("ans", a.answer()).addValue("tags", a.tags())
                .addValue("sid", a.sessionId());
    }

    public List<State> states(long userId) {
        return jdbc.query("""
                SELECT topic_slug, first_opened_at, last_opened_at, studied_at, practice_scored, practice_points, last_check_pct, best_check_pct,
                       last_check_at, mastered_at, review_stage, review_due_at, needs_review
                FROM public.grammar_topic_state WHERE user_id = :u
                """, params(userId), (rs, i) -> state(rs));
    }

    public Optional<State> state(long userId, String slug) {
        return jdbc.query("""
                SELECT topic_slug, first_opened_at, last_opened_at, studied_at, practice_scored, practice_points, last_check_pct, best_check_pct,
                       last_check_at, mastered_at, review_stage, review_due_at, needs_review
                FROM public.grammar_topic_state WHERE user_id = :u AND topic_slug = :s
                """, params(userId).addValue("s", slug), (rs, i) -> state(rs)).stream().findFirst();
    }

    private static State state(ResultSet rs) throws SQLException {
        return new State(rs.getString("topic_slug"), instant(rs, "first_opened_at"), instant(rs, "last_opened_at"), instant(rs, "studied_at"),
                rs.getInt("practice_scored"), rs.getDouble("practice_points"), (Integer) rs.getObject("last_check_pct"),
                (Integer) rs.getObject("best_check_pct"), instant(rs, "last_check_at"), instant(rs, "mastered_at"), rs.getInt("review_stage"),
                instant(rs, "review_due_at"), rs.getBoolean("needs_review"));
    }

    public void recordCheck(long userId, String slug, int version, int pct, boolean mastered, Integer stage, Instant dueAt, boolean needsReview) {
        jdbc.update("""
                INSERT INTO public.grammar_topic_state (user_id, topic_slug, content_version, last_check_pct, best_check_pct, last_check_at, mastered_at, review_stage, review_due_at, needs_review)
                VALUES (:u, :s, :v, :p, :p, now(), CASE WHEN :m THEN now() END, COALESCE(:st, 0), :due, :nr)
                ON CONFLICT (user_id, topic_slug) DO UPDATE SET
                    last_opened_at = now(),
                    content_version = :v,
                    last_check_pct = :p,
                    best_check_pct = GREATEST(public.grammar_topic_state.best_check_pct, :p),
                    last_check_at = now(),
                    mastered_at = CASE WHEN :m THEN COALESCE(public.grammar_topic_state.mastered_at, now()) ELSE public.grammar_topic_state.mastered_at END,
                    review_stage = COALESCE(:st, public.grammar_topic_state.review_stage),
                    review_due_at = COALESCE(:due, public.grammar_topic_state.review_due_at),
                    needs_review = :nr
                """, params(userId).addValue("s", slug).addValue("v", version).addValue("p", pct).addValue("m", mastered)
                .addValue("st", stage, java.sql.Types.INTEGER).addValue("due", dueAt == null ? null : Timestamp.from(dueAt), java.sql.Types.TIMESTAMP).addValue("nr", needsReview));
    }

    public Optional<Profile> profile(long userId) {
        return jdbc.query("SELECT start_level, start_basis FROM public.grammar_profile WHERE user_id = :u", params(userId),
                (rs, i) -> new Profile(rs.getString(1), rs.getString(2))).stream().findFirst();
    }

    public void setProfile(long userId, String level, String basis, UUID session) {
        jdbc.update("""
                INSERT INTO public.grammar_profile (user_id, start_level, start_basis, diagnostic_session) VALUES (:u, :l, :b, :d)
                ON CONFLICT (user_id) DO UPDATE SET start_level = :l, start_basis = :b, diagnostic_session = COALESCE(:d, public.grammar_profile.diagnostic_session), updated_at = now()
                """, params(userId).addValue("l", level).addValue("b", basis).addValue("d", session));
    }

    public int recentAttempts(long userId, int days) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.grammar_attempt WHERE user_id = :u AND created_at > now() - make_interval(days => :d)",
                params(userId).addValue("d", days), Integer.class);
        return n == null ? 0 : n;
    }

    public int sessionsToday(long userId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.grammar_check_session WHERE user_id = :u AND started_at > now() - interval '1 day'", params(userId), Integer.class);
        return n == null ? 0 : n;
    }

    public void createSession(UUID id, long userId, String kind, String scope, List<CheckItem> items) {
        jdbc.update("""
                INSERT INTO public.grammar_check_session (id, user_id, kind, scope, exercise_ids)
                VALUES (:id, :u, :k, :s, CAST(:ids AS jsonb))
                """, params(userId).addValue("id", id).addValue("k", kind).addValue("s", scope)
                .addValue("ids", json(Map.of("schema", 1, "items", items))));
    }

    public Optional<Session> session(UUID id, long userId, boolean lock) {
        String sql = "SELECT id, user_id, kind, scope, exercise_ids::text AS ids, started_at, submitted_at, pct, scored_items, result::text AS res "
                + "FROM public.grammar_check_session WHERE id = :id AND user_id = :u" + (lock ? " FOR UPDATE" : "");
        return jdbc.query(sql, params(userId).addValue("id", id), (rs, i) -> session(rs)).stream().findFirst();
    }

    private Session session(ResultSet rs) throws SQLException {
        List<String> ids = new ArrayList<>();
        List<CheckItem> items = new ArrayList<>();
        try {
            JsonNode stored = mapper.readTree(rs.getString("ids"));
            if (stored.isArray()) { // legacy sessions have no immutable key; only terminal results may be read
                for (JsonNode n : stored) ids.add(n.asText());
            } else if (stored.path("schema").asInt() == 1 && stored.path("items").isArray()) {
                for (JsonNode n : stored.path("items")) {
                    JsonNode ex = n.path("exercise");
                    ids.add(ex.path("id").asText());
                    items.add(new CheckItem(n.path("topic").asText(), n.path("version").asInt(), ex));
                }
            }
        } catch (IOException e) {
            throw new SQLException("grammar session ids", e);
        }
        return new Session(rs.getObject("id", UUID.class), rs.getLong("user_id"), rs.getString("kind"), rs.getString("scope"), ids, items,
                instant(rs, "started_at"), instant(rs, "submitted_at"), (Integer) rs.getObject("pct"), (Integer) rs.getObject("scored_items"), rs.getString("res"));
    }

    public void finishSession(UUID id, long userId, int pct, int scoredItems, Object result) {
        jdbc.update("""
                UPDATE public.grammar_check_session SET submitted_at = now(), pct = :p, scored_items = :n, result = CAST(:r AS jsonb)
                WHERE id = :id AND user_id = :u AND submitted_at IS NULL
                """, params(userId).addValue("id", id).addValue("p", pct).addValue("n", scoredItems).addValue("r", json(result)));
    }

    public List<Session> sessions(long userId, int limit) {
        return jdbc.query("""
                SELECT id, user_id, kind, scope, exercise_ids::text AS ids, started_at, submitted_at, pct, scored_items, NULL AS res
                FROM public.grammar_check_session WHERE user_id = :u ORDER BY started_at DESC LIMIT :n
                """, params(userId).addValue("n", limit), (rs, i) -> session(rs));
    }

    public Set<String> recentlySeen(long userId, String topic) {
        return new HashSet<>(jdbc.queryForList("""
                SELECT exercise_id FROM public.grammar_attempt
                WHERE user_id = :u AND topic_slug = :s AND mode = 'CHECK' ORDER BY created_at DESC LIMIT 12
                """, params(userId).addValue("s", topic), String.class));
    }

    public List<Wrong> recentWrong(long userId, int days, int limit) {
        return jdbc.query("""
                SELECT misconceptions, topic_slug, exercise_id, answer_text, created_at FROM public.grammar_attempt
                WHERE user_id = :u AND misconceptions IS NOT NULL AND created_at > now() - make_interval(days => :d)
                ORDER BY created_at DESC LIMIT :n
                """, params(userId).addValue("d", days).addValue("n", limit),
                (rs, i) -> new Wrong(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), instant(rs, "created_at")));
    }

    public List<String> wrongExercises(long userId, Collection<String> eligibleIds, int limit) {
        if (eligibleIds.isEmpty()) return List.of();
        return jdbc.queryForList("""
                SELECT exercise_id FROM (
                    SELECT DISTINCT ON (exercise_id) exercise_id, outcome, created_at FROM public.grammar_attempt
                    WHERE user_id = :u AND exercise_id IN (:eligible) AND created_at > now() - interval '180 days'
                    ORDER BY exercise_id, created_at DESC, id DESC) latest
                WHERE outcome IN ('WRONG', 'PARTIAL') ORDER BY created_at DESC, exercise_id LIMIT :n
                """, params(userId).addValue("eligible", eligibleIds).addValue("n", limit), String.class);
    }

    public List<String> bookmarks(long userId) {
        return jdbc.queryForList("SELECT topic_slug FROM public.grammar_bookmark WHERE user_id = :u ORDER BY created_at DESC", params(userId), String.class);
    }

    public void bookmark(long userId, String slug, boolean on) {
        jdbc.update(on ? "INSERT INTO public.grammar_bookmark (user_id, topic_slug) VALUES (:u, :s) ON CONFLICT DO NOTHING"
                : "DELETE FROM public.grammar_bookmark WHERE user_id = :u AND topic_slug = :s", params(userId).addValue("s", slug));
    }

    public int reportsToday(long userId) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.grammar_report WHERE user_id = :u AND created_at > now() - interval '1 day'", params(userId), Integer.class);
        return n == null ? 0 : n;
    }

    public void report(long userId, String topic, String exerciseId, String kind, String answer, String message) {
        jdbc.update("""
                INSERT INTO public.grammar_report (user_id, topic_slug, exercise_id, kind, answer_text, message)
                VALUES (:u, :t, :e, :k, :a, :m)
                """, params(userId).addValue("t", topic).addValue("e", exerciseId).addValue("k", kind).addValue("a", answer).addValue("m", message));
    }

    public List<Report> reports(int limit) {
        return jdbc.query("""
                SELECT id, user_id, topic_slug, exercise_id, kind, answer_text, message, created_at FROM public.grammar_report
                ORDER BY created_at DESC LIMIT :n
                """, new MapSqlParameterSource("n", limit), (rs, i) -> new Report(rs.getLong(1), rs.getLong(2), rs.getString(3), rs.getString(4),
                rs.getString(5), rs.getString(6), rs.getString(7), instant(rs, "created_at")));
    }

    private static MapSqlParameterSource params(long userId) {
        return new MapSqlParameterSource("u", userId);
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp t = rs.getTimestamp(column);
        return t == null ? null : t.toInstant();
    }

    private String json(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (IOException e) {
            throw new IllegalStateException("grammar json", e);
        }
    }
}
