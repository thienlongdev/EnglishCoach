package com.englishcoach.leaderboard.board;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;

/**
 * Năng lực board, below the ranked VERIFIED rows (Stage 3.4): PROVISIONAL / STALE learners and placement-based
 * levels of one division (no rank), plus the count of learners without a level. READ-ONLY batch queries on
 * user_proficiency / skill_proficiency / leaderboard_division_level / users; hidden learners
 * (show_on_proficiency_board = false), admins, non-ACTIVE and excluded accounts are never listed.
 */
@Repository
@RequiredArgsConstructor
public class LeaderboardOthersRepository {

    private final NamedParameterJdbcTemplate jdbc;

    public record OtherRow(long userId, String cefr, String source) {}

    /** Leading/trailing spaces matter: text blocks strip the trailing blank after the preceding "AND". */
    private static final String ELIGIBLE =
            " u.role <> 'ROLE_ADMIN' AND u.account_status = 'ACTIVE' AND NOT (u.id = ANY(CAST(:excluded AS bigint[]))) \n";

    /** PROVISIONAL / STALE learners of the division (OVERALL: overall level; skill boards: that skill). */
    public List<OtherRow> verifying(String board, String division, int limit, String excluded) {
        String sql = "OVERALL".equals(board) ? """
                SELECT up.user_id, up.current_cefr AS cefr, up.overall_status AS source
                FROM public.user_proficiency up JOIN public.users u ON u.id = up.user_id
                WHERE up.overall_status IN ('PROVISIONAL', 'STALE') AND up.current_cefr IS NOT NULL
                  AND up.show_on_proficiency_board
                  AND public.fn_leaderboard_division(public.fn_cefr_step(up.current_cefr)) = :division
                  AND """ + ELIGIBLE + """
                ORDER BY up.overall_rating DESC NULLS LAST, up.user_id
                LIMIT :limit
                """ : """
                SELECT sp.user_id, public.fn_proficiency_cefr(sp.rating) AS cefr, sp.status AS source
                FROM public.skill_proficiency sp JOIN public.users u ON u.id = sp.user_id
                LEFT JOIN public.user_proficiency up ON up.user_id = sp.user_id
                WHERE sp.skill = :board AND sp.status IN ('PROVISIONAL', 'STALE') AND sp.rating IS NOT NULL
                  AND COALESCE(up.show_on_proficiency_board, TRUE)
                  AND public.fn_leaderboard_division(public.fn_cefr_step(public.fn_proficiency_cefr(sp.rating))) = :division
                  AND """ + ELIGIBLE + """
                ORDER BY sp.rating DESC, sp.user_id
                LIMIT :limit
                """;
        return jdbc.query(sql, params(board, division, limit, excluded),
                (rs, i) -> new OtherRow(rs.getLong("user_id"), rs.getString("cefr"), rs.getString("source")));
    }

    /** Placement-based levels of the division (OVERALL board only). */
    public List<OtherRow> placement(String division, int limit, String excluded) {
        return jdbc.query("""
                SELECT dl.user_id, dl.cefr, dl.source
                FROM public.leaderboard_division_level dl JOIN public.users u ON u.id = dl.user_id
                LEFT JOIN public.user_proficiency up ON up.user_id = dl.user_id
                WHERE dl.source = 'PLACEMENT' AND dl.division = :division
                  AND COALESCE(up.show_on_proficiency_board, TRUE)
                  AND """ + ELIGIBLE + """
                ORDER BY public.fn_cefr_step(dl.cefr) DESC, dl.user_id
                LIMIT :limit
                """, params("OVERALL", division, limit, excluded),
                (rs, i) -> new OtherRow(rs.getLong("user_id"), rs.getString("cefr"), rs.getString("source")));
    }

    /** Eligible learners with no level on this board (not VERIFIED / PROVISIONAL / STALE, no placement for OVERALL). */
    public int undeterminedCount(String board, String excluded) {
        String sql = "OVERALL".equals(board) ? """
                SELECT COUNT(*) FROM public.users u
                WHERE """ + ELIGIBLE + """
                  AND NOT EXISTS (SELECT 1 FROM public.leaderboard_division_level dl WHERE dl.user_id = u.id)
                """ : """
                SELECT COUNT(*) FROM public.users u
                WHERE """ + ELIGIBLE + """
                  AND NOT EXISTS (SELECT 1 FROM public.skill_proficiency sp WHERE sp.user_id = u.id AND sp.skill = :board
                                  AND sp.status IN ('VERIFIED', 'PROVISIONAL', 'STALE'))
                """;
        Integer n = jdbc.queryForObject(sql, params(board, null, 0, excluded), Integer.class);
        return n == null ? 0 : n;
    }

    private static MapSqlParameterSource params(String board, String division, int limit, String excluded) {
        return new MapSqlParameterSource().addValue("board", board).addValue("division", division)
                .addValue("limit", limit).addValue("excluded", excluded);
    }
}
