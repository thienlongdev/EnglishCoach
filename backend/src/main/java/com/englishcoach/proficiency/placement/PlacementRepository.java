package com.englishcoach.proficiency.placement;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Placement quiz storage (V63 + V66). proficiency_placement_issue / _attempt are append-only (DB triggers); this
 * repository only INSERTs and SELECTs. Never touches evidence, skill_proficiency or user_proficiency.
 */
@Repository
@RequiredArgsConstructor
public class PlacementRepository {

    private static final TypeReference<List<PlacementScorer.Item>> ITEMS = new TypeReference<>() {};
    private static final TypeReference<List<String>> STRINGS = new TypeReference<>() {};

    private final NamedParameterJdbcTemplate jdbc;
    private final ObjectMapper mapper = new ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    /** {@code items} of a model-1 issue parse with null prompt / options (they cannot be answered any more). */
    public record Issue(UUID id, long userId, List<PlacementScorer.Item> items, Instant expiresAt, int modelVersion) {}

    public record Attempt(long id, String status, String resultCefr, boolean lowConfidence, Instant createdAt,
                          int modelVersion) {}

    /**
     * Random active questions of one skill: {@code perLevel} per level (one query, window function). The caller
     * validates each row ({@link PlacementQuestionValidator}) — fetch a few spare rows per level for that.
     */
    public List<PlacementQuestionValidator.Question> randomQuestions(List<String> levels, String skill, int perLevel) {
        return jdbc.query("""
                SELECT id, question_key, skill, cefr, prompt, options::text AS options, answer_index FROM (
                    SELECT q.*, ROW_NUMBER() OVER (PARTITION BY q.cefr ORDER BY random()) AS rn
                    FROM public.proficiency_placement_question q
                    WHERE q.active AND q.skill = :skill AND q.cefr IN (:levels)
                ) x WHERE x.rn <= :perLevel
                """, new MapSqlParameterSource().addValue("levels", levels).addValue("skill", skill)
                .addValue("perLevel", perLevel),
                (rs, n) -> new PlacementQuestionValidator.Question(rs.getLong("id"), rs.getString("question_key"),
                        rs.getString("skill"), rs.getString("cefr"), rs.getString("prompt"),
                        parseStrings(rs.getString("options")), rs.getInt("answer_index")));
    }

    public void insertIssue(UUID id, long userId, List<PlacementScorer.Item> items, Instant createdAt, Instant expiresAt,
                            int modelVersion) {
        jdbc.update("""
                INSERT INTO public.proficiency_placement_issue (id, user_id, items, created_at, expires_at, model_version)
                VALUES (:id, :userId, CAST(:items AS jsonb), :createdAt, :expiresAt, :model)
                """, new MapSqlParameterSource().addValue("id", id).addValue("userId", userId)
                .addValue("items", json(items)).addValue("createdAt", Timestamp.from(createdAt))
                .addValue("expiresAt", Timestamp.from(expiresAt)).addValue("model", modelVersion));
    }

    public Optional<Issue> findIssue(UUID id) {
        return jdbc.query("""
                SELECT id, user_id, items::text AS items, expires_at, model_version
                FROM public.proficiency_placement_issue WHERE id = :id
                """, new MapSqlParameterSource("id", id), (rs, n) -> new Issue((UUID) rs.getObject("id"), rs.getLong("user_id"),
                        parse(rs.getString("items")), rs.getTimestamp("expires_at").toInstant(), rs.getInt("model_version")))
                .stream().findFirst();
    }

    public boolean isSubmitted(UUID issueId) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM public.proficiency_placement_attempt WHERE issue_id = :id",
                new MapSqlParameterSource("id", issueId), Integer.class);
        return n != null && n > 0;
    }

    public long insertAttempt(UUID issueId, long userId, List<PlacementScorer.Item> items, List<Integer> answers,
                              PlacementScorer.Result r, Instant createdAt, int modelVersion) {
        Long id = jdbc.queryForObject("""
                INSERT INTO public.proficiency_placement_attempt
                    (issue_id, user_id, items, answers, fa, level_rates, result_cefr, low_confidence, status, created_at,
                     model_version, details)
                VALUES (:issueId, :userId, CAST(:items AS jsonb), CAST(:answers AS jsonb), 0, CAST(:rates AS jsonb),
                        :result, :low, :status, :createdAt, :model, CAST(:details AS jsonb))
                RETURNING id
                """, new MapSqlParameterSource().addValue("issueId", issueId).addValue("userId", userId)
                .addValue("items", json(items)).addValue("answers", json(answers))
                .addValue("rates", json(r.levelRates())).addValue("result", r.resultCefr()).addValue("low", r.lowConfidence())
                .addValue("status", r.status()).addValue("createdAt", Timestamp.from(createdAt)).addValue("model", modelVersion)
                .addValue("details", json(Map.of("score", r.score(), "skills", r.skills()))), Long.class);
        return id == null ? -1 : id;
    }

    /** Latest attempt (any model, or only VALID ones; {@code modelVersion} null = any model). */
    public Optional<Attempt> latestAttempt(long userId, boolean validOnly, Integer modelVersion) {
        return jdbc.query("""
                SELECT id, status, result_cefr, low_confidence, created_at, model_version
                FROM public.proficiency_placement_attempt
                WHERE user_id = :userId AND (:validOnly = FALSE OR status = 'VALID')
                  AND (CAST(:model AS integer) IS NULL OR model_version = CAST(:model AS integer))
                ORDER BY created_at DESC, id DESC LIMIT 1
                """, new MapSqlParameterSource().addValue("userId", userId).addValue("validOnly", validOnly)
                .addValue("model", modelVersion, java.sql.Types.INTEGER),
                (rs, n) -> new Attempt(rs.getLong("id"), rs.getString("status"), rs.getString("result_cefr"),
                        rs.getBoolean("low_confidence"), rs.getTimestamp("created_at").toInstant(),
                        rs.getInt("model_version"))).stream().findFirst();
    }

    // ---- V69 autosave / resume ------------------------------------------------------------------

    /** Mutable state of one issued attempt (answers so far; status IN_PROGRESS / COMPLETED / ABANDONED). */
    public record Progress(UUID issueId, long userId, String status, List<Integer> answers, int currentIndex,
                           Instant startedAt, Instant updatedAt) {}

    /** Stored result of a submitted attempt (idempotent resubmit returns it). */
    public record StoredResult(String status, String resultCefr, boolean lowConfidence, Instant createdAt, int modelVersion,
                               Map<String, Object> details) {}

    private static final TypeReference<List<Integer>> INTS = new TypeReference<>() {};
    private static final TypeReference<Map<String, Object>> MAP = new TypeReference<>() {};

    public void insertProgress(UUID issueId, long userId, Instant now) {
        jdbc.update("""
                INSERT INTO public.proficiency_placement_progress (issue_id, user_id, status, answers, current_index, started_at, updated_at)
                VALUES (:id, :userId, 'IN_PROGRESS', '[]'::jsonb, 0, :now, :now)
                """, new MapSqlParameterSource().addValue("id", issueId).addValue("userId", userId)
                .addValue("now", Timestamp.from(now)));
    }

    public Optional<Progress> findActiveProgress(long userId) {
        return jdbc.query(PROGRESS_SELECT + " WHERE user_id = :userId AND status = 'IN_PROGRESS'",
                new MapSqlParameterSource("userId", userId), this::mapProgress).stream().findFirst();
    }

    public Optional<Progress> findProgress(UUID issueId) {
        return jdbc.query(PROGRESS_SELECT + " WHERE issue_id = :id", new MapSqlParameterSource("id", issueId), this::mapProgress)
                .stream().findFirst();
    }

    /** Saves the answers of an IN_PROGRESS attempt; returns false when it is no longer in progress. */
    public boolean saveProgress(UUID issueId, long userId, List<Integer> answers, Instant now) {
        return jdbc.update("""
                UPDATE public.proficiency_placement_progress
                SET answers = CAST(:answers AS jsonb), current_index = :idx, updated_at = :now
                WHERE issue_id = :id AND user_id = :userId AND status = 'IN_PROGRESS'
                """, new MapSqlParameterSource().addValue("id", issueId).addValue("userId", userId)
                .addValue("answers", json(answers)).addValue("idx", answers.size()).addValue("now", Timestamp.from(now))) == 1;
    }

    /** IN_PROGRESS ⇒ COMPLETED or ABANDONED (no-op otherwise). */
    public void closeProgress(UUID issueId, String status, Instant now) {
        jdbc.update("""
                UPDATE public.proficiency_placement_progress
                SET status = :status, updated_at = :now,
                    completed_at = CASE WHEN :status = 'COMPLETED' THEN :now ELSE completed_at END,
                    abandoned_at = CASE WHEN :status = 'ABANDONED' THEN :now ELSE abandoned_at END
                WHERE issue_id = :id AND status = 'IN_PROGRESS'
                """, new MapSqlParameterSource().addValue("id", issueId).addValue("status", status)
                .addValue("now", Timestamp.from(now)));
    }

    public Optional<StoredResult> findAttemptByIssue(UUID issueId) {
        return jdbc.query("""
                SELECT status, result_cefr, low_confidence, created_at, model_version, details::text AS details
                FROM public.proficiency_placement_attempt WHERE issue_id = :id
                """, new MapSqlParameterSource("id", issueId), (rs, n) -> new StoredResult(rs.getString("status"),
                        rs.getString("result_cefr"), rs.getBoolean("low_confidence"), rs.getTimestamp("created_at").toInstant(),
                        rs.getInt("model_version"), parseMap(rs.getString("details")))).stream().findFirst();
    }

    private static final String PROGRESS_SELECT = """
            SELECT issue_id, user_id, status, answers::text AS answers, current_index, started_at, updated_at
            FROM public.proficiency_placement_progress""";

    private Progress mapProgress(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new Progress((UUID) rs.getObject("issue_id"), rs.getLong("user_id"), rs.getString("status"),
                parseInts(rs.getString("answers")), rs.getInt("current_index"), rs.getTimestamp("started_at").toInstant(),
                rs.getTimestamp("updated_at").toInstant());
    }

    private List<Integer> parseInts(String s) {
        try {
            return mapper.readValue(s, INTS);
        } catch (Exception ex) {
            return new java.util.ArrayList<>();
        }
    }

    private Map<String, Object> parseMap(String s) {
        if (s == null) return Map.of();
        try {
            return mapper.readValue(s, MAP);
        } catch (Exception ex) {
            return Map.of();
        }
    }

    private String json(Object o) {
        try {
            return mapper.writeValueAsString(o);
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    private List<PlacementScorer.Item> parse(String s) {
        try {
            return mapper.readValue(s, ITEMS);
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    private List<String> parseStrings(String s) {
        try {
            return mapper.readValue(s, STRINGS);
        } catch (Exception ex) {
            return List.of();
        }
    }
}
