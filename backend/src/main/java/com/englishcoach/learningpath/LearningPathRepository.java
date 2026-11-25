package com.englishcoach.learningpath;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.*;

/** The Learning Path's own tables. Every statement is scoped by {@code user_id}. */
@Repository
public class LearningPathRepository {

    private static final int LOCK_SPACE = 0x4C50; // "LP"
    private static final TypeReference<Map<String, Double>> FOCUS = new TypeReference<>() {};

    public record Plan(long userId, String goal, int dailyMinutes, String target, String level, String levelBasis,
                       int stage, Map<String, Double> focus, Instant focusUpdatedAt, int version) {}

    public record Task(long id, LocalDate day, int position, int planVersion, String kind, String skill, Long targetId,
                       String targetKey, String title, int minutes, int goalCount, String reasonCode, String status,
                       Long carriedFrom, Instant assignedAt, Instant completedAt, int progressCount, String evidenceRef,
                       Integer resultPct, String targetRef) {}

    public record NewTask(LocalDate day, int position, int planVersion, String kind, String skill, Long targetId,
                          String targetKey, String title, int minutes, int goalCount, String reasonCode, Long carriedFrom,
                          Instant assignedAt, String targetRef) {}

    public record Revision(long id, int baseVersion, String status, Instant dnaGeneratedAt, Map<String, Double> focus,
                           String changesJson, Instant createdAt, Instant expiresAt) {}

    /** DONE task counts; {@code bySkill} = since the plan began, per skill name (participation only). */
    public record DoneStats(int total, int distinctSkills30d, int last7d, int last30d, Map<String, Integer> bySkill) {
        public DoneStats(int total, int distinctSkills30d, int last7d, int last30d) {
            this(total, distinctSkills30d, last7d, last30d, Map.of());
        }
    }

    private final NamedParameterJdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public LearningPathRepository(NamedParameterJdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    /** Serialises one learner's plan work (transaction-scoped): two tabs never generate the same day twice. */
    public void lock(long userId) {
        jdbc.query("SELECT pg_advisory_xact_lock(:space, :key)",
                new MapSqlParameterSource("space", LOCK_SPACE).addValue("key", (int) (userId ^ (userId >>> 32))), rs -> null);
    }

    public Optional<Plan> plan(long userId) {
        return jdbc.query("SELECT * FROM public.learning_path_plan WHERE user_id = :u", p(userId), this::planRow).stream().findFirst();
    }

    /** Creates the plan or changes its goal / time; bumps the version. */
    public void savePlan(long userId, String goal, int minutes, String target, String level, String basis) {
        jdbc.update("""
                INSERT INTO public.learning_path_plan (user_id, goal, daily_minutes, target, start_cefr, start_basis)
                VALUES (:u, :goal, :minutes, :target, :level, :basis)
                ON CONFLICT (user_id) DO UPDATE SET goal = EXCLUDED.goal, daily_minutes = EXCLUDED.daily_minutes,
                    target = EXCLUDED.target, start_cefr = EXCLUDED.start_cefr, start_basis = EXCLUDED.start_basis,
                    stage = CASE WHEN public.learning_path_plan.goal = EXCLUDED.goal THEN public.learning_path_plan.stage ELSE 1 END,
                    stage_reached_at = CASE WHEN public.learning_path_plan.goal = EXCLUDED.goal
                        THEN public.learning_path_plan.stage_reached_at ELSE now() END,
                    version = public.learning_path_plan.version + 1, updated_at = now()""",
                p(userId).addValue("goal", goal).addValue("minutes", minutes).addValue("target", target)
                        .addValue("level", level).addValue("basis", basis));
    }

    public void updateLevel(long userId, String level, String basis) {
        jdbc.update("""
                UPDATE public.learning_path_plan SET start_cefr = :level, start_basis = :basis, updated_at = now()
                WHERE user_id = :u AND (start_cefr <> :level OR start_basis <> :basis)""",
                p(userId).addValue("level", level).addValue("basis", basis));
    }

    /** Stage only moves up. */
    public void raiseStage(long userId, int stage) {
        jdbc.update("""
                UPDATE public.learning_path_plan SET stage = :stage, stage_reached_at = now(), updated_at = now()
                WHERE user_id = :u AND stage < :stage""", p(userId).addValue("stage", stage));
    }

    /** Applies a revision's focus only on the version it was proposed for. */
    public boolean applyFocus(long userId, int expectedVersion, Map<String, Double> focus) {
        return jdbc.update("""
                UPDATE public.learning_path_plan SET focus = CAST(:focus AS jsonb), focus_updated_at = now(),
                    version = version + 1, updated_at = now()
                WHERE user_id = :u AND version = :version""",
                p(userId).addValue("focus", json(focus)).addValue("version", expectedVersion)) == 1;
    }

    // ── tasks ────────────────────────────────────────────────────────────────────────────────────
    public List<Task> tasksOn(long userId, LocalDate day) {
        return jdbc.query("""
                SELECT * FROM public.learning_path_task WHERE user_id = :u AND plan_day = :day ORDER BY position""",
                p(userId).addValue("day", Date.valueOf(day)), this::taskRow);
    }

    /** Open tasks of earlier days (normally only the last plan day has any). */
    public List<Task> openBefore(long userId, LocalDate day) {
        return jdbc.query("""
                SELECT * FROM public.learning_path_task WHERE user_id = :u AND plan_day < :day AND status = 'OPEN'
                ORDER BY plan_day DESC, position LIMIT 40""", p(userId).addValue("day", Date.valueOf(day)), this::taskRow);
    }

    /** Skills of the most recent earlier plan day (rotation). */
    public Set<String> skillsOfPreviousDay(long userId, LocalDate day) {
        return new HashSet<>(jdbc.queryForList("""
                SELECT skill FROM public.learning_path_task WHERE user_id = :u
                  AND plan_day = (SELECT max(plan_day) FROM public.learning_path_task WHERE user_id = :u AND plan_day < :day)
                  AND status IN ('OPEN','DONE','CARRIED')""", p(userId).addValue("day", Date.valueOf(day)), String.class));
    }

    /** Latest day a task of these kinds was given (cadence of the weekly exam / placement offers). */
    public Map<String, LocalDate> lastTaskDays(long userId, Collection<String> kinds) {
        Map<String, LocalDate> out = new HashMap<>();
        jdbc.query("""
                SELECT kind, max(plan_day) AS day FROM public.learning_path_task WHERE user_id = :u AND kind IN (:kinds)
                  AND status <> 'REPLACED' GROUP BY kind""", p(userId).addValue("kinds", kinds),
                rs -> { out.put(rs.getString("kind"), rs.getDate("day").toLocalDate()); });
        return out;
    }

    /** Writing task keys given in the last {@code days} plan days (variety: the same prompt is not repeated soon). */
    public Set<String> recentWritingKeys(long userId, LocalDate day, int days) {
        return new HashSet<>(jdbc.queryForList("""
                SELECT DISTINCT target_key FROM public.learning_path_task WHERE user_id = :u AND kind = 'WRITING'
                  AND target_key IS NOT NULL AND plan_day >= :from AND plan_day < :day AND status <> 'REPLACED'""",
                p(userId).addValue("from", Date.valueOf(day.minusDays(days))).addValue("day", Date.valueOf(day)), String.class));
    }

    /**
     * Skill coverage of the last {@code days} plan days before {@code day}: the skills that had a task (not replaced) and
     * the number of plan days. Bounded by the (user_id, plan_day) index.
     */
    public record Coverage(Set<String> skills, int planDays) {}

    public Coverage coverage(long userId, LocalDate day, int days) {
        Set<String> skills = new HashSet<>();
        int[] planDays = {0};
        jdbc.query("""
                WITH t AS (SELECT skill, plan_day FROM public.learning_path_task
                           WHERE user_id = :u AND plan_day >= :from AND plan_day < :day AND status IN ('OPEN','DONE','CARRIED'))
                SELECT DISTINCT skill, (SELECT count(DISTINCT plan_day) FROM t) AS days FROM t""",
                p(userId).addValue("from", Date.valueOf(day.minusDays(days))).addValue("day", Date.valueOf(day)),
                rs -> { skills.add(rs.getString("skill")); planDays[0] = rs.getInt("days"); });
        return new Coverage(skills, planDays[0]);
    }

    public int nextPosition(long userId, LocalDate day) {
        Integer max = jdbc.queryForObject("""
                SELECT COALESCE(max(position), 0) FROM public.learning_path_task WHERE user_id = :u AND plan_day = :day""",
                p(userId).addValue("day", Date.valueOf(day)), Integer.class);
        return (max == null ? 0 : max) + 1;
    }

    public void insert(long userId, List<NewTask> tasks) {
        if (tasks.isEmpty()) return;
        MapSqlParameterSource[] batch = tasks.stream().map(t -> p(userId)
                .addValue("day", Date.valueOf(t.day())).addValue("position", t.position()).addValue("version", t.planVersion())
                .addValue("kind", t.kind()).addValue("skill", t.skill()).addValue("targetId", t.targetId())
                .addValue("targetKey", t.targetKey()).addValue("title", trim(t.title(), 200)).addValue("minutes", t.minutes())
                .addValue("goal", t.goalCount()).addValue("reason", t.reasonCode()).addValue("carried", t.carriedFrom())
                .addValue("assigned", Timestamp.from(t.assignedAt())).addValue("targetRef", t.targetRef()))
                .toArray(MapSqlParameterSource[]::new);
        jdbc.batchUpdate("""
                INSERT INTO public.learning_path_task (user_id, plan_day, position, plan_version, kind, skill, target_id,
                    target_key, title, minutes, goal_count, reason_code, carried_from, assigned_at, target_ref)
                VALUES (:u, :day, :position, :version, :kind, :skill, :targetId, :targetKey, :title, :minutes, :goal,
                    :reason, :carried, :assigned, :targetRef)
                ON CONFLICT (user_id, plan_day, position) DO NOTHING""", batch);
    }

    /** OPEN → DONE with its evidence; a piece of evidence already linked to another task of the kind is refused. */
    public boolean complete(long userId, long taskId, String evidenceRef, int progress, Integer resultPct) {
        return jdbc.update("""
                UPDATE public.learning_path_task SET status = 'DONE', completed_at = now(), evidence_ref = :ref,
                    progress_count = :progress, result_pct = :pct
                WHERE id = :id AND user_id = :u AND status = 'OPEN'
                  AND NOT EXISTS (SELECT 1 FROM public.learning_path_task o WHERE o.user_id = :u
                      AND o.kind = public.learning_path_task.kind AND o.evidence_ref = :ref)""",
                p(userId).addValue("id", taskId).addValue("ref", evidenceRef).addValue("progress", Math.min(progress, 1000))
                        .addValue("pct", resultPct)) == 1;
    }

    public void progress(long userId, long taskId, int progress) {
        jdbc.update("""
                UPDATE public.learning_path_task SET progress_count = :progress
                WHERE id = :id AND user_id = :u AND status = 'OPEN' AND progress_count <> :progress""",
                p(userId).addValue("id", taskId).addValue("progress", Math.min(progress, 1000)));
    }

    /** OPEN tasks → CARRIED / DROPPED / REPLACED. Never touches a DONE task. */
    public void close(long userId, Collection<Long> ids, String status) {
        if (ids.isEmpty()) return;
        jdbc.update("UPDATE public.learning_path_task SET status = :status WHERE user_id = :u AND id IN (:ids) AND status = 'OPEN'",
                p(userId).addValue("ids", ids).addValue("status", status));
    }

    public DoneStats doneStats(long userId, LocalDate today) {
        return jdbc.queryForObject("""
                SELECT count(*) AS total,
                       count(DISTINCT skill) FILTER (WHERE plan_day > :d30) AS skills30,
                       count(*) FILTER (WHERE plan_day > :d7) AS last7,
                       count(*) FILTER (WHERE plan_day > :d30) AS last30,
                       count(*) FILTER (WHERE skill = 'WRITING') AS writing,
                       count(*) FILTER (WHERE skill = 'READING') AS reading
                FROM public.learning_path_task WHERE user_id = :u AND status = 'DONE'""",
                p(userId).addValue("d7", Date.valueOf(today.minusDays(7))).addValue("d30", Date.valueOf(today.minusDays(30))),
                (rs, i) -> new DoneStats(rs.getInt("total"), rs.getInt("skills30"), rs.getInt("last7"), rs.getInt("last30"),
                        Map.of("WRITING", rs.getInt("writing"), "READING", rs.getInt("reading"))));
    }

    // ── Learner DNA revisions ────────────────────────────────────────────────────────────────────
    public int revisionsSince(long userId, Instant since) {
        Integer n = jdbc.queryForObject("SELECT count(*) FROM public.learning_path_revision WHERE user_id = :u AND created_at >= :since",
                p(userId).addValue("since", Timestamp.from(since)), Integer.class);
        return n == null ? 0 : n;
    }

    public Optional<Revision> latestOpenRevision(long userId) {
        return jdbc.query("""
                SELECT * FROM public.learning_path_revision WHERE user_id = :u AND status = 'PROPOSED'
                ORDER BY created_at DESC, id DESC LIMIT 1""", p(userId), this::revisionRow).stream().findFirst();
    }

    public Optional<Revision> revision(long userId, long id) {
        return jdbc.query("SELECT * FROM public.learning_path_revision WHERE user_id = :u AND id = :id",
                p(userId).addValue("id", id), this::revisionRow).stream().findFirst();
    }

    public long insertRevision(long userId, int baseVersion, Instant dnaAt, Map<String, Double> focus, String changesJson,
                               Instant expiresAt) {
        // older open proposals are superseded; finished non-applied proposals are kept 30 days (retention)
        jdbc.update("""
                UPDATE public.learning_path_revision SET status = 'SUPERSEDED', decided_at = now()
                WHERE user_id = :u AND status = 'PROPOSED'""", p(userId));
        jdbc.update("""
                DELETE FROM public.learning_path_revision WHERE user_id = :u AND status <> 'APPLIED'
                  AND created_at < now() - interval '30 days'""", p(userId));
        Long id = jdbc.queryForObject("""
                INSERT INTO public.learning_path_revision (user_id, base_version, dna_generated_at, focus, changes, expires_at)
                VALUES (:u, :base, :dnaAt, CAST(:focus AS jsonb), CAST(:changes AS jsonb), :expires) RETURNING id""",
                p(userId).addValue("base", baseVersion).addValue("dnaAt", Timestamp.from(dnaAt)).addValue("focus", json(focus))
                        .addValue("changes", changesJson).addValue("expires", Timestamp.from(expiresAt)), Long.class);
        return id == null ? 0 : id;
    }

    public boolean decide(long userId, long id, String status) {
        return jdbc.update("""
                UPDATE public.learning_path_revision SET status = :status, decided_at = now()
                WHERE user_id = :u AND id = :id AND status = 'PROPOSED'""",
                p(userId).addValue("id", id).addValue("status", status)) == 1;
    }

    // ── mapping ──────────────────────────────────────────────────────────────────────────────────
    private Plan planRow(ResultSet rs, int i) throws SQLException {
        return new Plan(rs.getLong("user_id"), rs.getString("goal"), rs.getInt("daily_minutes"), rs.getString("target"),
                rs.getString("start_cefr"), rs.getString("start_basis"), rs.getInt("stage"), focus(rs.getString("focus")),
                instant(rs, "focus_updated_at"), rs.getInt("version"));
    }

    private Task taskRow(ResultSet rs, int i) throws SQLException {
        long target = rs.getLong("target_id");
        Long targetId = rs.wasNull() ? null : target;
        long carried = rs.getLong("carried_from");
        Long carriedFrom = rs.wasNull() ? null : carried;
        int pct = rs.getInt("result_pct");
        Integer resultPct = rs.wasNull() ? null : pct;
        return new Task(rs.getLong("id"), rs.getDate("plan_day").toLocalDate(), rs.getInt("position"), rs.getInt("plan_version"),
                rs.getString("kind"), rs.getString("skill"), targetId, rs.getString("target_key"), rs.getString("title"),
                rs.getInt("minutes"), rs.getInt("goal_count"), rs.getString("reason_code"), rs.getString("status"), carriedFrom,
                instant(rs, "assigned_at"), instant(rs, "completed_at"), rs.getInt("progress_count"), rs.getString("evidence_ref"),
                resultPct, rs.getString("target_ref"));
    }

    private Revision revisionRow(ResultSet rs, int i) throws SQLException {
        return new Revision(rs.getLong("id"), rs.getInt("base_version"), rs.getString("status"), instant(rs, "dna_generated_at"),
                focus(rs.getString("focus")), rs.getString("changes"), instant(rs, "created_at"), instant(rs, "expires_at"));
    }

    private Map<String, Double> focus(String json) {
        try {
            Map<String, Double> raw = json == null ? Map.of() : mapper.readValue(json, FOCUS);
            Map<String, Double> clean = new TreeMap<>();
            for (LearningPathEngine.Skill s : LearningPathEngine.Skill.values()) {
                Double v = raw.get(s.name());
                if (v != null && Double.isFinite(v)) clean.put(s.name(), Math.max(-0.2, Math.min(0.2, v)));
            }
            return clean;
        } catch (Exception e) {
            return Map.of();
        }
    }

    private String json(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (Exception e) {
            return "{}";
        }
    }

    static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime t = rs.getObject(column, OffsetDateTime.class);
        return t == null ? null : t.toInstant();
    }

    static MapSqlParameterSource p(long userId) {
        return new MapSqlParameterSource("u", userId);
    }

    private static String trim(String s, int max) {
        if (s == null) return "";
        String t = s.strip();
        return t.length() <= max ? t : t.substring(0, max);
    }
}
