package com.englishcoach.proficiency.board;

import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Optional;

/**
 * Refresh + read of {@code mv_proficiency_rank}. The view is built only from proficiency_* state
 * tables (plus users for the admin / account-status filter); this class never reads
 * proficiency_evidence.
 */
@Repository
@RequiredArgsConstructor
public class ProficiencyBoardRepository {

    private final NamedParameterJdbcTemplate jdbc;

    public record SkillCell(String cefr, String status) {}

    public record BoardRow(String board, String division, long userId, int rating, String cefr, double confidence,
                           boolean visible, Integer rank, Integer wouldBeRank,
                           SkillCell listening, SkillCell reading, SkillCell writing, SkillCell speaking) {}

    private static final String SELECT = """
            SELECT board, division, user_id, rating, cefr, confidence, visible, rank, would_be_rank,
                   l_cefr, l_status, r_cefr, r_status, w_cefr, w_status, s_cefr, s_status
            FROM public.mv_proficiency_rank
            """;

    public void refreshView() {
        // an owner function (Flyway V94): the application role may not refresh the view itself
        jdbc.getJdbcTemplate().execute("SELECT public.refresh_mv_proficiency_rank()");
    }

    /** Visible learners of one board/division, best first. */
    public List<BoardRow> top(ProficiencyBoardType board, String division, int limit) {
        return jdbc.query(SELECT + """
                WHERE board = :board AND division = :division AND visible
                ORDER BY rank, user_id
                LIMIT :limit
                """, new MapSqlParameterSource().addValue("board", board.name()).addValue("division", division)
                .addValue("limit", limit), (rs, i) -> row(rs));
    }

    /** The learner's own row (visible or hidden); empty when not ranked on that board. */
    public Optional<BoardRow> find(ProficiencyBoardType board, long userId) {
        return jdbc.query(SELECT + """
                WHERE board = :board AND user_id = :userId
                """, new MapSqlParameterSource().addValue("board", board.name()).addValue("userId", userId),
                (rs, i) -> row(rs)).stream().findFirst();
    }

    private static BoardRow row(ResultSet rs) throws SQLException {
        int rank = rs.getInt("rank");
        Integer rankOrNull = rs.wasNull() ? null : rank;
        int wouldBe = rs.getInt("would_be_rank");
        Integer wouldBeOrNull = rs.wasNull() ? null : wouldBe;
        return new BoardRow(rs.getString("board"), rs.getString("division"), rs.getLong("user_id"),
                rs.getInt("rating"), rs.getString("cefr"), rs.getDouble("confidence"), rs.getBoolean("visible"),
                rankOrNull, wouldBeOrNull,
                new SkillCell(rs.getString("l_cefr"), rs.getString("l_status")),
                new SkillCell(rs.getString("r_cefr"), rs.getString("r_status")),
                new SkillCell(rs.getString("w_cefr"), rs.getString("w_status")),
                new SkillCell(rs.getString("s_cefr"), rs.getString("s_status")));
    }
}
