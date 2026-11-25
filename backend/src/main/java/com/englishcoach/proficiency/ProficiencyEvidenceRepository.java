package com.englishcoach.proficiency;

import com.englishcoach.proficiency.model.EvidenceKind;
import com.englishcoach.proficiency.model.EvidenceRow;
import com.englishcoach.proficiency.model.EvidenceSource;
import com.englishcoach.proficiency.model.EvidenceTier;
import com.englishcoach.proficiency.model.ProficiencyCefr;
import com.englishcoach.proficiency.model.ProficiencySkill;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;

/**
 * Append-only evidence ledger ({@code public.proficiency_evidence}): INSERT and SELECT only.
 * No update/delete method exists (the V53 trigger rejects both as well).
 */
@Repository
@RequiredArgsConstructor
public class ProficiencyEvidenceRepository {

    private final NamedParameterJdbcTemplate jdbc;

    private static final RowMapper<EvidenceRow> ROW_MAPPER = (rs, i) -> new EvidenceRow(
            rs.getLong("id"),
            rs.getLong("user_id"),
            ProficiencySkill.valueOf(rs.getString("skill")),
            EvidenceTier.valueOf(rs.getString("tier")),
            EvidenceKind.valueOf(rs.getString("kind")),
            EvidenceSource.valueOf(rs.getString("source_module")),
            rs.getString("source_ref"),
            rs.getString("material_key"),
            rs.getBigDecimal("raw_score"),
            rs.getString("content_cefr") == null ? null : ProficiencyCefr.valueOf(rs.getString("content_cefr")),
            rs.getBigDecimal("quality"),
            rs.getInt("observed_rating"),
            rs.getDouble("tier_weight"),
            rs.getTimestamp("occurred_at").toInstant()
    );

    /** Serializes evidence + recompute for one user inside the current transaction (SELECT). */
    public void lockUser(long userId) {
        jdbc.queryForList(
                "SELECT pg_advisory_xact_lock(hashtext('proficiency'), CAST(MOD(:userId, 2147483647) AS integer))",
                new MapSqlParameterSource("userId", userId));
    }

    /** INSERT … ON CONFLICT DO NOTHING; true when a new row was written. */
    public boolean insertIfAbsent(EvidenceRow row) {
        String sql = """
                INSERT INTO public.proficiency_evidence
                    (user_id, skill, tier, kind, source_module, source_ref, material_key, raw_score,
                     content_cefr, quality, observed_rating, tier_weight, occurred_at)
                VALUES
                    (:userId, :skill, :tier, :kind, :sourceModule, :sourceRef, :materialKey, :rawScore,
                     :contentCefr, :quality, :observedRating, :tierWeight, :occurredAt)
                ON CONFLICT (user_id, skill, source_module, source_ref) DO NOTHING
                """;
        MapSqlParameterSource p = new MapSqlParameterSource()
                .addValue("userId", row.userId())
                .addValue("skill", row.skill().name())
                .addValue("tier", row.tier().name())
                .addValue("kind", row.kind().name())
                .addValue("sourceModule", row.sourceModule().name())
                .addValue("sourceRef", row.sourceRef())
                .addValue("materialKey", row.materialKey())
                .addValue("rawScore", row.rawScore())
                .addValue("contentCefr", row.contentCefr() == null ? null : row.contentCefr().name())
                .addValue("quality", row.quality())
                .addValue("observedRating", row.observedRating())
                .addValue("tierWeight", row.tierWeight())
                .addValue("occurredAt", Timestamp.from(row.occurredAt()));
        return jdbc.update(sql, p) > 0;
    }

    public List<EvidenceRow> findByUser(long userId) {
        return jdbc.query("SELECT * FROM public.proficiency_evidence WHERE user_id = :userId ORDER BY occurred_at, id",
                new MapSqlParameterSource("userId", userId), ROW_MAPPER);
    }

    public boolean hasTier(long userId, EvidenceTier tier, ProficiencySkill skill) {
        Integer n = jdbc.queryForObject("""
                SELECT COUNT(*) FROM public.proficiency_evidence
                WHERE user_id = :userId AND tier = :tier AND skill = :skill
                """, new MapSqlParameterSource()
                .addValue("userId", userId).addValue("tier", tier.name()).addValue("skill", skill.name()), Integer.class);
        return n != null && n > 0;
    }

    /** Users with at least one evidence row on or after {@code since} (nightly refresh set). */
    public List<Long> findUsersWithEvidenceSince(Instant since) {
        return jdbc.queryForList(
                "SELECT DISTINCT user_id FROM public.proficiency_evidence WHERE occurred_at >= :since ORDER BY user_id",
                new MapSqlParameterSource("since", Timestamp.from(since)), Long.class);
    }
}
