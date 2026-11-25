package com.englishcoach.learningpath;

import com.englishcoach.learningpath.LearningPathEngine.Skill;
import com.englishcoach.learningpath.LearningPathEngine.SkillSums;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

/**
 * READ-ONLY view of the learning modules' own server-persisted rows. Nothing a client claims is read: every source is a
 * row written by the module's server path (scored dictation attempts, flashcard review log, finished topic rounds,
 * writing submissions, reading progress, submitted exam attempts, valid placement attempts). Every statement is scoped by
 * the learner's id; SYSTEM content is {@code is_system = true AND owner_user_id IS NULL}.
 */
@Repository
public class LearningEvidenceReader {

    /**
     * Proficiency Engine state of one skill: rating 0–1000, status, confidence 0–1 (never written by the Learning Path).
     */
    public record SkillLevel(String skill, int rating, String status, double confidence) {}

    public record Context(String currentCefr, String overallStatus, String placementCefr, boolean placementValid,
                          int dueCards, int activeCards, boolean examSubmitted30d, boolean proficiencyVerified,
                          Map<String, SkillLevel> skillLevels) {
        public Context(String currentCefr, String overallStatus, String placementCefr, boolean placementValid, int dueCards,
                       int activeCards, boolean examSubmitted30d, boolean proficiencyVerified) {
            this(currentCefr, overallStatus, placementCefr, placementValid, dueCards, activeCards, examSubmitted30d,
                    proficiencyVerified, Map.of());
        }
    }

    public record ContentItem(String kind, long id, String title, String cefr, int size) {}

    /** What the server can prove about one task since its day began. */
    public record Evidence(long taskId, int count, String ref, Integer resultPct) {}

    private final NamedParameterJdbcTemplate jdbc;

    public LearningEvidenceReader(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** One exchange: level evidence, due cards, recent goal assessment. */
    public Context context(long userId) {
        return jdbc.queryForObject("""
                SELECT (SELECT current_cefr FROM public.user_proficiency WHERE user_id = :u) AS current_cefr,
                       (SELECT overall_status FROM public.user_proficiency WHERE user_id = :u) AS overall_status,
                       (SELECT result_cefr FROM public.proficiency_placement_attempt
                         WHERE user_id = :u AND status = 'VALID' ORDER BY created_at DESC LIMIT 1) AS placement_cefr,
                       (SELECT count(*) FROM public.flashcards f WHERE f.user_id = :u AND COALESCE(f.state, 0) = 0
                          AND f.status <> 'MASTERED' AND (f.next_review_date IS NULL OR f.next_review_date <= LOCALTIMESTAMP)) AS due,
                       (SELECT count(*) FROM public.flashcards f WHERE f.user_id = :u AND COALESCE(f.state, 0) = 0) AS cards,
                       EXISTS (SELECT 1 FROM exams.attempts a WHERE a.user_id = :u AND a.status = 'SUBMITTED'
                          AND a.attempt_mode = 'EXAM_SIMULATION' AND a.submitted_at >= now() - interval '30 days') AS exam30,
                       EXISTS (SELECT 1 FROM public.user_proficiency WHERE user_id = :u AND overall_status = 'VERIFIED') AS verified,
                       (SELECT string_agg(sp.skill || ':' || sp.rating || ':' || sp.status || ':' || sp.confidence, ',')
                          FROM public.skill_proficiency sp WHERE sp.user_id = :u
                           AND sp.skill IN ('LISTENING','READING','SPEAKING','WRITING')) AS skills""",
                new MapSqlParameterSource("u", userId), (rs, i) -> {
                    String placement = rs.getString("placement_cefr");
                    return new Context(rs.getString("current_cefr"), rs.getString("overall_status"), placement, placement != null,
                            rs.getInt("due"), rs.getInt("cards"), rs.getBoolean("exam30"), rs.getBoolean("verified"),
                            skillLevels(rs.getString("skills")));
                });
    }

    static Map<String, SkillLevel> skillLevels(String packed) {
        if (packed == null || packed.isBlank()) return Map.of();
        Map<String, SkillLevel> out = new HashMap<>();
        for (String part : packed.split(",")) {
            String[] f = part.split(":");
            if (f.length != 4) continue;
            try {
                out.put(f[0], new SkillLevel(f[0], Integer.parseInt(f[1]), f[2], Double.parseDouble(f[3])));
            } catch (NumberFormatException ignored) {
                // a malformed row gives no level (never a default one)
            }
        }
        return out;
    }

    /**
     * Weighted practice sums per skill over the last 120 days, one exchange. Weight = reliability × 0.5^(age/21 days).
     * Repeated items count once (latest attempt per dictation segment, per flashcard, per topic item, per writing session),
     * so repeating the same exercise cannot inflate an estimate.
     * <ul>
     *   <li>LISTENING — server-scored dictation accuracy (reliability 1.0; 0.5 on material below the plan's content
     *       level, so easy wins do not inflate the estimate).</li>
     *   <li>VOCABULARY — the card's last recall rating, read from the interval the scheduler set (good / easy ⇒ 1,
     *       hard ⇒ 0, unrated default ⇒ 0.5; reliability 0.8).</li>
     *   <li>WRITING — rubric score of the latest READY assessment per session / practice (AI rubric, reliability 0.5).</li>
     *   <li>SPEAKING — finished topic round reached its target length (participation quality only, reliability 0.4).</li>
     *   <li>READING — no server-scored outcome exists; only the last server-recorded completion day (weight 0).</li>
     * </ul>
     */
    public Map<Skill, SkillSums> skillSums(long userId) {
        Map<Skill, SkillSums> out = new EnumMap<>(Skill.class);
        for (Skill s : Skill.values()) out.put(s, SkillSums.none(s));
        jdbc.query("""
                WITH lv(cefr, step) AS (VALUES ('A1',0),('A2',1),('B1',2),('B2',3),('C1',4),('C2',5)),
                me AS (
                    SELECT lv.step FROM public.learning_path_plan pl JOIN lv ON lv.cefr = pl.start_cefr WHERE pl.user_id = :u
                ), lis AS (
                    SELECT DISTINCT ON (ea.listening_exercise_id)
                           LEAST(1.0, GREATEST(0.0, COALESCE(ea.accuracy_percentage,
                               CASE WHEN ea.is_correct THEN 100 ELSE 0 END) / 100.0)) AS s,
                           s.started_at::timestamptz AS at,
                           -- material below the learner's content level says less about them: half weight
                           CASE WHEN ml.step < (SELECT step FROM me) THEN 0.5 ELSE 1.0 END AS dw
                    FROM public.listening_sessions s JOIN public.exercise_attempts ea ON ea.listening_session_id = s.id
                    LEFT JOIN public.listening_materials m ON m.id = s.listening_material_id
                    LEFT JOIN lv ml ON ml.cefr = upper(m.cefr_level)
                    WHERE s.user_id = :u AND s.started_at >= LOCALTIMESTAMP - interval '120 days'
                    ORDER BY ea.listening_exercise_id, ea.id DESC
                ), voc AS (
                    SELECT CASE WHEN f.status = 'MASTERED' OR f.next_review_date > f.updated_at + interval '1 day' THEN 1.0
                                WHEN f.next_review_date <= f.updated_at THEN 0.0 ELSE 0.5 END AS s,
                           f.updated_at::timestamptz AS at
                    FROM public.flashcards f
                    WHERE f.user_id = :u AND COALESCE(f.state, 0) = 0 AND f.review_count > 0
                      AND f.updated_at >= LOCALTIMESTAMP - interval '120 days'
                    ORDER BY f.updated_at DESC LIMIT 500
                ), wri AS (
                    SELECT DISTINCT ON (COALESCE(w.session_id, w.practice_id, w.id))
                           LEAST(1.0, GREATEST(0.0, a.overall_score / 100.0)) AS s, a.completed_at AS at
                    FROM public.writing_submissions w JOIN public.writing_assessments a ON a.submission_id = w.id
                    WHERE w.user_id = :u AND a.status = 'READY' AND a.overall_score IS NOT NULL
                      AND a.completed_at >= now() - interval '120 days'
                    ORDER BY COALESCE(w.session_id, w.practice_id, w.id), a.completed_at DESC
                ), spk AS (
                    SELECT DISTINCT ON (d.item_id) CASE WHEN d.reached_target THEN 1.0 ELSE 0.0 END AS s, d.finished_at AS at
                    FROM public.speaking_topic_draws d
                    WHERE d.user_id = :u AND d.status = 'FINISHED' AND d.finished_at >= now() - interval '120 days'
                    ORDER BY d.item_id, d.finished_at DESC
                ), rea AS (
                    SELECT 0.0 AS s, max(p.completed_at) AS at
                    FROM public.user_reading_progress p WHERE p.user_id = :u AND p.completed_at IS NOT NULL
                ), exm AS (
                    -- server-scored exam practice parts the path assigned and linked (one per attempt; accuracy of the
                    -- objective items, weight grows with the number of answered items, at most three observations)
                    SELECT t.skill, t.result_pct / 100.0 AS s, t.completed_at AS at,
                           0.8 * LEAST(3.0, t.progress_count / 5.0) AS r
                    FROM public.learning_path_task t
                    WHERE t.user_id = :u AND t.kind = 'EXAM_PRACTICE' AND t.status = 'DONE' AND t.result_pct IS NOT NULL
                      AND t.skill IN ('LISTENING','READING') AND t.completed_at >= now() - interval '120 days'
                ), obs AS (
                    SELECT 'LISTENING' AS skill, s, at, 1.0 * dw AS r FROM lis
                    UNION ALL SELECT 'VOCABULARY', s, at, 0.8 FROM voc
                    UNION ALL SELECT 'WRITING', s, at, 0.5 FROM wri
                    UNION ALL SELECT 'SPEAKING', s, at, 0.4 FROM spk
                    UNION ALL SELECT 'READING', s, at, 0.0 FROM rea WHERE at IS NOT NULL
                    UNION ALL SELECT skill, s, at, r FROM exm
                ), w AS (
                    SELECT skill, s, at, r * power(0.5, GREATEST(0, extract(epoch FROM now() - at)) / 86400.0 / 21.0) AS w
                    FROM obs WHERE at IS NOT NULL
                )
                SELECT skill, COALESCE(sum(w * s), 0) AS ws, COALESCE(sum(w), 0) AS wsum,
                       count(*) FILTER (WHERE w > 0) AS n,
                       floor(extract(epoch FROM now() - max(at)) / 86400.0)::int AS days
                FROM w GROUP BY skill""", new MapSqlParameterSource("u", userId), rs -> {
            Skill skill = Skill.valueOf(rs.getString("skill"));
            int days = rs.getInt("days");
            out.put(skill, new SkillSums(skill, rs.getDouble("ws"), rs.getDouble("wsum"), rs.getInt("n"),
                    rs.wasNull() ? null : Math.max(0, days)));
        });
        return out;
    }

    /**
     * Real SYSTEM content the learner has not done recently and that the path has not given them in the last 21 days:
     * dictation materials (with their number of dictation segments) and reading texts (with their word count). Only the
     * three CEFR steps of each kind's {@link LearningPathEngine.Band} are eligible, in that order of preference (never
     * content two steps away from the learner's level); ties broken by a per-learner-per-day hash (variety, stable for
     * the day). One exchange.
     */
    public List<ContentItem> content(long userId, LearningPathEngine.Band listening, LearningPathEngine.Band reading,
                                     long seed, int maxReadingWords) {
        MapSqlParameterSource params = new MapSqlParameterSource("u", userId).addValue("seed", seed)
                .addValue("maxWords", maxReadingWords)
                .addValue("d0", listening.first()).addValue("d1", listening.second()).addValue("d2", listening.third())
                .addValue("r0", reading.first()).addValue("r1", reading.second()).addValue("r2", reading.third());
        return jdbc.query("""
                WITH lv(cefr, step) AS (VALUES ('A1',0),('A2',1),('B1',2),('B2',3),('C1',4),('C2',5))
                (SELECT 'DICTATION' AS kind, m.id, m.title, m.cefr_level AS cefr, count(e.id)::int AS size
                 FROM public.listening_materials m
                 JOIN lv ON lv.cefr = upper(m.cefr_level)
                 JOIN public.listening_exercises e ON e.listening_material_id = m.id AND e.exercise_type = 'DICTATION'
                 WHERE m.is_system = true AND m.owner_user_id IS NULL AND lv.step IN (:d0, :d1, :d2)
                   AND NOT EXISTS (SELECT 1 FROM public.listening_sessions s WHERE s.user_id = :u
                        AND s.listening_material_id = m.id AND s.started_at >= LOCALTIMESTAMP - interval '30 days')
                   AND NOT EXISTS (SELECT 1 FROM public.learning_path_task t WHERE t.user_id = :u AND t.kind = 'DICTATION'
                        AND t.target_id = m.id AND t.plan_day >= CURRENT_DATE - 21)
                 GROUP BY m.id, m.title, m.cefr_level, lv.step
                 HAVING count(e.id) >= 3
                 ORDER BY CASE lv.step WHEN :d0 THEN 0 WHEN :d1 THEN 1 ELSE 2 END, md5(m.id::text || ':' || :seed) LIMIT 3)
                UNION ALL
                (SELECT 'READING', r.id, r.title, r.difficulty_level, r.word_count
                 FROM public.reading_materials r
                 JOIN lv ON lv.cefr = upper(r.difficulty_level)
                 WHERE r.is_system = true AND r.owner_user_id IS NULL AND r.word_count BETWEEN 60 AND :maxWords
                   AND lv.step IN (:r0, :r1, :r2)
                   AND NOT EXISTS (SELECT 1 FROM public.user_reading_progress p WHERE p.user_id = :u
                        AND p.reading_material_id = r.id AND p.completed_at IS NOT NULL)
                   AND NOT EXISTS (SELECT 1 FROM public.learning_path_task t WHERE t.user_id = :u AND t.kind = 'READING'
                        AND t.target_id = r.id AND t.plan_day >= CURRENT_DATE - 21)
                 ORDER BY CASE lv.step WHEN :r0 THEN 0 WHEN :r1 THEN 1 ELSE 2 END, md5(r.id::text || ':' || :seed) LIMIT 3)""", params,
                (rs, i) -> new ContentItem(rs.getString("kind"), rs.getLong("id"), rs.getString("title"), rs.getString("cefr"),
                        rs.getInt("size")));
    }

    /**
     * Targets that still exist, as "KIND:id": SYSTEM dictation / reading materials and exam form versions (a carried or
     * open task must still lead somewhere real).
     */
    public Set<String> existingTargets(Collection<LearningPathRepository.Task> tasks) {
        List<Long> dictation = new ArrayList<>(), reading = new ArrayList<>();
        List<UUID> forms = new ArrayList<>();
        for (LearningPathRepository.Task t : tasks) {
            if ("EXAM_PRACTICE".equals(t.kind()) && examForm(t.targetRef()) != null) forms.add(examForm(t.targetRef()));
            if (t.targetId() == null) continue;
            if ("DICTATION".equals(t.kind())) dictation.add(t.targetId());
            if ("READING".equals(t.kind())) reading.add(t.targetId());
        }
        if (dictation.isEmpty() && reading.isEmpty() && forms.isEmpty()) return Set.of();
        dictation.add(-1L);
        reading.add(-1L);
        forms.add(new UUID(0, 0));
        return new HashSet<>(jdbc.queryForList("""
                SELECT 'DICTATION:' || id FROM public.listening_materials WHERE id IN (:d) AND is_system = true AND owner_user_id IS NULL
                UNION ALL
                SELECT 'READING:' || id FROM public.reading_materials WHERE id IN (:r) AND is_system = true AND owner_user_id IS NULL
                UNION ALL
                SELECT 'EXAM_PRACTICE:' || id FROM exams.form_versions WHERE id IN (:f)""",
                new MapSqlParameterSource("d", dictation).addValue("r", reading).addValue("f", forms), String.class));
    }

    /** Form version id of an exam-practice target "<uuid>/<SCOPE>", or null. */
    static UUID examForm(String targetRef) {
        if (targetRef == null || targetRef.indexOf('/') != 36) return null;
        try {
            return UUID.fromString(targetRef.substring(0, 36));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    static String examScope(String targetRef) {
        return examForm(targetRef) == null ? null : targetRef.substring(37);
    }

    /** Exam practice parts (form id + scope code) the learner already practised in the last 180 days. */
    public Set<String> practisedExamParts(long userId) {
        return new HashSet<>(jdbc.queryForList("""
                SELECT a.form_id || '/' || (a.client_session_meta ->> 'practiceScopeCode') FROM exams.attempts a
                WHERE a.user_id = :u AND a.attempt_mode = 'PRACTICE' AND a.created_at >= now() - interval '180 days'
                  AND a.client_session_meta ->> 'practiceScopeCode' IS NOT NULL""", new MapSqlParameterSource("u", userId), String.class));
    }

    /**
     * Evaluates open tasks against server rows written since {@code since} (the start of the task's plan day), in one
     * exchange. Evidence already linked to another task of the same kind is never offered again.
     */
    public List<Evidence> evaluate(long userId, List<LearningPathRepository.Task> open, Map<Long, Instant> since) {
        if (open.isEmpty()) return List.of();
        StringBuilder sql = new StringBuilder();
        MapSqlParameterSource params = new MapSqlParameterSource("u", userId);
        int i = 0;
        for (LearningPathRepository.Task t : open) {
            String part = branch(t.kind());
            if (part == null) continue;
            LearningPathEngine.WritingTask writing = "WRITING".equals(t.kind()) && t.targetKey() != null
                    ? LearningPathEngine.WRITING_TASKS.get(t.targetKey()) : null;
            if ("WRITING".equals(t.kind()) && writing == null) continue; // an old task without a real Writing task
            UUID form = examForm(t.targetRef());
            if ("EXAM_PRACTICE".equals(t.kind()) && form == null) continue; // an old task without an exact part
            String n = "t" + i++;
            params.addValue(n + "id", t.id()).addValue(n + "since", Timestamp.from(since.get(t.id())))
                    .addValue(n + "target", t.targetId()).addValue(n + "key", t.targetKey())
                    .addValue(n + "task", writing == null ? null : writing.taskId())
                    .addValue(n + "minw", writing == null ? 0 : writing.minWords())
                    .addValue(n + "form", form).addValue(n + "scope", examScope(t.targetRef()));
            if (!sql.isEmpty()) sql.append("\nUNION ALL\n");
            sql.append("SELECT CAST(:").append(n).append("id AS bigint) AS task_id, q.cnt, q.ref, q.pct FROM (")
                    .append(part.replace(":since", ":" + n + "since").replace(":target", ":" + n + "target")
                            .replace(":key", ":" + n + "key").replace(":task", ":" + n + "task").replace(":minw", ":" + n + "minw")
                            .replace(":form", ":" + n + "form").replace(":scope", ":" + n + "scope")
                            .replace(":kind", "'" + t.kind() + "'"))
                    .append(") q");
        }
        if (sql.isEmpty()) return List.of();
        return jdbc.query(sql.toString(), params, (rs, row) -> {
            int pct = rs.getInt("pct");
            Integer resultPct = rs.wasNull() ? null : Math.max(0, Math.min(100, pct));
            return new Evidence(rs.getLong("task_id"), rs.getInt("cnt"), rs.getString("ref"), resultPct);
        });
    }

    /** Exam practice attempts of one assigned part looked at per task (newest first); bounded scoring work per visit. */
    static final int EXAM_CANDIDATES = 5;

    private static final String NOT_USED =
            " NOT EXISTS (SELECT 1 FROM public.learning_path_task u WHERE u.user_id = :u AND u.kind = :kind AND u.evidence_ref = %s)";

    /** Per-kind evidence query; columns cnt (progress), ref (evidence id of the latest contributing row), pct. */
    private static String branch(String kind) {
        return switch (kind) {
            case "PLACEMENT" -> """
                    SELECT count(*)::int AS cnt, 'pl:' || max(a.id) AS ref, NULL::int AS pct
                    FROM public.proficiency_placement_attempt a
                    WHERE a.user_id = :u AND a.status = 'VALID' AND a.created_at >= :since AND""" + NOT_USED.formatted("'pl:' || a.id");
            case "VOCAB_REVIEW" -> """
                    SELECT count(*)::int AS cnt, 'rv:' || max(e.id) AS ref, NULL::int AS pct
                    FROM public.learning_activity_events e
                    WHERE e.user_id = :u AND e.activity_type = 'FLASHCARD_REVIEWED' AND e.occurred_at >= :since AND"""
                    + NOT_USED.formatted("'rv:' || e.id");
            case "DICTATION" -> """
                    SELECT count(DISTINCT ea.listening_exercise_id)::int AS cnt, 'da:' || max(ea.id) AS ref,
                           round(avg(LEAST(100, GREATEST(0, COALESCE(ea.accuracy_percentage,
                               CASE WHEN ea.is_correct THEN 100 ELSE 0 END)))))::int AS pct
                    FROM public.listening_sessions s JOIN public.exercise_attempts ea ON ea.listening_session_id = s.id
                    WHERE s.user_id = :u AND s.listening_material_id = :target AND s.started_at::timestamptz >= :since AND"""
                    + NOT_USED.formatted("'da:' || ea.id");
            case "READING" -> """
                    SELECT count(*)::int AS cnt, max('rc:' || p.id) AS ref, NULL::int AS pct
                    FROM public.user_reading_progress p
                    WHERE p.user_id = :u AND p.reading_material_id = :target AND p.completed_at >= :since AND"""
                    + NOT_USED.formatted("'rc:' || p.id");
            case "TOPIC_SPEAKING" -> """
                    SELECT count(*)::int AS cnt, 'tr:' || max(d.id) AS ref,
                           round(100.0 * avg(CASE WHEN d.reached_target THEN 1 ELSE 0 END))::int AS pct
                    FROM public.speaking_topic_draws d
                    WHERE d.user_id = :u AND d.status = 'FINISHED' AND d.spoken_seconds >= 20 AND d.finished_at >= :since AND"""
                    + NOT_USED.formatted("'tr:' || d.id");
            // the task's own Writing Coach prompt: a free practice submission (server-checked text, no AI), or a
            // submitted Writing Coach draft of a session of that prompt with at least the task's minimum words
            case "WRITING" -> """
                    SELECT count(*)::int AS cnt, max(x.ref) AS ref, NULL::int AS pct FROM (
                        SELECT 'wp:' || p.id AS ref FROM public.writing_practice_submission p
                        WHERE p.user_id = :u AND p.task_id = :task AND p.word_count >= :minw AND p.created_at >= :since AND"""
                    + NOT_USED.formatted("'wp:' || p.id") + """

                        UNION ALL
                        SELECT 'ws:' || w.id FROM public.writing_submissions w
                        JOIN public.writing_sessions ws ON ws.id = w.session_id AND ws.user_id = :u
                        WHERE w.user_id = :u AND ws.task_id = :task AND w.kind = 'COACH_DRAFT' AND w.word_count >= :minw
                          AND w.created_at >= :since AND""" + NOT_USED.formatted("'ws:' || w.id") + """
                    ) x""";
            // the exact form part the path assigned: a SUBMITTED practice attempt of that form version whose server-side
            // scope is that part, with at least one real answer. ref = up to EXAM_CANDIDATES attempts, newest first,
            // comma-separated: the service scores them and picks the evidence (LearningPathEngine#examEvidence), so a later
            // low-information submit never hides an earlier complete one
            case "EXAM_PRACTICE" -> """
                    SELECT count(*)::int AS cnt,
                           array_to_string((array_agg('ex:' || a.id::text ORDER BY a.submitted_at DESC, a.created_at DESC))[1 : %d], ',') AS ref, -- spaced slice: a colon before a digit reads as a named parameter
                           NULL::int AS pct""".formatted(EXAM_CANDIDATES) + """

                    FROM exams.attempts a
                    WHERE a.user_id = :u AND a.form_id = :form AND a.attempt_mode = 'PRACTICE' AND a.status = 'SUBMITTED'
                      AND a.client_session_meta ->> 'practiceScopeCode' = :scope AND a.submitted_at >= :since
                      AND EXISTS (SELECT 1 FROM exams.responses r WHERE r.attempt_id = a.id
                          AND ((r.answer_payload IS NOT NULL AND r.answer_payload <> 'null'::jsonb)
                               OR btrim(COALESCE(r.text_response, '')) <> '' OR r.recording_id IS NOT NULL)) AND"""
                    + NOT_USED.formatted("'ex:' || a.id::text");
            default -> null;
        };
    }
}
