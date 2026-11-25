package com.englishcoach.proficiency;

import com.englishcoach.proficiency.model.OverallStatus;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import com.englishcoach.proficiency.model.ProficiencySkill;
import com.englishcoach.proficiency.model.SkillStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Derived proficiency state: {@code skill_proficiency}, {@code user_proficiency},
 * {@code proficiency_snapshot}.
 * <ul>
 *   <li>{@link #upsertSkillFromCalculation} is the only statement writing skill_proficiency.rating,
 *       and it takes a {@link SkillRatingCalculator.Result} (never an evidence observed_rating).</li>
 *   <li>Refresh methods (nightly) write ONLY weight_sum/confidence/status (skill) and
 *       overall_confidence/overall_status (user).</li>
 * </ul>
 */
@Repository
@RequiredArgsConstructor
public class ProficiencyStateRepository {

    private final NamedParameterJdbcTemplate jdbc;

    public record StoredSkill(ProficiencySkill skill, Integer rating, double weightSum, double sd, double confidence,
                              SkillStatus status, int evidenceCount, Instant lastEvidenceAt, Instant ratingReachedAt,
                              boolean everVerified) {}

    public record StoredUser(long userId, Integer overallRating, ProficiencyCefr currentCefr, double overallConfidence,
                             OverallStatus overallStatus, Integer peakRating, ProficiencyCefr peakCefr,
                             Instant peakReachedAt, boolean everVerified, boolean showOnProficiencyBoard,
                             Instant updatedAt) {}

    public Map<ProficiencySkill, StoredSkill> findSkills(long userId) {
        Map<ProficiencySkill, StoredSkill> out = new EnumMap<>(ProficiencySkill.class);
        jdbc.query("SELECT * FROM public.skill_proficiency WHERE user_id = :userId",
                new MapSqlParameterSource("userId", userId), rs -> {
                    ProficiencySkill skill = ProficiencySkill.valueOf(rs.getString("skill"));
                    int rating = rs.getInt("rating");
                    Integer ratingOrNull = rs.wasNull() ? null : rating;
                    out.put(skill, new StoredSkill(skill, ratingOrNull, rs.getDouble("weight_sum"), rs.getDouble("sd"),
                            rs.getDouble("confidence"), SkillStatus.valueOf(rs.getString("status")),
                            rs.getInt("evidence_count"), instant(rs.getTimestamp("last_evidence_at")),
                            instant(rs.getTimestamp("rating_reached_at")), rs.getBoolean("ever_verified")));
                });
        return out;
    }

    /** Full write after new evidence. rating comes ONLY from the calculator result. */
    public void upsertSkillFromCalculation(long userId, SkillRatingCalculator.Result r, Instant ratingReachedAt, Instant now) {
        jdbc.update("""
                INSERT INTO public.skill_proficiency
                    (user_id, skill, rating, weight_sum, sd, confidence, status, evidence_count, last_evidence_at,
                     rating_reached_at, ever_verified, updated_at)
                VALUES (:userId, :skill, :rating, :w, :sd, :conf, :status, :count, :last, :reached, :ever, :now)
                ON CONFLICT (user_id, skill) DO UPDATE SET
                    rating = EXCLUDED.rating, weight_sum = EXCLUDED.weight_sum, sd = EXCLUDED.sd,
                    confidence = EXCLUDED.confidence, status = EXCLUDED.status,
                    evidence_count = EXCLUDED.evidence_count, last_evidence_at = EXCLUDED.last_evidence_at,
                    rating_reached_at = EXCLUDED.rating_reached_at, ever_verified = EXCLUDED.ever_verified,
                    updated_at = EXCLUDED.updated_at
                """, new MapSqlParameterSource()
                .addValue("userId", userId).addValue("skill", r.skill().name()).addValue("rating", r.rating())
                .addValue("w", r.weightSum()).addValue("sd", r.sd()).addValue("conf", r.confidence())
                .addValue("status", r.status().name()).addValue("count", r.evidenceCount())
                .addValue("last", ts(r.lastEvidenceAt())).addValue("reached", ts(ratingReachedAt))
                .addValue("ever", r.everVerified()).addValue("now", ts(now)));
    }

    /** Nightly: weight_sum, confidence, status only (rating/sd untouched). */
    public void refreshSkill(long userId, ProficiencySkill skill, double weightSum, double confidence,
                             SkillStatus status, Instant now) {
        jdbc.update("""
                UPDATE public.skill_proficiency
                SET weight_sum = :w, confidence = :conf, status = :status, updated_at = :now
                WHERE user_id = :userId AND skill = :skill
                """, new MapSqlParameterSource()
                .addValue("w", weightSum).addValue("conf", confidence).addValue("status", status.name())
                .addValue("now", ts(now)).addValue("userId", userId).addValue("skill", skill.name()));
    }

    public Optional<StoredUser> findUser(long userId) {
        List<StoredUser> rows = jdbc.query("SELECT * FROM public.user_proficiency WHERE user_id = :userId",
                new MapSqlParameterSource("userId", userId), (rs, i) -> {
                    int overall = rs.getInt("overall_rating");
                    Integer overallOrNull = rs.wasNull() ? null : overall;
                    int peak = rs.getInt("peak_rating");
                    Integer peakOrNull = rs.wasNull() ? null : peak;
                    return new StoredUser(rs.getLong("user_id"), overallOrNull, cefr(rs.getString("current_cefr")),
                            rs.getDouble("overall_confidence"), OverallStatus.valueOf(rs.getString("overall_status")),
                            peakOrNull, cefr(rs.getString("peak_cefr")), instant(rs.getTimestamp("peak_reached_at")),
                            rs.getBoolean("ever_verified"), rs.getBoolean("show_on_proficiency_board"),
                            instant(rs.getTimestamp("updated_at")));
                });
        return rows.stream().findFirst();
    }

    /** Full write after new evidence (show_on_proficiency_board is preserved). */
    public void upsertUserFromCalculation(long userId, OverallCalculator.Result r, Instant now) {
        jdbc.update("""
                INSERT INTO public.user_proficiency
                    (user_id, overall_rating, current_cefr, overall_confidence, overall_status, peak_rating,
                     peak_cefr, peak_reached_at, ever_verified, updated_at)
                VALUES (:userId, :rating, :cefr, :conf, :status, :peak, :peakCefr, :peakAt, :ever, :now)
                ON CONFLICT (user_id) DO UPDATE SET
                    overall_rating = EXCLUDED.overall_rating, current_cefr = EXCLUDED.current_cefr,
                    overall_confidence = EXCLUDED.overall_confidence, overall_status = EXCLUDED.overall_status,
                    peak_rating = EXCLUDED.peak_rating, peak_cefr = EXCLUDED.peak_cefr,
                    peak_reached_at = EXCLUDED.peak_reached_at, ever_verified = EXCLUDED.ever_verified,
                    updated_at = EXCLUDED.updated_at
                """, new MapSqlParameterSource()
                .addValue("userId", userId).addValue("rating", r.overallRating())
                .addValue("cefr", r.currentCefr() == null ? null : r.currentCefr().name())
                .addValue("conf", r.overallConfidence()).addValue("status", r.status().name())
                .addValue("peak", r.peakRating()).addValue("peakCefr", r.peakCefr() == null ? null : r.peakCefr().name())
                .addValue("peakAt", ts(r.peakReachedAt())).addValue("ever", r.everVerified()).addValue("now", ts(now)));
    }

    /** Nightly: overall_confidence and overall_status only. */
    public void refreshUser(long userId, double overallConfidence, OverallStatus status, Instant now) {
        jdbc.update("""
                UPDATE public.user_proficiency
                SET overall_confidence = :conf, overall_status = :status, updated_at = :now
                WHERE user_id = :userId
                """, new MapSqlParameterSource()
                .addValue("conf", overallConfidence).addValue("status", status.name())
                .addValue("now", ts(now)).addValue("userId", userId));
    }

    public void setVisibility(long userId, boolean show, Instant now) {
        jdbc.update("""
                INSERT INTO public.user_proficiency (user_id, show_on_proficiency_board, updated_at)
                VALUES (:userId, :show, :now)
                ON CONFLICT (user_id) DO UPDATE SET show_on_proficiency_board = EXCLUDED.show_on_proficiency_board,
                    updated_at = EXCLUDED.updated_at
                """, new MapSqlParameterSource().addValue("userId", userId).addValue("show", show).addValue("now", ts(now)));
    }

    public void upsertSnapshot(long userId, LocalDate date, Integer overallRating, ProficiencyCefr cefr,
                               double overallConfidence, OverallStatus status, String skillsJson) {
        jdbc.update("""
                INSERT INTO public.proficiency_snapshot
                    (user_id, snapshot_date, overall_rating, current_cefr, overall_confidence, overall_status, skills)
                VALUES (:userId, :date, :rating, :cefr, :conf, :status, CAST(:skills AS jsonb))
                ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
                    overall_rating = EXCLUDED.overall_rating, current_cefr = EXCLUDED.current_cefr,
                    overall_confidence = EXCLUDED.overall_confidence, overall_status = EXCLUDED.overall_status,
                    skills = EXCLUDED.skills
                """, new MapSqlParameterSource()
                .addValue("userId", userId).addValue("date", date).addValue("rating", overallRating)
                .addValue("cefr", cefr == null ? null : cefr.name()).addValue("conf", overallConfidence)
                .addValue("status", status.name()).addValue("skills", skillsJson));
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }

    private static ProficiencyCefr cefr(String s) {
        return s == null ? null : ProficiencyCefr.valueOf(s);
    }
}
