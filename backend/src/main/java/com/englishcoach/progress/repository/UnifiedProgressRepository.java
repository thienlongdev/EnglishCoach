package com.englishcoach.progress.repository;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Date;
import java.time.LocalDate;
import java.util.*;

@Repository
@RequiredArgsConstructor
@Slf4j
public class UnifiedProgressRepository {

    private final NamedParameterJdbcTemplate jdbcTemplate;

    private static final String BASE_UNION_SQL = """
            -- 1. Speaking Roleplay: genuine learner turns
            SELECT (t.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, 1 AS act_count
            FROM speaking_turns t
            JOIN speaking_sessions s ON t.session_id = s.id
            WHERE s.user_id = :userId
              AND t.speaker = 'LEARNER'
              AND (t.is_mocked IS NULL OR t.is_mocked = false)
              AND (CAST(:startDate AS date) IS NULL OR t.created_at >= (CAST(:startDate AS date) - INTERVAL '1 day'))
              AND (CAST(:endDate AS date) IS NULL OR t.created_at < (CAST(:endDate AS date) + INTERVAL '2 days'))

            UNION ALL

            -- 2. Speaking Shadowing: valid persisted attempts
            SELECT (a.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, 1 AS act_count
            FROM speaking_shadowing_attempts a
            WHERE a.user_id = :userId
              AND (a.is_mocked IS NULL OR a.is_mocked = false)
              AND (CAST(:startDate AS date) IS NULL OR a.created_at >= (CAST(:startDate AS date) - INTERVAL '1 day'))
              AND (CAST(:endDate AS date) IS NULL OR a.created_at < (CAST(:endDate AS date) + INTERVAL '2 days'))

            UNION ALL

            -- 3. Speaking Quick Check: valid quick checks
            SELECT (q.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, 1 AS act_count
            FROM exams.speaking_quick_checks q
            WHERE q.user_id = :userId
              AND (q.is_mocked IS NULL OR q.is_mocked = false)
              AND (CAST(:startDate AS date) IS NULL OR q.created_at >= (CAST(:startDate AS date) - INTERVAL '1 day'))
              AND (CAST(:endDate AS date) IS NULL OR q.created_at < (CAST(:endDate AS date) + INTERVAL '2 days'))

            UNION ALL

            -- 4. Writing: submissions
            SELECT (w.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, 1 AS act_count
            FROM writing_submissions w
            WHERE w.user_id = :userId
              AND (CAST(:startDate AS date) IS NULL OR w.created_at >= (CAST(:startDate AS date) - INTERVAL '1 day'))
              AND (CAST(:endDate AS date) IS NULL OR w.created_at < (CAST(:endDate AS date) + INTERVAL '2 days'))

            UNION ALL

            -- 5. Translation Sentence: persisted attempts
            SELECT (t.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, 1 AS act_count
            FROM public.translation_attempts t
            WHERE t.user_id = :userId
              AND (CAST(:startDate AS date) IS NULL OR t.created_at >= (CAST(:startDate AS date) - INTERVAL '1 day'))
              AND (CAST(:endDate AS date) IS NULL OR t.created_at < (CAST(:endDate AS date) + INTERVAL '2 days'))

            UNION ALL

            -- 6. Translation Paragraph: persisted paragraph attempts
            SELECT (p.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, 1 AS act_count
            FROM public.translation_paragraph_attempts p
            WHERE p.user_id = :userId
              AND (CAST(:startDate AS date) IS NULL OR p.created_at >= (CAST(:startDate AS date) - INTERVAL '1 day'))
              AND (CAST(:endDate AS date) IS NULL OR p.created_at < (CAST(:endDate AS date) + INTERVAL '2 days'))

            UNION ALL

            -- 7. Listening: completed sessions
            SELECT (l.ended_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, 1 AS act_count
            FROM listening_sessions l
            WHERE l.user_id = :userId
              AND l.ended_at IS NOT NULL
              AND (CAST(:startDate AS date) IS NULL OR l.ended_at >= (CAST(:startDate AS date) - INTERVAL '1 day'))
              AND (CAST(:endDate AS date) IS NULL OR l.ended_at < (CAST(:endDate AS date) + INTERVAL '2 days'))

            UNION ALL

            -- 8. Reading: >=80% progress (max 1 per material per day)
            SELECT sub.act_date, 1 AS act_count
            FROM (
                SELECT DISTINCT r.reading_material_id, (r.last_read_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date
                FROM user_reading_progress r
                WHERE r.user_id = :userId
                  AND r.scroll_percentage >= 80
                  AND r.last_read_at IS NOT NULL
                  AND (CAST(:startDate AS date) IS NULL OR r.last_read_at >= (CAST(:startDate AS date) - INTERVAL '1 day'))
                  AND (CAST(:endDate AS date) IS NULL OR r.last_read_at < (CAST(:endDate AS date) + INTERVAL '2 days'))
            ) sub

            UNION ALL

            -- 9. Flashcards & Word Chain: single scan over append-only learning_activity_events
            SELECT (e.occurred_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, 1 AS act_count
            FROM public.learning_activity_events e
            WHERE e.user_id = :userId
              AND e.activity_type IN ('FLASHCARD_REVIEWED', 'WORD_CHAIN_PLAYED')
              AND (CAST(:startDate AS date) IS NULL OR e.occurred_at >= (CAST(:startDate AS date) - INTERVAL '1 day'))
              AND (CAST(:endDate AS date) IS NULL OR e.occurred_at < (CAST(:endDate AS date) + INTERVAL '2 days'))

            UNION ALL

            -- 10. Exams: completed sections
            SELECT (COALESCE(s.sealed_at, s.started_at, s.created_at)::timestamptz AT TIME ZONE :timeZone)::date AS act_date, 1 AS act_count
            FROM exams.attempt_sections s
            JOIN exams.attempts a ON s.attempt_id = a.id
            WHERE a.user_id = :userId
              AND s.state = 'COMPLETED'

            UNION ALL

            -- 10b. Fallback for unsectioned submitted exams
            SELECT (COALESCE(a.submitted_at, a.started_at, a.created_at)::timestamptz AT TIME ZONE :timeZone)::date AS act_date, 1 AS act_count
            FROM exams.attempts a
            WHERE a.user_id = :userId
              AND a.status = 'SUBMITTED'
              AND NOT EXISTS (
                  SELECT 1 FROM exams.attempt_sections s WHERE s.attempt_id = a.id AND s.state = 'COMPLETED'
              )
            """;

    /**
     * Aggregates activity counts by calendar date for a user, optionally bounded by startDate and endDate.
     */
    public Map<LocalDate, Integer> getDailyActivityCounts(Long userId, String timeZone, LocalDate startDate, LocalDate endDate) {
        if (userId == null) {
            return Collections.emptyMap();
        }

        String sql = """
                WITH daily_union AS (
                """ + BASE_UNION_SQL + """
                )
                SELECT act_date, SUM(act_count) AS total_count
                FROM daily_union
                WHERE (CAST(:startDate AS date) IS NULL OR act_date >= CAST(:startDate AS date))
                  AND (CAST(:endDate AS date) IS NULL OR act_date <= CAST(:endDate AS date))
                GROUP BY act_date
                ORDER BY act_date ASC
                """;

        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("timeZone", timeZone)
                .addValue("startDate", startDate != null ? Date.valueOf(startDate) : null, java.sql.Types.DATE)
                .addValue("endDate", endDate != null ? Date.valueOf(endDate) : null, java.sql.Types.DATE);

        Map<LocalDate, Integer> resultMap = new LinkedHashMap<>();
        jdbcTemplate.query(sql, params, rs -> {
            Date sqlDate = rs.getDate("act_date");
            if (sqlDate != null) {
                LocalDate date = sqlDate.toLocalDate();
                int count = rs.getInt("total_count");
                resultMap.put(date, count);
            }
        });

        return resultMap;
    }

    /**
     * Returns all distinct active calendar dates across the user's history in descending order.
     */
    public List<LocalDate> getActiveDates(Long userId, String timeZone) {
        if (userId == null) {
            return Collections.emptyList();
        }

        String sql = """
                WITH daily_union AS (
                """ + BASE_UNION_SQL + """
                )
                SELECT DISTINCT act_date
                FROM daily_union
                ORDER BY act_date DESC
                """;

        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("userId", userId)
                .addValue("timeZone", timeZone)
                .addValue("startDate", null, java.sql.Types.DATE)
                .addValue("endDate", null, java.sql.Types.DATE);

        return jdbcTemplate.query(sql, params, (rs, rowNum) -> {
            Date sqlDate = rs.getDate("act_date");
            return sqlDate != null ? sqlDate.toLocalDate() : null;
        }).stream().filter(Objects::nonNull).toList();
    }
}
