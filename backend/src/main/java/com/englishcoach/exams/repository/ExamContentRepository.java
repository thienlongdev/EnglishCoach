package com.englishcoach.exams.repository;

import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamOwnerProductionAuthorization;
import static com.englishcoach.exams.content.ExamContentPackage.*;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

@Slf4j
@Repository
@RequiredArgsConstructor
public class ExamContentRepository {

    private final NamedParameterJdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    // ─── JSON Helpers ─────────────────────────────────────────────────────────

    private String toJson(Object obj) {
        if (obj == null) return null;
        try {
            return objectMapper.writeValueAsString(obj);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("Failed to serialize to JSON: " + e.getMessage(), e);
        }
    }

    private <T> T fromJson(String json, TypeReference<T> typeRef) {
        if (json == null || json.isBlank()) return null;
        try {
            return objectMapper.readValue(json, typeRef);
        } catch (JsonProcessingException e) {
            log.error("Failed to parse JSON: {}", json, e);
            return null;
        }
    }

    private Map<String, Object> fromJsonMap(String json) {
        if (json == null || json.isBlank()) return null;
        try {
            if (json.trim().startsWith("[")) {
                List<Object> list = objectMapper.readValue(json, new TypeReference<List<Object>>() {});
                Map<String, Object> map = new HashMap<>();
                map.put("variants", list);
                map.put("items", list);
                map.put("values", list);
                return map;
            }
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {});
        } catch (JsonProcessingException e) {
            log.error("Failed to parse JSON: {}", json, e);
            return null;
        }
    }

    // ─── Row Mappers ──────────────────────────────────────────────────────────

    private final RowMapper<FormVersionRecord> formVersionRowMapper = (rs, rowNum) -> new FormVersionRecord(
            (UUID) rs.getObject("id"),
            rs.getString("logical_key"),
            rs.getInt("version"),
            rs.getString("title"),
            ExamFamily.valueOf(rs.getString("family")),
            rs.getString("variant"),
            rs.getString("scope"),
            (UUID) rs.getObject("catalog_node_id"),
            (UUID) rs.getObject("specification_id"),
            (UUID) rs.getObject("scoring_scheme_id"),
            LifecycleState.valueOf(rs.getString("lifecycle_state")),
            (UUID) rs.getObject("provenance_id"),
            (Long) rs.getObject("author_id"),
            rs.getString("content_hash"),
            toInstant(rs.getTimestamp("published_at")),
            toInstant(rs.getTimestamp("retired_at")),
            toInstant(rs.getTimestamp("created_at")),
            // Legacy operator column (restrict-only); NULL stays NULL — never fabricated into "PASS".
            rs.getString("primary_health_status")
    );

    private final RowMapper<SectionRecord> sectionRowMapper = (rs, rowNum) -> new SectionRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("form_id"),
            SkillType.valueOf(rs.getString("skill")),
            rs.getInt("ordinal"),
            rs.getString("spec_section_key"),
            (UUID) rs.getObject("scoring_scheme_id"),
            rs.getInt("duration_seconds"),
            fromJsonMap(rs.getString("timing_policy")),
            // Legacy operator kill switch: NULL = not engaged. It can disable a section but never makes content
            // runnable — runnability is decided by ExamContentValidationService (Exams Phase 2).
            rs.getObject("is_runnable") != null ? rs.getBoolean("is_runnable") : true,
            rs.getString("health_status")
    );

    private final RowMapper<PartRecord> partRowMapper = (rs, rowNum) -> new PartRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("section_id"),
            rs.getString("part_code"),
            rs.getInt("ordinal"),
            rs.getString("instructions"),
            fromJsonMap(rs.getString("timing_policy"))
    );

    private final RowMapper<GroupVersionRecord> groupRowMapper = (rs, rowNum) -> new GroupVersionRecord(
            (UUID) rs.getObject("id"),
            rs.getString("logical_group_key"),
            rs.getInt("version"),
            rs.getString("question_type"),
            rs.getString("construct"),
            SkillType.valueOf(rs.getString("skill")),
            rs.getString("topic"),
            rs.getObject("difficulty_estimate") != null ? rs.getDouble("difficulty_estimate") : null,
            (UUID) rs.getObject("provenance_id"),
            rs.getString("content_hash"),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<StimulusVersionRecord> stimulusRowMapper = (rs, rowNum) -> new StimulusVersionRecord(
            (UUID) rs.getObject("id"),
            rs.getString("logical_stimulus_key"),
            rs.getInt("version"),
            rs.getString("kind"),
            rs.getString("title"),
            fromJsonMap(rs.getString("body_payload")),
            (UUID) rs.getObject("provenance_id"),
            rs.getString("content_hash"),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<ItemVersionRecord> itemRowMapper = (rs, rowNum) -> new ItemVersionRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("group_id"),
            rs.getString("logical_item_key"),
            rs.getInt("version"),
            rs.getString("prompt"),
            rs.getString("interaction_type"),
            fromJsonMap(rs.getString("option_definitions")),
            rs.getString("construct"),
            (UUID) rs.getObject("provenance_id"),
            rs.getString("content_hash"),
            toInstant(rs.getTimestamp("created_at")),
            (Integer) rs.getObject("ordinal")
    );

    private final RowMapper<AnswerSpecRecord> answerSpecRowMapper = (rs, rowNum) -> new AnswerSpecRecord(
            (UUID) rs.getObject("id"),
            (UUID) rs.getObject("item_id"),
            fromJsonMap(rs.getString("accepted_answers")),
            fromJsonMap(rs.getString("normalization_policy")),
            rs.getInt("cardinality"),
            (Integer) rs.getObject("word_limit"),
            rs.getDouble("credit_units"),
            rs.getString("explanation"),
            (UUID) rs.getObject("rubric_id"),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<SpecificationVersionRecord> specRowMapper = (rs, rowNum) -> new SpecificationVersionRecord(
            (UUID) rs.getObject("id"),
            rs.getString("logical_code"),
            rs.getInt("version"),
            ExamFamily.valueOf(rs.getString("family")),
            rs.getString("variant"),
            rs.getString("delivery_mode"),
            fromJsonMap(rs.getString("blueprint")),
            fromJsonMap(rs.getString("timing_policy")),
            fromJsonMap(rs.getString("navigation_policy")),
            fromJsonMap(rs.getString("playback_policy")),
            fromJsonMap(rs.getString("source_references")),
            rs.getString("content_hash"),
            toInstant(rs.getTimestamp("approved_at")),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<ScoringSchemeVersionRecord> schemeRowMapper = (rs, rowNum) -> new ScoringSchemeVersionRecord(
            (UUID) rs.getObject("id"),
            rs.getString("logical_code"),
            rs.getInt("version"),
            ExamFamily.valueOf(rs.getString("family")),
            rs.getString("variant"),
            rs.getString("scope"),
            rs.getString("normalization_version"),
            fromJsonMap(rs.getString("rubric_references")),
            (UUID) rs.getObject("calibration_id"),
            fromJsonMap(rs.getString("mapping_table")),
            fromJsonMap(rs.getString("aggregation_rules")),
            rs.getString("content_hash"),
            toInstant(rs.getTimestamp("approved_at")),
            toInstant(rs.getTimestamp("created_at"))
    );

    private final RowMapper<PackageImportRecord> packageImportRowMapper = (rs, rowNum) -> new PackageImportRecord(
            (UUID) rs.getObject("id"),
            rs.getString("package_id"),
            rs.getInt("package_version"),
            rs.getString("schema_version"),
            rs.getString("content_hash"),
            (UUID) rs.getObject("form_id"),
            rs.getString("status"),
            (Long) rs.getObject("imported_by"),
            rs.getString("creator"),
            toInstant(rs.getTimestamp("created_at")),
            toInstant(rs.getTimestamp("completed_at"))
    );

    private static Instant toInstant(Timestamp ts) {
        return ts != null ? ts.toInstant() : null;
    }

    // ─── Query Operations ─────────────────────────────────────────────────────

    /**
     * Trusted profile evidence requires an explicitly approved production
     * calibration.  This query mirrors the database admission trigger so the
     * worker can skip evidence emission for pilot/calibration-only attempts
     * while still retaining their score artifact and measurement history.
     */
    public boolean isProductionEligibleForProfileEvidence(UUID formId) {
        Boolean eligible = jdbcTemplate.queryForObject("""
                SELECT EXISTS (
                    SELECT 1
                    FROM exams.form_versions f
                    JOIN exams.scoring_scheme_versions s ON s.id = f.scoring_scheme_id
                    JOIN exams.calibration_versions c ON c.id = s.calibration_id
                    WHERE f.id = :formId
                      AND f.lifecycle_state = 'PUBLISHED'
                      AND f.published_at IS NOT NULL
                      AND s.approved_at IS NOT NULL
                      AND c.approved_at IS NOT NULL
                      AND c.maturity_stage IN ('EXPERT_ESTIMATED', 'PILOT_CALIBRATED',
                                               'EMPIRICALLY_CALIBRATED', 'LINKED_CALIBRATED')
                )
                """, new MapSqlParameterSource("formId", formId), Boolean.class);
        return Boolean.TRUE.equals(eligible);
    }

    public List<CatalogFormDto> findPublishedCatalogForms(ExamFamily family, String variant, String scope, int limit, int offset) {
        return findPublishedCatalogForms(family, variant, scope, limit, offset, false);
    }

    public List<CatalogFormDto> findPublishedCatalogForms(ExamFamily family, String variant, String scope, int limit, int offset, boolean allowPilot) {
        StringBuilder sql = new StringBuilder("""
            WITH paged_forms AS (
                SELECT f.id, f.logical_key, f.version, f.title, f.family, f.variant, f.scope,
                       f.primary_health_status, cn.title AS collection_title, f.lifecycle_state, f.published_at
                FROM exams.form_versions f
                LEFT JOIN exams.catalog_nodes cn ON f.catalog_node_id = cn.id
                WHERE (f.lifecycle_state = 'PUBLISHED' OR (:allowPilot = TRUE AND f.lifecycle_state = 'PILOT'))
                  AND NOT EXISTS (
                      SELECT 1 FROM exams.form_versions newer
                       WHERE newer.logical_key = f.logical_key AND newer.version > f.version
                         AND (newer.lifecycle_state = 'PUBLISHED' OR (:allowPilot = TRUE AND newer.lifecycle_state = 'PILOT'))
                  )
                  AND (f.family <> 'TOEIC' OR (
                      EXISTS (SELECT 1 FROM exams.sections ls WHERE ls.form_id = f.id AND ls.skill IN ('LISTENING', 'READING'))
                      AND NOT EXISTS (SELECT 1 FROM exams.sections ps WHERE ps.form_id = f.id AND ps.skill NOT IN ('LISTENING', 'READING'))
                      AND NOT EXISTS (SELECT 1 FROM exams.form_components fc
                          JOIN exams.sections cs ON cs.form_id = fc.child_form_id
                          WHERE fc.parent_form_id = f.id AND cs.skill NOT IN ('LISTENING', 'READING'))
                  ))
        """);

        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("limit", limit)
                .addValue("offset", offset)
                .addValue("allowPilot", allowPilot);

        if (family != null) {
            sql.append(" AND f.family = :family");
            params.addValue("family", family.name());
        }
        if (variant != null && !variant.isBlank()) {
            sql.append(" AND f.variant = :variant");
            params.addValue("variant", variant);
        }
        if (scope != null && !scope.isBlank()) {
            sql.append(" AND f.scope = :scope");
            params.addValue("scope", scope);
        }

        sql.append("""
                ORDER BY f.published_at DESC NULLS LAST, f.title ASC, f.id ASC
                LIMIT :limit OFFSET :offset
            )
            SELECT f.id, f.logical_key, f.version, f.title, f.family, f.variant, f.scope,
                   f.primary_health_status, f.collection_title, f.lifecycle_state, f.published_at,
                   ARRAY(SELECT DISTINCT sk.skill FROM (
                       SELECT skill FROM exams.sections WHERE form_id = f.id
                       UNION ALL
                       SELECT cs.skill FROM exams.form_components fc
                       JOIN exams.sections cs ON cs.form_id = fc.child_form_id WHERE fc.parent_form_id = f.id
                   ) sk ORDER BY sk.skill) AS catalog_skills,
                   COALESCE(
                       (SELECT SUM(s2.duration_seconds) FROM exams.sections s2 WHERE s2.form_id = f.id),
                       (SELECT SUM(cs.duration_seconds)
                        FROM exams.form_components fc
                        JOIN exams.sections cs ON cs.form_id = fc.child_form_id
                        WHERE fc.parent_form_id = f.id),
                       0
                   ) / 60 AS total_duration_minutes,
                   COALESCE(
                       NULLIF((SELECT COUNT(DISTINCT iv2.id)
                        FROM exams.sections s2
                        JOIN exams.parts p2 ON s2.id = p2.section_id
                        JOIN exams.form_groups fg2 ON p2.id = fg2.part_id
                        JOIN exams.item_versions iv2 ON fg2.group_id = iv2.group_id
                        WHERE s2.form_id = f.id), 0),
                       (SELECT COUNT(DISTINCT civ.id)
                        FROM exams.form_components fc
                        JOIN exams.sections cs ON cs.form_id = fc.child_form_id
                        JOIN exams.parts cp ON cs.id = cp.section_id
                        JOIN exams.form_groups cfg ON cp.id = cfg.part_id
                        JOIN exams.item_versions civ ON cfg.group_id = civ.group_id
                        WHERE fc.parent_form_id = f.id),
                       0
                   ) AS total_items
            FROM paged_forms f
            ORDER BY f.published_at DESC NULLS LAST, f.title ASC, f.id ASC
        """);

        // Runnability is NOT decided here: every row leaves the repository fail-closed (nothing runnable) and
        // ExamContentService applies the authoritative ExamContentValidationService result (Exams Phase 2).
        return jdbcTemplate.query(sql.toString(), params, (rs, rowNum) -> new CatalogFormDto(
                (UUID) rs.getObject("id"),
                rs.getString("logical_key"),
                rs.getInt("version"),
                rs.getString("title"),
                ExamFamily.valueOf(rs.getString("family")),
                rs.getString("variant"),
                rs.getString("scope"),
                rs.getString("collection_title"),
                rs.getInt("total_duration_minutes"),
                rs.getInt("total_items"),
                Arrays.asList((String[]) rs.getArray("catalog_skills").getArray()),
                LifecycleState.valueOf(rs.getString("lifecycle_state")),
                toInstant(rs.getTimestamp("published_at"))
        ));
    }

    public List<String> findSkillsByFormId(UUID formId) {
        String sql = """
            SELECT DISTINCT skill FROM (
                SELECT skill FROM exams.sections WHERE form_id = :formId
                UNION ALL
                SELECT s.skill
                FROM exams.form_components fc
                JOIN exams.sections s ON s.form_id = fc.child_form_id
                WHERE fc.parent_form_id = :formId
            ) combined
            WHERE skill IS NOT NULL
            ORDER BY skill
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("formId", formId),
                (rs, rowNum) -> rs.getString("skill"));
    }

    public Optional<FormVersionRecord> findFormById(UUID formId) {
        String sql = "SELECT * FROM exams.form_versions WHERE id = :formId";
        try {
            FormVersionRecord record = jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("formId", formId), formVersionRowMapper);
            return Optional.ofNullable(record);
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<FormVersionRecord> findFormByLogicalKeyAndVersion(String logicalKey, int version) {
        String sql = "SELECT * FROM exams.form_versions WHERE logical_key = :logicalKey AND version = :version";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                    .addValue("logicalKey", logicalKey).addValue("version", version), formVersionRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    /**
     * Admin-only form work queue projection.  Unlike the learner catalog this
     * includes DRAFT and review states and exposes the package ledger status,
     * while deliberately omitting answer keys, explanations, and media.
     */
    public List<AdminFormSummary> findAdminFormSummaries(ExamFamily family, String lifecycleState,
                                                         int limit, int offset) {
        StringBuilder sql = new StringBuilder("""
            SELECT f.id, f.logical_key, f.version, f.title, f.family, f.variant, f.scope,
                   f.lifecycle_state, f.content_hash, f.author_id, f.created_at,
                   pi.package_id, pi.package_version, pi.status AS package_status
            FROM exams.form_versions f
            LEFT JOIN LATERAL (
                SELECT cpi.package_id, cpi.package_version, cpi.status
                FROM exams.content_package_imports cpi
                WHERE cpi.form_id = f.id
                ORDER BY cpi.created_at DESC
                LIMIT 1
            ) pi ON TRUE
            WHERE TRUE
        """);
        MapSqlParameterSource params = new MapSqlParameterSource();
        if (family != null) {
            sql.append(" AND f.family = :family");
            params.addValue("family", family.name());
        }
        if (lifecycleState != null && !lifecycleState.isBlank()) {
            sql.append(" AND f.lifecycle_state = :lifecycleState");
            params.addValue("lifecycleState", lifecycleState);
        }
        sql.append("""
            ORDER BY f.created_at DESC, f.logical_key ASC, f.version DESC
            LIMIT :limit OFFSET :offset
        """);
        params.addValue("limit", Math.min(Math.max(limit, 1), 100));
        params.addValue("offset", Math.max(offset, 0));
        return jdbcTemplate.query(sql.toString(), params,
                (rs, rowNum) -> new AdminFormSummary(
                        (UUID) rs.getObject("id"), rs.getString("logical_key"), rs.getInt("version"),
                        rs.getString("title"), ExamFamily.valueOf(rs.getString("family")), rs.getString("variant"),
                        rs.getString("scope"), rs.getString("lifecycle_state"), rs.getString("content_hash"),
                        (Long) rs.getObject("author_id"), toInstant(rs.getTimestamp("created_at")),
                        rs.getString("package_id"), (Integer) rs.getObject("package_version"),
                        rs.getString("package_status")));
    }

    /** Admin source work queue projection with no licence evidence payload. */
    public List<AdminSourceSummary> findAdminSourceSummaries(int limit, int offset) {
        String sql = """
            SELECT id, code, name, owner, publisher, source_type, retired_at, created_at
            FROM exams.sources
            ORDER BY created_at DESC, code ASC
            LIMIT :limit OFFSET :offset
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource()
                        .addValue("limit", Math.min(Math.max(limit, 1), 100))
                        .addValue("offset", Math.max(offset, 0)),
                (rs, rowNum) -> new AdminSourceSummary(
                        (UUID) rs.getObject("id"), rs.getString("code"), rs.getString("name"),
                        rs.getString("owner"), rs.getString("publisher"), rs.getString("source_type"),
                        toInstant(rs.getTimestamp("retired_at")), toInstant(rs.getTimestamp("created_at"))));
    }

    public Optional<SourceRecord> findSourceById(UUID sourceId) {
        String sql = "SELECT * FROM exams.sources WHERE id = :id";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql, new MapSqlParameterSource("id", sourceId),
                    (rs, rowNum) -> new SourceRecord(
                            (UUID) rs.getObject("id"), rs.getString("code"), rs.getString("name"),
                            rs.getString("owner"), rs.getString("publisher"), rs.getString("source_type"),
                            fromJsonMap(rs.getString("reference_meta")), toInstant(rs.getTimestamp("retired_at")),
                            toInstant(rs.getTimestamp("created_at")))));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<LicenseRecord> findLicenseById(UUID licenseId) {
        String sql = "SELECT * FROM exams.licenses WHERE id = :id";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql, new MapSqlParameterSource("id", licenseId),
                    (rs, rowNum) -> new LicenseRecord(
                            (UUID) rs.getObject("id"), (UUID) rs.getObject("source_id"), rs.getString("license_code"),
                            ProvenanceCategory.valueOf(rs.getString("provenance_category")), rs.getBoolean("commercial_rights"),
                            rs.getBoolean("redistribution_rights"), rs.getBoolean("derivative_rights"),
                            fromJsonMap(rs.getString("permitted_purposes")), fromJsonMap(rs.getString("permitted_territories")),
                            toInstant(rs.getTimestamp("valid_from")), toInstant(rs.getTimestamp("valid_until")),
                            rs.getString("attribution"), rs.getString("evidence_asset_id"), rs.getString("legal_status"),
                            toInstant(rs.getTimestamp("created_at")))));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<ProvenanceRecord> findProvenanceById(UUID provenanceId) {
        String sql = "SELECT * FROM exams.provenance_records WHERE id = :id";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql, new MapSqlParameterSource("id", provenanceId),
                    (rs, rowNum) -> new ProvenanceRecord(
                            (UUID) rs.getObject("id"), (UUID) rs.getObject("source_id"), (UUID) rs.getObject("license_id"),
                            rs.getString("creator"), rs.getString("acquisition_method"), rs.getString("original_reference"),
                            (UUID) rs.getObject("derivative_parent_id"), fromJsonMap(rs.getString("ai_generation_meta")),
                            toInstant(rs.getTimestamp("created_at")))));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    /** Returns the immutable form hash used by review decisions. */
    public Optional<String> findCurrentClosureHash(UUID formId) {
        String sql = "SELECT content_hash FROM exams.form_versions WHERE id = :formId";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql, new MapSqlParameterSource("formId", formId), String.class));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    /**
     * Every provenance id reachable from a form (form, component forms, groups, items, stimuli, assets, rubrics). Shared
     * by the licence check and the rights-fact loader so both judge exactly the same closure.
     * Rewritten with non-correlated form_scope + scoped_groups CTEs so PostgreSQL uses idx_sections_form instead of
     * per-branch OR-IN SubPlan hash joins.
     */
    private static final String FORM_PROVENANCE_CLOSURE_CTE = """
            WITH form_scope AS (
                SELECT CAST(:formId AS uuid) AS eff_form_id
                UNION ALL
                SELECT fc.child_form_id FROM exams.form_components fc WHERE fc.parent_form_id = :formId
            ),
            scoped_groups AS (
                SELECT DISTINCT fg.group_id
                FROM form_scope fs
                JOIN exams.sections s ON s.form_id = fs.eff_form_id
                JOIN exams.parts p ON p.section_id = s.id
                JOIN exams.form_groups fg ON fg.part_id = p.id
            ),
            provenance_ids AS (
                SELECT f.provenance_id FROM exams.form_versions f WHERE f.id = :formId
                UNION ALL
                SELECT cf.provenance_id
                FROM exams.form_components fc
                JOIN exams.form_versions cf ON cf.id = fc.child_form_id
                WHERE fc.parent_form_id = :formId
                UNION ALL
                SELECT g.provenance_id
                FROM scoped_groups sg
                JOIN exams.group_versions g ON g.id = sg.group_id
                UNION ALL
                SELECT i.provenance_id
                FROM scoped_groups sg
                JOIN exams.item_versions i ON i.group_id = sg.group_id
                UNION ALL
                SELECT st.provenance_id
                FROM scoped_groups sg
                JOIN exams.group_stimuli gs ON gs.group_id = sg.group_id
                JOIN exams.stimulus_versions st ON st.id = gs.stimulus_id
                UNION ALL
                SELECT a.provenance_id
                FROM scoped_groups sg
                JOIN exams.group_stimuli gs ON gs.group_id = sg.group_id
                JOIN exams.stimulus_assets sa ON sa.stimulus_id = gs.stimulus_id
                JOIN exams.assets a ON a.id = sa.asset_id
                UNION ALL
                SELECT r.provenance_id
                FROM scoped_groups sg
                JOIN exams.item_versions i ON i.group_id = sg.group_id
                JOIN exams.answer_specs ans ON ans.item_id = i.id
                JOIN exams.rubric_versions r ON r.id = ans.rubric_id
            )
            """;

    /** Non-correlated batch provenance closure evaluated once for an entire :formIds catalog batch. */
    private static final String BATCH_PROVENANCE_CLOSURE_CTE = """
            WITH form_scope AS (
                SELECT fv.id AS root_id, fv.id AS eff_form_id
                FROM exams.form_versions fv
                WHERE fv.id IN (:formIds)
                UNION ALL
                SELECT fc.parent_form_id AS root_id, fc.child_form_id AS eff_form_id
                FROM exams.form_components fc
                WHERE fc.parent_form_id IN (:formIds)
            ),
            scoped_groups AS (
                SELECT DISTINCT fs.root_id, fg.group_id
                FROM form_scope fs
                JOIN exams.sections s ON s.form_id = fs.eff_form_id
                JOIN exams.parts p ON p.section_id = s.id
                JOIN exams.form_groups fg ON fg.part_id = p.id
            ),
            provenance_ids AS (
                SELECT f.id AS root_id, f.provenance_id
                FROM exams.form_versions f
                WHERE f.id IN (:formIds)
                UNION ALL
                SELECT fc.parent_form_id AS root_id, cf.provenance_id
                FROM exams.form_components fc
                JOIN exams.form_versions cf ON cf.id = fc.child_form_id
                WHERE fc.parent_form_id IN (:formIds)
                UNION ALL
                SELECT sg.root_id, g.provenance_id
                FROM scoped_groups sg
                JOIN exams.group_versions g ON g.id = sg.group_id
                UNION ALL
                SELECT sg.root_id, i.provenance_id
                FROM scoped_groups sg
                JOIN exams.item_versions i ON i.group_id = sg.group_id
                UNION ALL
                SELECT sg.root_id, st.provenance_id
                FROM scoped_groups sg
                JOIN exams.group_stimuli gs ON gs.group_id = sg.group_id
                JOIN exams.stimulus_versions st ON st.id = gs.stimulus_id
                UNION ALL
                SELECT sg.root_id, a.provenance_id
                FROM scoped_groups sg
                JOIN exams.group_stimuli gs ON gs.group_id = sg.group_id
                JOIN exams.stimulus_assets sa ON sa.stimulus_id = gs.stimulus_id
                JOIN exams.assets a ON a.id = sa.asset_id
                UNION ALL
                SELECT sg.root_id, r.provenance_id
                FROM scoped_groups sg
                JOIN exams.item_versions i ON i.group_id = sg.group_id
                JOIN exams.answer_specs ans ON ans.item_id = i.id
                JOIN exams.rubric_versions r ON r.id = ans.rubric_id
            )
            """;

    /**
     * Resolves every provenance row reachable from a form and fails closed if
     * any dependency is missing, unapproved, expired, or lacks explicit scope.
     */
    public boolean hasValidRightsForForm(UUID formId, Instant now) {
        return hasValidRightsForForm(formId, now, false);
    }

    public boolean hasValidRightsForForm(UUID formId, Instant now, boolean allowPilot) {
        String sql = formRightsInvalidCountSql();
        Long invalid = jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("formId", formId)
                .addValue("now", Timestamp.from(now == null ? Instant.now() : now))
                .addValue("allowPilot", allowPilot), Long.class);
        return invalid != null && invalid == 0;
    }

    private static String formRightsInvalidCountSql() {
        return FORM_PROVENANCE_CLOSURE_CTE + """
            SELECT COUNT(*)
            FROM provenance_ids pid
            LEFT JOIN exams.provenance_records pr ON pr.id = pid.provenance_id
            LEFT JOIN exams.licenses l ON l.id = pr.license_id
            WHERE pid.provenance_id IS NULL
               OR pr.id IS NULL
               OR l.id IS NULL
               OR (
                   (:allowPilot = FALSE AND (
                       l.provenance_category NOT IN ('ORIGINAL', 'LICENSED')
                       OR l.legal_status <> 'APPROVED'
                       OR l.commercial_rights = FALSE
                       OR l.redistribution_rights = FALSE
                       OR l.derivative_rights = FALSE
                   ))
                   OR
                    (:allowPilot = TRUE AND (
                        l.provenance_category NOT IN ('ORIGINAL', 'LICENSED', 'FAIR_USE_REVIEWED', 'UNKNOWN', 'BENCHMARK_ONLY')
                        OR l.legal_status NOT IN ('APPROVED', 'PENDING')
                    ))
               )
               OR (l.valid_from IS NOT NULL AND l.valid_from > :now)
               OR (l.valid_until IS NOT NULL AND l.valid_until <= :now)
               OR NOT EXISTS (
                   SELECT 1
                   FROM jsonb_object_keys(COALESCE(l.permitted_purposes, '{}'::jsonb)) purpose(key)
                   WHERE UPPER(purpose.key) IN ('EXAM', 'SIMULATION', 'PRACTICE', 'CONTENT', 'REDISTRIBUTION', 'STUDY')
               )
        """;
    }

    /** One live non-correlated closure statement per bounded catalog batch; no rights grants are cached. */
    public Map<UUID, Boolean> validFormRights(Collection<UUID> formIds, Instant now, boolean allowPilot) {
        if (formIds.isEmpty()) return Map.of();
        String sql = BATCH_PROVENANCE_CLOSURE_CTE + """
            , invalid_roots AS (
                SELECT DISTINCT pid.root_id
                FROM provenance_ids pid
                LEFT JOIN exams.provenance_records pr ON pr.id = pid.provenance_id
                LEFT JOIN exams.licenses l ON l.id = pr.license_id
                WHERE pid.provenance_id IS NULL
                   OR pr.id IS NULL
                   OR l.id IS NULL
                   OR (
                       (:allowPilot = FALSE AND (
                           l.provenance_category NOT IN ('ORIGINAL', 'LICENSED')
                           OR l.legal_status <> 'APPROVED'
                           OR l.commercial_rights = FALSE
                           OR l.redistribution_rights = FALSE
                           OR l.derivative_rights = FALSE
                       ))
                       OR
                        (:allowPilot = TRUE AND (
                            l.provenance_category NOT IN ('ORIGINAL', 'LICENSED', 'FAIR_USE_REVIEWED', 'UNKNOWN', 'BENCHMARK_ONLY')
                            OR l.legal_status NOT IN ('APPROVED', 'PENDING')
                        ))
                   )
                   OR (l.valid_from IS NOT NULL AND l.valid_from > :now)
                   OR (l.valid_until IS NOT NULL AND l.valid_until <= :now)
                   OR NOT EXISTS (
                       SELECT 1
                       FROM jsonb_object_keys(COALESCE(l.permitted_purposes, '{}'::jsonb)) purpose(key)
                       WHERE UPPER(purpose.key) IN ('EXAM', 'SIMULATION', 'PRACTICE', 'CONTENT', 'REDISTRIBUTION', 'STUDY')
                   )
            )
            SELECT root.id,
                   (root.provenance_id IS NOT NULL AND ir.root_id IS NULL) AS allowed
            FROM exams.form_versions root
            LEFT JOIN invalid_roots ir ON ir.root_id = root.id
            WHERE root.id IN (:formIds)
        """;
        Map<UUID, Boolean> result = new HashMap<>();
        jdbcTemplate.query(sql, new MapSqlParameterSource("formIds", formIds)
                .addValue("now", Timestamp.from(now)).addValue("allowPilot", allowPilot),
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> result.put((UUID) rs.getObject("id"), rs.getBoolean("allowed")));
        return result;
    }

    /** Bounded, live non-correlated owner-decision lookup; publisher gaps may be cleared, missing closure/expiry may not. */
    public Map<UUID, Boolean> validOwnerProductionFormRights(Collection<UUID> formIds, Instant now, Set<String> rawHashes) {
        if (formIds.isEmpty() || rawHashes.isEmpty()) return Map.of();
        String sql = BATCH_PROVENANCE_CLOSURE_CTE + """
            , invalid_roots AS (
                SELECT DISTINCT pid.root_id
                FROM provenance_ids pid
                LEFT JOIN exams.provenance_records pr ON pr.id = pid.provenance_id
                LEFT JOIN exams.licenses l ON l.id = pr.license_id
                WHERE pid.provenance_id IS NULL OR pr.id IS NULL OR l.id IS NULL
                   OR (l.valid_from IS NOT NULL AND l.valid_from > :now)
                   OR (l.valid_until IS NOT NULL AND l.valid_until <= :now)
            )
            SELECT root.id,
                   (root.provenance_id IS NOT NULL AND ir.root_id IS NULL AND EXISTS (
                       SELECT 1 FROM exams.project_usage_authorizations a
                       WHERE a.form_id = root.id AND a.import_basis = :basis AND a.production_import = :basis
                         AND a.status = 'OWNER_AUTHORIZED' AND a.authorized_by = 'PROJECT_OWNER'
                         AND a.decision_ref = :decision AND a.decision_date = DATE '2026-10-06'
                         AND a.publisher_endorsement = FALSE AND a.publisher_licence IN ('UNKNOWN','NOT_ESTABLISHED')
                         AND a.source_provenance->'rawSourceFile'->>'sha256' IN (:rawHashes)
                         AND a.source_provenance->'rawSourceFile'->>'path' LIKE 'imports/source-files/%'
                         AND a.permits @> '["PRODUCTION_IMPORT","PUBLICATION","LEARNER_RUNTIME","MEDIA","SCORING","RESULTS","REVIEW"]'::jsonb
                   )) AS allowed
            FROM exams.form_versions root
            LEFT JOIN invalid_roots ir ON ir.root_id = root.id
            WHERE root.id IN (:formIds)
        """;
        Map<UUID, Boolean> result = new HashMap<>();
        jdbcTemplate.query(sql, new MapSqlParameterSource("formIds", formIds).addValue("now", Timestamp.from(now))
                        .addValue("rawHashes", rawHashes)
                        .addValue("basis", com.englishcoach.exams.content.ExamOwnerProductionAuthorization.BASIS)
                        .addValue("decision", com.englishcoach.exams.content.ExamOwnerProductionAuthorization.DECISION_REF),
                (org.springframework.jdbc.core.RowCallbackHandler) rs -> result.put((UUID) rs.getObject("id"), rs.getBoolean("allowed")));
        return result;
    }

    /**
     * Pre-Phase-8 rights checkpoint: the publisher-licence FACTS of the form's provenance closure (same closure as
     * {@link #hasValidRightsForForm}), one entry per reachable provenance id. Read-only; a missing provenance or licence
     * row is reported as such (the rights policy never clears it).
     */
    public List<RightsClosureRow> findRightsClosureForForm(UUID formId) {
        String sql = FORM_PROVENANCE_CLOSURE_CTE + """
            SELECT DISTINCT pid.provenance_id, pr.id AS provenance_row, l.id AS license_id, l.provenance_category,
                   l.legal_status, l.commercial_rights, l.redistribution_rights, l.derivative_rights,
                   l.valid_from, l.valid_until, l.permitted_purposes
            FROM provenance_ids pid
            LEFT JOIN exams.provenance_records pr ON pr.id = pid.provenance_id
            LEFT JOIN exams.licenses l ON l.id = pr.license_id
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("formId", formId), (rs, n) -> rightsClosureRow(rs));
    }

    /** Licence facts of one asset's provenance (empty list when the asset does not exist). */
    public List<RightsClosureRow> findRightsClosureForAsset(UUID assetId) {
        String sql = """
            SELECT a.provenance_id, p.id AS provenance_row, l.id AS license_id, l.provenance_category,
                   l.legal_status, l.commercial_rights, l.redistribution_rights, l.derivative_rights,
                   l.valid_from, l.valid_until, l.permitted_purposes
            FROM exams.assets a
            LEFT JOIN exams.provenance_records p ON p.id = a.provenance_id
            LEFT JOIN exams.licenses l ON l.id = p.license_id
            WHERE a.id = :assetId
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("assetId", assetId), (rs, n) -> rightsClosureRow(rs));
    }

    /** Forms (incl. parents of component forms) whose content places the asset — read-only. */
    public List<UUID> findFormIdsPlacingAsset(UUID assetId) {
        String sql = """
            SELECT DISTINCT s.form_id
            FROM exams.stimulus_assets sa
            JOIN exams.group_stimuli gs ON gs.stimulus_id = sa.stimulus_id
            JOIN exams.form_groups fg ON fg.group_id = gs.group_id
            JOIN exams.parts p ON p.id = fg.part_id
            JOIN exams.sections s ON s.id = p.section_id
            WHERE sa.asset_id = :assetId
            UNION
            SELECT fc.parent_form_id
            FROM exams.stimulus_assets sa
            JOIN exams.group_stimuli gs ON gs.stimulus_id = sa.stimulus_id
            JOIN exams.form_groups fg ON fg.group_id = gs.group_id
            JOIN exams.parts p ON p.id = fg.part_id
            JOIN exams.sections s ON s.id = p.section_id
            JOIN exams.form_components fc ON fc.child_form_id = s.form_id
            WHERE sa.asset_id = :assetId
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("assetId", assetId), (rs, n) -> (UUID) rs.getObject(1));
    }

    /**
     * The latest owner project-use authorization recorded for a form (V72, append-only), as a metadata map shaped like
     * the package manifest's ({@code projectUsageAuthorization} + {@code sourceProvenance}) so the rights policy builds
     * its facts with the same code as the staging path. Empty when none is recorded or the table does not exist.
     */
    public Optional<RecordedProjectAuthorization> findLatestProjectUsageAuthorization(UUID formId) {
        String sql = """
            SELECT status, scope, authorized_by, decision_date, decision_ref, applies_to, permits, production_import,
                   import_basis, publisher_licence, publisher_endorsement, source_provenance
            FROM exams.project_usage_authorizations
            WHERE form_id = :formId
            ORDER BY recorded_at DESC, id DESC
            LIMIT 1
        """;
        List<RecordedProjectAuthorization> rows = jdbcTemplate.query(sql, new MapSqlParameterSource("formId", formId), (rs, n) -> {
            Map<String, Object> auth = new LinkedHashMap<>();
            auth.put("status", rs.getString("status"));
            auth.put("scope", rs.getString("scope"));
            auth.put("authorizedBy", rs.getString("authorized_by"));
            java.sql.Date decision = rs.getDate("decision_date");
            auth.put("decisionDate", decision == null ? null : decision.toLocalDate().toString());
            auth.put("decisionRef", rs.getString("decision_ref"));
            auth.put("appliesTo", rs.getString("applies_to"));
            List<Object> permits = fromJson(rs.getString("permits"), new TypeReference<List<Object>>() {});
            auth.put("permits", permits == null ? List.of() : permits.stream().filter(Objects::nonNull).map(String::valueOf).toList());
            auth.put("productionImport", rs.getString("production_import"));
            auth.put("publisherLicence", rs.getString("publisher_licence"));
            auth.put("publisherEndorsement", rs.getBoolean("publisher_endorsement"));
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("projectUsageAuthorization", auth);
            metadata.put("sourceProvenance", fromJsonMap(rs.getString("source_provenance")));
            return new RecordedProjectAuthorization(metadata, rs.getString("import_basis"));
        });
        return rows.stream().findFirst();
    }

    /** One provenance id of a rights closure with its licence facts (null columns when a row is missing). */
    public record RightsClosureRow(UUID provenanceId, boolean provenanceRowPresent, boolean licenceRowPresent,
                                   String provenanceCategory, String legalStatus, boolean commercialRights,
                                   boolean redistributionRights, boolean derivativeRights, Instant validFrom,
                                   Instant validUntil, Set<String> permittedPurposeKeys) {}

    /** A persisted V72 authorization as a manifest-shaped metadata map + the import basis it was recorded under. */
    public record RecordedProjectAuthorization(Map<String, Object> metadata, String importBasis) {}

    private RightsClosureRow rightsClosureRow(java.sql.ResultSet rs) throws java.sql.SQLException {
        Map<String, Object> purposes = fromJson(rs.getString("permitted_purposes"), new TypeReference<Map<String, Object>>() {});
        return new RightsClosureRow((UUID) rs.getObject(1), rs.getObject("provenance_row") != null,
                rs.getObject("license_id") != null, rs.getString("provenance_category"), rs.getString("legal_status"),
                rs.getBoolean("commercial_rights"), rs.getBoolean("redistribution_rights"), rs.getBoolean("derivative_rights"),
                toInstant(rs.getTimestamp("valid_from")), toInstant(rs.getTimestamp("valid_until")),
                purposes == null ? Set.of() : new LinkedHashSet<>(purposes.keySet()));
    }

    public boolean hasValidRightsForAsset(UUID assetId, Instant now) {
        return hasValidRightsForAsset(assetId, now, false);
    }

    public boolean hasValidRightsForAsset(UUID assetId, Instant now, boolean allowPilot) {
        String sql = """
            SELECT COUNT(*)
            FROM exams.assets a
            LEFT JOIN exams.provenance_records p ON p.id = a.provenance_id
            LEFT JOIN exams.licenses l ON l.id = p.license_id
            WHERE a.id = :assetId
              AND a.validation_state = 'VALIDATED'
              AND p.id IS NOT NULL AND l.id IS NOT NULL
              AND (
                  (:allowPilot = FALSE AND (
                      l.provenance_category IN ('ORIGINAL', 'LICENSED')
                      AND l.legal_status = 'APPROVED'
                      AND l.commercial_rights AND l.redistribution_rights AND l.derivative_rights
                  ))
                  OR
                  (:allowPilot = TRUE AND (
                      l.provenance_category IN ('ORIGINAL', 'LICENSED', 'FAIR_USE_REVIEWED', 'UNKNOWN', 'BENCHMARK_ONLY')
                      AND l.legal_status IN ('APPROVED', 'PENDING')
                  ))
              )
              AND (l.valid_from IS NULL OR l.valid_from <= :now)
              AND (l.valid_until IS NULL OR l.valid_until > :now)
              AND EXISTS (
                  SELECT 1 FROM jsonb_object_keys(COALESCE(l.permitted_purposes, '{}'::jsonb)) purpose(key)
                  WHERE UPPER(purpose.key) IN ('EXAM', 'SIMULATION', 'PRACTICE', 'CONTENT', 'REDISTRIBUTION', 'STUDY')
              )
        """;
        Long valid = jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("assetId", assetId)
                .addValue("now", Timestamp.from(now == null ? Instant.now() : now))
                .addValue("allowPilot", allowPilot), Long.class);
        return valid != null && valid > 0;
    }

    public Optional<ReviewSummary> findReviewSummary(UUID formId) {
        String sql = """
            SELECT gate, reviewer_user_id, decision, reviewed_closure_hash, created_at
            FROM exams.content_reviews
            WHERE form_id = :formId
            ORDER BY created_at ASC
        """;
        List<ReviewGateApproval> approvals = jdbcTemplate.query(sql, new MapSqlParameterSource("formId", formId),
                (rs, rowNum) -> new ReviewGateApproval(
                        rs.getString("gate"), rs.getLong("reviewer_user_id"), rs.getString("decision"),
                        rs.getString("reviewed_closure_hash"), toInstant(rs.getTimestamp("created_at"))));
        if (approvals.isEmpty()) return Optional.empty();
        long distinct = approvals.stream()
                .filter(a -> "APPROVED".equals(a.decision()))
                .map(ReviewGateApproval::reviewerUserId)
                .filter(Objects::nonNull)
                .distinct().count();
        return Optional.of(new ReviewSummary(approvals, (int) distinct));
    }

    /** Serialize the package identity lock to prevent concurrent graph imports. */
    public void lockPackageIdentity(String packageId, int packageVersion) {
        // pg_advisory_xact_lock returns void. Consume its result set instead of
        // asking Spring to coerce the void value to a Long before any write.
        jdbcTemplate.query("SELECT pg_advisory_xact_lock(hashtextextended(:identity, 0))",
                new MapSqlParameterSource("identity", packageId + ":v" + packageVersion), rs -> null);
    }

    public Optional<PackageImportRecord> findPackageImport(String packageId, int packageVersion, boolean forUpdate) {
        String sql = "SELECT * FROM exams.content_package_imports WHERE package_id = :packageId AND package_version = :packageVersion"
                + (forUpdate ? " FOR UPDATE" : "");
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                    .addValue("packageId", packageId).addValue("packageVersion", packageVersion), packageImportRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    /** Exams Phase 5C: the package identity the importer recorded for one import (QA-run findings), if any. */
    @SuppressWarnings("unchecked")
    public Optional<Map<String, Object>> findPackageImportIdentity(UUID packageImportId) {
        List<String> rows = jdbcTemplate.query(
                "SELECT findings -> 'packageIdentity' AS identity FROM exams.content_qa_runs WHERE package_import_id = :id "
                        + "AND findings -> 'packageIdentity' IS NOT NULL ORDER BY created_at LIMIT 1",
                new MapSqlParameterSource("id", packageImportId), (rs, n) -> rs.getString("identity"));
        if (rows.isEmpty() || rows.get(0) == null) return Optional.empty();
        try {
            return Optional.of(objectMapper.readValue(rows.get(0), Map.class));
        } catch (Exception e) {
            return Optional.empty();
        }
    }

    /**
     * Fences package graph writes from mutating a different immutable version
     * that happens to use the same logical identity.  Existing dependencies
     * may be reused only when their stable ID and content hash agree; the
     * package importer calls this while holding its identity lock.
     */
    public void assertPackageIdentityAvailable(ExamContentPackage pkg) {
        for (SourceRecord source : pkg.sources()) {
            assertStableSourceIdentity(source);
        }
        for (LicenseRecord license : pkg.licenses()) {
            assertStableLicenseIdentity(license);
        }
        for (ProvenanceRecord provenance : pkg.provenances()) {
            assertStableProvenanceIdentity(provenance);
        }
        for (CatalogNodeRecord node : pkg.catalogNodes()) {
            assertStableCatalogNodeIdentity(node);
        }
        for (SpecificationVersionRecord spec : pkg.specifications()) {
            assertVersionedIdentity("exams.specification_versions", "logical_code = :logicalCode AND version = :version",
                    new MapSqlParameterSource().addValue("logicalCode", spec.logicalCode()).addValue("version", spec.version()),
                    spec.id(), spec.contentHash(), "specification " + spec.logicalCode());
        }
        for (RubricVersionRecord rubric : pkg.rubrics()) {
            assertVersionedIdentity("exams.rubric_versions", "id = :id",
                    new MapSqlParameterSource().addValue("id", rubric.id()),
                    rubric.id(), rubric.contentHash(), "rubric " + rubric.logicalCode());
        }
        for (CalibrationVersionRecord calibration : pkg.calibrations()) {
            assertStableLogicalIdentity("exams.calibration_versions", "logical_code = :logicalCode AND version = :version",
                    new MapSqlParameterSource().addValue("logicalCode", calibration.logicalCode()).addValue("version", calibration.version()),
                    calibration.id(), "calibration " + calibration.logicalCode());
        }
        for (ScoringSchemeVersionRecord scheme : pkg.scoringSchemes()) {
            assertVersionedIdentity("exams.scoring_scheme_versions", "logical_code = :logicalCode AND version = :version",
                    new MapSqlParameterSource().addValue("logicalCode", scheme.logicalCode()).addValue("version", scheme.version()),
                    scheme.id(), scheme.contentHash(), "scoring scheme " + scheme.logicalCode());
        }
        for (GroupVersionRecord group : pkg.groups()) {
            assertVersionedIdentity("exams.group_versions", "logical_group_key = :logicalKey AND version = :version",
                    new MapSqlParameterSource().addValue("logicalKey", group.logicalGroupKey()).addValue("version", group.version()),
                    group.id(), group.contentHash(), "group " + group.logicalGroupKey());
        }
        for (StimulusVersionRecord stimulus : pkg.stimuli()) {
            assertVersionedIdentity("exams.stimulus_versions", "logical_stimulus_key = :logicalKey AND version = :version",
                    new MapSqlParameterSource().addValue("logicalKey", stimulus.logicalStimulusKey()).addValue("version", stimulus.version()),
                    stimulus.id(), stimulus.contentHash(), "stimulus " + stimulus.logicalStimulusKey());
        }
        for (ItemVersionRecord item : pkg.items()) {
            assertVersionedIdentity("exams.item_versions", "logical_item_key = :logicalKey AND version = :version",
                    new MapSqlParameterSource().addValue("logicalKey", item.logicalItemKey()).addValue("version", item.version()),
                    item.id(), item.contentHash(), "item " + item.logicalItemKey());
        }
        for (AssetRecord asset : pkg.assets()) {
            assertVersionedIdentity("exams.assets", "object_key = :objectKey AND version_id IS NOT DISTINCT FROM :versionId",
                    new MapSqlParameterSource().addValue("objectKey", asset.objectKey()).addValue("versionId", asset.versionId()),
                    asset.id(), asset.sha256Hash(), "asset " + asset.objectKey());
        }
    }

    private void assertStableSourceIdentity(SourceRecord source) {
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "SELECT code FROM exams.sources WHERE id = :id",
                new MapSqlParameterSource("id", source.id()));
        for (Map<String, Object> row : rows) {
            String existingCode = (String) row.get("code");
            if (!Objects.equals(existingCode, source.code())) {
                throw new IllegalStateException("CONTENT_IDENTITY_CONFLICT: source " + source.id()
                        + " already exists with a different code");
            }
        }
    }

    private void assertStableLicenseIdentity(LicenseRecord license) {
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "SELECT source_id, license_code FROM exams.licenses WHERE id = :id",
                new MapSqlParameterSource("id", license.id()));
        for (Map<String, Object> row : rows) {
            UUID existingSourceId = (UUID) row.get("source_id");
            String existingCode = (String) row.get("license_code");
            if (!Objects.equals(existingSourceId, license.sourceId())
                    || !Objects.equals(existingCode, license.licenseCode())) {
                throw new IllegalStateException("CONTENT_IDENTITY_CONFLICT: license " + license.id()
                        + " already exists with different attributes");
            }
        }
    }

    private void assertStableProvenanceIdentity(ProvenanceRecord provenance) {
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "SELECT source_id, license_id FROM exams.provenance_records WHERE id = :id",
                new MapSqlParameterSource("id", provenance.id()));
        for (Map<String, Object> row : rows) {
            UUID sourceId = (UUID) row.get("source_id");
            UUID licenseId = (UUID) row.get("license_id");
            if (!Objects.equals(sourceId, provenance.sourceId())
                    || !Objects.equals(licenseId, provenance.licenseId())) {
                throw new IllegalStateException("CONTENT_IDENTITY_CONFLICT: provenance " + provenance.id()
                        + " already exists with conflicting source/license");
            }
        }
    }

    private void assertStableCatalogNodeIdentity(CatalogNodeRecord node) {
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "SELECT family, variant, kind FROM exams.catalog_nodes WHERE id = :id",
                new MapSqlParameterSource("id", node.id()));
        for (Map<String, Object> row : rows) {
            String family = (String) row.get("family");
            String variant = (String) row.get("variant");
            String kind = (String) row.get("kind");
            if (!Objects.equals(family, node.family().name())
                    || !Objects.equals(variant, node.variant())
                    || !Objects.equals(kind, node.kind())) {
                throw new IllegalStateException("CONTENT_IDENTITY_CONFLICT: catalog node " + node.id()
                        + " already exists with conflicting family/variant/kind");
            }
        }
    }

    private void assertNoExistingId(String relation, UUID id, String label) {
        Long count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM " + relation + " WHERE id = :id",
                new MapSqlParameterSource("id", id), Long.class);
        if (count != null && count > 0) {
            throw new IllegalStateException("CONTENT_IDENTITY_CONFLICT: " + label + " id already exists");
        }
    }

    private void assertStableLogicalIdentity(String relation, String predicate, MapSqlParameterSource params,
                                             UUID expectedId, String label) {
        List<UUID> ids = jdbcTemplate.query("SELECT id FROM " + relation + " WHERE " + predicate, params,
                (rs, rowNum) -> (UUID) rs.getObject("id"));
        for (UUID existingId : ids) {
            if (!Objects.equals(existingId, expectedId)) {
                throw new IllegalStateException("CONTENT_IDENTITY_CONFLICT: " + label
                        + " already exists with a different stable id");
            }
        }
    }

    private void assertVersionedIdentity(String relation, String predicate, MapSqlParameterSource params,
                                         UUID expectedId, String expectedHash, String label) {
        String hashColumn = "exams.assets".equals(relation) ? "sha256_hash" : "content_hash";
        List<Map<String, Object>> rows = jdbcTemplate.queryForList(
                "SELECT id, " + hashColumn + " FROM " + relation + " WHERE " + predicate, params);
        for (Map<String, Object> row : rows) {
            UUID existingId = (UUID) row.get("id");
            String existingHash = row.get(hashColumn) == null ? null : row.get(hashColumn).toString();
            if (!Objects.equals(existingId, expectedId)
                    || !Objects.equals(normalizeHash(existingHash), normalizeHash(expectedHash))) {
                throw new IllegalStateException("CONTENT_IDENTITY_CONFLICT: " + label
                        + " already exists with a different id or content hash");
            }
        }
    }

    private String normalizeHash(String hash) {
        return hash == null ? null : hash.toLowerCase(Locale.ROOT);
    }

    public UUID insertPackageImport(ExamContentPackage.PackageManifest manifest, UUID formId, Long actorId, String status) {
        String sql = """
            INSERT INTO exams.content_package_imports
                (id, package_id, package_version, schema_version, content_hash, form_id, status,
                 imported_by, creator, validation_errors, created_at, completed_at)
            VALUES (:id, :packageId, :packageVersion, :schemaVersion, :contentHash, :formId, :status,
                    :actorId, :creator, '[]'::jsonb, clock_timestamp(),
                    CASE WHEN :status = 'IMPORTED' THEN clock_timestamp() ELSE NULL END)
            RETURNING id
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("id", UUID.randomUUID())
                .addValue("packageId", manifest.packageId())
                .addValue("packageVersion", manifest.packageVersion())
                .addValue("schemaVersion", manifest.schemaVersion())
                .addValue("contentHash", manifest.contentHash())
                .addValue("formId", formId)
                .addValue("status", status)
                .addValue("actorId", actorId)
                .addValue("creator", manifest.creator()), UUID.class);
    }

    /**
     * Exams Phase 4D.4 (V72): records the owner's project-use authorization of an imported package next to — never in
     * place of — the publisher licence rows. Source identity / provenance are copied verbatim (immutable); the display
     * name is recorded as it was at import time only.
     */
    @SuppressWarnings("unchecked")
    public void insertProjectUsageAuthorization(ExamContentPackage pkg, Long actorId, String importBasis) {
        Map<String, Object> metadata = ExamOwnerProductionAuthorization.BASIS.equals(importBasis)
                ? ExamOwnerProductionAuthorization.productionMetadata(pkg.manifest().metadata())
                : pkg.manifest().metadata();
        if (!(metadata.get("projectUsageAuthorization") instanceof Map<?, ?> rawAuth)) {
            throw new IllegalStateException("PROJECT_AUTHORIZATION_MISSING: package has no projectUsageAuthorization");
        }
        Map<String, Object> auth = (Map<String, Object>) rawAuth;
        UUID formProvenanceSource = pkg.provenances().stream()
                .filter(p -> p.id().equals(pkg.form().provenanceId())).map(ProvenanceRecord::sourceId).findFirst().orElse(null);
        UUID sourceId = formProvenanceSource != null ? formProvenanceSource : pkg.sources().stream()
                .filter(s -> "THIRD_PARTY_PUBLICATION".equals(s.sourceType())).map(SourceRecord::id).findFirst()
                .orElse(pkg.sources().isEmpty() ? null : pkg.sources().get(0).id());
        Object displayName = metadata.get("displayName") instanceof Map<?, ?> dn ? dn.get("current") : null;
        jdbcTemplate.update("""
            INSERT INTO exams.project_usage_authorizations
                (id, package_id, package_version, package_content_hash, form_id, source_id, status, scope, authorized_by,
                 decision_date, decision_ref, applies_to, permits, production_import, import_basis, publisher_licence,
                 publisher_endorsement, source_identity, source_provenance, display_name_at_import, recorded_by)
            VALUES (:id, :packageId, :packageVersion, :hash, :formId, :sourceId, :status, :scope, :authorizedBy,
                    CAST(:decisionDate AS DATE), :decisionRef, :appliesTo, :permits::jsonb, :productionImport, :basis,
                    :publisherLicence, FALSE, :sourceIdentity::jsonb, :sourceProvenance::jsonb, :displayName, :actorId)
        """, new MapSqlParameterSource()
                .addValue("id", UUID.randomUUID())
                .addValue("packageId", pkg.manifest().packageId())
                .addValue("packageVersion", pkg.manifest().packageVersion())
                .addValue("hash", pkg.manifest().contentHash())
                .addValue("formId", pkg.form().id())
                .addValue("sourceId", sourceId)
                .addValue("status", String.valueOf(auth.get("status")))
                .addValue("scope", String.valueOf(auth.get("scope")))
                .addValue("authorizedBy", String.valueOf(auth.get("authorizedBy")))
                .addValue("decisionDate", String.valueOf(auth.get("decisionDate")))
                .addValue("decisionRef", auth.get("decisionRef") != null ? String.valueOf(auth.get("decisionRef")) : null)
                .addValue("appliesTo", auth.get("appliesTo") != null ? String.valueOf(auth.get("appliesTo")) : null)
                .addValue("permits", toJson(auth.get("permits") != null ? auth.get("permits") : List.of()))
                .addValue("productionImport", String.valueOf(auth.get("productionImport")))
                .addValue("basis", importBasis)
                .addValue("publisherLicence", String.valueOf(auth.get("publisherLicence")))
                .addValue("sourceIdentity", toJson(metadata.getOrDefault("sourceIdentity", Map.of())))
                .addValue("sourceProvenance", toJson(metadata.getOrDefault("sourceProvenance", Map.of())))
                .addValue("displayName", displayName != null ? String.valueOf(displayName) : null)
                .addValue("actorId", actorId));
    }

    public void markPackageImported(UUID importId) {
        jdbcTemplate.update("""
            UPDATE exams.content_package_imports
            SET status = 'IMPORTED', completed_at = clock_timestamp()
            WHERE id = :id AND status = 'IMPORTING'
        """, new MapSqlParameterSource("id", importId));
    }

    public UUID insertQARun(UUID packageImportId, UUID formId, String checklistVersion, String result,
                            Map<String, Object> findings, Long actorId) {
        String sql = """
            INSERT INTO exams.content_qa_runs
                (id, package_import_id, form_id, checklist_version, result, findings, actor_id, created_at)
            VALUES (:id, :packageImportId, :formId, :checklistVersion, :result, :findings::jsonb, :actorId, clock_timestamp())
            RETURNING id
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("id", UUID.randomUUID())
                .addValue("packageImportId", packageImportId)
                .addValue("formId", formId)
                .addValue("checklistVersion", checklistVersion)
                .addValue("result", result)
                .addValue("findings", toJson(findings == null ? Map.of() : findings))
                .addValue("actorId", actorId), UUID.class);
    }

    public void insertAuditEvent(Long actorId, String action, String entityType, String entityId,
                                 String beforeHash, String afterHash, String reason, String requestId) {
        jdbcTemplate.update("""
            INSERT INTO exams.audit_events
                (id, actor_id, action, entity_type, entity_id, before_hash, after_hash, reason, request_id, created_at)
            VALUES (gen_random_uuid(), :actorId, :action, :entityType, :entityId, :beforeHash, :afterHash,
                    :reason, :requestId, clock_timestamp())
        """, new MapSqlParameterSource()
                .addValue("actorId", actorId).addValue("action", action).addValue("entityType", entityType)
                .addValue("entityId", entityId).addValue("beforeHash", beforeHash).addValue("afterHash", afterHash)
                .addValue("reason", reason).addValue("requestId", requestId));
    }

    public Optional<SpecificationVersionRecord> findSpecificationById(UUID specId) {
        String sql = "SELECT * FROM exams.specification_versions WHERE id = :id";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("id", specId), specRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Optional<ScoringSchemeVersionRecord> findScoringSchemeById(UUID schemeId) {
        String sql = "SELECT * FROM exams.scoring_scheme_versions WHERE id = :id";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("id", schemeId), schemeRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public List<SectionRecord> findSectionsByFormId(UUID formId) {
        String sql = "SELECT * FROM exams.sections WHERE form_id = :formId ORDER BY ordinal ASC";
        List<SectionRecord> direct = jdbcTemplate.query(sql, new MapSqlParameterSource("formId", formId), sectionRowMapper);
        if (!direct.isEmpty()) {
            return direct;
        }
        String compSql = """
            SELECT s.*
            FROM exams.form_components fc
            JOIN exams.sections s ON s.form_id = fc.child_form_id
            WHERE fc.parent_form_id = :formId
            ORDER BY fc.ordinal ASC, s.ordinal ASC
        """;
        return jdbcTemplate.query(compSql, new MapSqlParameterSource("formId", formId), sectionRowMapper);
    }

    public List<PartRecord> findPartsBySectionId(UUID sectionId) {
        String sql = "SELECT * FROM exams.parts WHERE section_id = :sectionId ORDER BY ordinal ASC";
        return jdbcTemplate.query(sql, new MapSqlParameterSource("sectionId", sectionId), partRowMapper);
    }

    public List<GroupVersionRecord> findGroupsByPartId(UUID partId) {
        String sql = """
            SELECT g.*
            FROM exams.form_groups fg
            JOIN exams.group_versions g ON fg.group_id = g.id
            WHERE fg.part_id = :partId
            ORDER BY fg.ordinal ASC
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("partId", partId), groupRowMapper);
    }

    /** Form placement of each group of a part (form_groups.ordinal / display_numbering), keyed by group id. */
    public record GroupPlacement(int ordinal, String displayNumbering) {}

    public Map<UUID, GroupPlacement> findGroupPlacementsByPartId(UUID partId) {
        Map<UUID, GroupPlacement> out = new LinkedHashMap<>();
        jdbcTemplate.query("SELECT group_id, ordinal, display_numbering FROM exams.form_groups WHERE part_id = :partId ORDER BY ordinal",
                new MapSqlParameterSource("partId", partId),
                rs -> { out.put((UUID) rs.getObject("group_id"), new GroupPlacement(rs.getInt("ordinal"), rs.getString("display_numbering"))); });
        return out;
    }

    public List<ItemVersionRecord> findItemsByGroupId(UUID groupId) {
        String sql = "SELECT * FROM exams.item_versions WHERE group_id = :groupId ORDER BY COALESCE(ordinal, 999999) ASC, id ASC";
        return jdbcTemplate.query(sql, new MapSqlParameterSource("groupId", groupId), itemRowMapper);
    }

    /** Single-RTT section item counts for getFormDetails (replaces 4-level N+1 section/part/group/item loops). */
    public Map<UUID, Integer> findSectionItemCountsByFormId(UUID formId) {
        String sql = """
            WITH form_scope AS (
                SELECT CAST(:formId AS uuid) AS eff_form_id
                UNION ALL
                SELECT fc.child_form_id FROM exams.form_components fc WHERE fc.parent_form_id = :formId
            )
            SELECT s.id AS section_id, COUNT(iv.id)::int AS item_count
            FROM form_scope fs
            JOIN exams.sections s ON s.form_id = fs.eff_form_id
            LEFT JOIN exams.parts p ON p.section_id = s.id
            LEFT JOIN exams.form_groups fg ON fg.part_id = p.id
            LEFT JOIN exams.item_versions iv ON iv.group_id = fg.group_id
            GROUP BY s.id
        """;
        Map<UUID, Integer> counts = new HashMap<>();
        jdbcTemplate.query(sql, new MapSqlParameterSource("formId", formId), rs -> {
            counts.put((UUID) rs.getObject("section_id"), rs.getInt("item_count"));
        });
        return counts;
    }

    public List<ItemVersionRecord> findItemsByFormId(UUID formId) {
        String sql = """
            WITH form_scope AS (
                SELECT CAST(:formId AS uuid) AS eff_form_id
                UNION ALL
                SELECT fc.child_form_id FROM exams.form_components fc WHERE fc.parent_form_id = :formId
            )
            SELECT iv.*
            FROM form_scope fs
            JOIN exams.sections s ON s.form_id = fs.eff_form_id
            JOIN exams.parts p ON s.id = p.section_id
            JOIN exams.form_groups fg ON p.id = fg.part_id
            JOIN exams.item_versions iv ON fg.group_id = iv.group_id
            ORDER BY s.ordinal ASC, p.ordinal ASC, fg.ordinal ASC, COALESCE(iv.ordinal, 999999) ASC, iv.id ASC
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("formId", formId), itemRowMapper);
    }

    public Map<UUID, SkillType> findItemSkillsByFormId(UUID formId) {
        String sql = """
            WITH form_scope AS (
                SELECT CAST(:formId AS uuid) AS eff_form_id
                UNION ALL
                SELECT fc.child_form_id FROM exams.form_components fc WHERE fc.parent_form_id = :formId
            )
            SELECT iv.id AS item_id, s.skill
            FROM form_scope fs
            JOIN exams.sections s ON s.form_id = fs.eff_form_id
            JOIN exams.parts p ON s.id = p.section_id
            JOIN exams.form_groups fg ON p.id = fg.part_id
            JOIN exams.item_versions iv ON fg.group_id = iv.group_id
        """;
        Map<UUID, SkillType> map = new HashMap<>();
        jdbcTemplate.query(sql, new MapSqlParameterSource("formId", formId), rs -> {
            map.put((UUID) rs.getObject("item_id"), SkillType.valueOf(rs.getString("skill")));
        });
        return map;
    }

    public List<StimulusVersionRecord> findStimuliByGroupId(UUID groupId) {
        String sql = """
            SELECT s.*
            FROM exams.group_stimuli gs
            JOIN exams.stimulus_versions s ON gs.stimulus_id = s.id
            WHERE gs.group_id = :groupId
            ORDER BY gs.ordinal ASC
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("groupId", groupId), stimulusRowMapper);
    }

    public List<PublicAssetRefDto> findAssetsByStimulusId(UUID stimulusId) {
        String sql = """
            SELECT a.id as asset_id, sa.role, a.mime_type, a.duration_ms
            FROM exams.stimulus_assets sa
            JOIN exams.assets a ON sa.asset_id = a.id
            WHERE sa.stimulus_id = :stimulusId
            ORDER BY sa.ordinal ASC
        """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("stimulusId", stimulusId),
                (rs, rowNum) -> new PublicAssetRefDto(
                        (UUID) rs.getObject("asset_id"),
                        rs.getString("role"),
                        rs.getString("mime_type"),
                        (Integer) rs.getObject("duration_ms")
                ));
    }

    public Integer findTotalAudioDurationMsBySectionId(UUID sectionId) {
        String sql = """
            SELECT COALESCE(SUM(a.duration_ms), 0)
            FROM exams.parts p
            JOIN exams.form_groups fg ON fg.part_id = p.id
            JOIN exams.group_stimuli gs ON gs.group_id = fg.group_id
            JOIN exams.stimulus_assets sa ON sa.stimulus_id = gs.stimulus_id
            JOIN exams.assets a ON a.id = sa.asset_id
            WHERE p.section_id = :sectionId
              AND (a.mime_type LIKE 'audio%' OR sa.role = 'PRIMARY')
        """;
        try {
            return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource("sectionId", sectionId), Integer.class);
        } catch (Exception e) {
            return null;
        }
    }

    public Optional<AnswerSpecRecord> findAnswerSpecByItemId(UUID itemId) {
        String sql = "SELECT * FROM exams.answer_specs WHERE item_id = :itemId";
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject(sql,
                    new MapSqlParameterSource("itemId", itemId), answerSpecRowMapper));
        } catch (EmptyResultDataAccessException e) {
            return Optional.empty();
        }
    }

    public Map<UUID, AnswerSpecRecord> findAnswerSpecsByFormId(UUID formId) {
        String sql = """
            WITH form_scope AS (
                SELECT CAST(:formId AS uuid) AS eff_form_id
                UNION ALL
                SELECT fc.child_form_id FROM exams.form_components fc WHERE fc.parent_form_id = :formId
            )
            SELECT ans.*
            FROM form_scope fs
            JOIN exams.sections s ON s.form_id = fs.eff_form_id
            JOIN exams.parts p ON s.id = p.section_id
            JOIN exams.form_groups fg ON p.id = fg.part_id
            JOIN exams.item_versions iv ON fg.group_id = iv.group_id
            JOIN exams.answer_specs ans ON iv.id = ans.item_id
        """;
        List<AnswerSpecRecord> list = jdbcTemplate.query(sql,
                new MapSqlParameterSource("formId", formId), answerSpecRowMapper);
        Map<UUID, AnswerSpecRecord> map = new HashMap<>();
        for (AnswerSpecRecord spec : list) {
            map.put(spec.itemId(), spec);
        }
        return map;
    }

    public Map<UUID, AnswerSpecRecord> findAnswerSpecsBySectionId(UUID sectionId) {
        String sql = """
            SELECT ans.*
            FROM exams.sections s
            JOIN exams.parts p ON s.id = p.section_id
            JOIN exams.form_groups fg ON p.id = fg.part_id
            JOIN exams.item_versions iv ON fg.group_id = iv.group_id
            JOIN exams.answer_specs ans ON iv.id = ans.item_id
            WHERE s.id = :sectionId
        """;
        List<AnswerSpecRecord> list = jdbcTemplate.query(sql,
                new MapSqlParameterSource("sectionId", sectionId), answerSpecRowMapper);
        Map<UUID, AnswerSpecRecord> map = new HashMap<>();
        for (AnswerSpecRecord spec : list) {
            map.put(spec.itemId(), spec);
        }
        return map;
    }

    public Set<UUID> findItemIdsBySectionId(UUID sectionId) {
        String sql = """
            SELECT iv.id
            FROM exams.sections s
            JOIN exams.parts p ON s.id = p.section_id
            JOIN exams.form_groups fg ON p.id = fg.part_id
            JOIN exams.item_versions iv ON fg.group_id = iv.group_id
            WHERE s.id = :sectionId
        """;
        List<UUID> list = jdbcTemplate.query(sql,
                new MapSqlParameterSource("sectionId", sectionId),
                (rs, rowNum) -> rs.getObject("id", UUID.class));
        return new HashSet<>(list);
    }

    // ─── Insert Operations (Content Administration) ───────────────────────────

    public UUID insertProvenance(ProvenanceRecord provenance) {
        UUID id = provenance.id() != null ? provenance.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.provenance_records
                (id, source_id, license_id, creator, acquisition_method, original_reference,
                 derivative_parent_id, ai_generation_meta, created_at)
            VALUES (:id, :sourceId, :licenseId, :creator, :acquisitionMethod, :originalReference,
                    :derivativeParentId, :aiGenerationMeta::jsonb, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET creator = EXCLUDED.creator
            RETURNING id
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("id", id).addValue("sourceId", provenance.sourceId())
                .addValue("licenseId", provenance.licenseId()).addValue("creator", provenance.creator())
                .addValue("acquisitionMethod", provenance.acquisitionMethod())
                .addValue("originalReference", provenance.originalReference())
                .addValue("derivativeParentId", provenance.derivativeParentId())
                .addValue("aiGenerationMeta", toJson(provenance.aiGenerationMeta())), UUID.class);
    }

    public UUID insertCatalogNode(CatalogNodeRecord node) {
        UUID id = node.id() != null ? node.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.catalog_nodes
                (id, family, variant, source_id, parent_id, kind, title, year, ordinal, retired_at, created_at)
            VALUES (:id, :family, :variant, :sourceId, :parentId, :kind, :title, :year, :ordinal, :retiredAt, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title
            RETURNING id
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("id", id).addValue("family", node.family().name()).addValue("variant", node.variant())
                .addValue("sourceId", node.sourceId()).addValue("parentId", node.parentId())
                .addValue("kind", node.kind()).addValue("title", node.title()).addValue("year", node.year())
                .addValue("ordinal", node.ordinal())
                .addValue("retiredAt", node.retiredAt() == null ? null : Timestamp.from(node.retiredAt())), UUID.class);
    }

    public UUID insertRubric(RubricVersionRecord rubric) {
        UUID id = rubric.id() != null ? rubric.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.rubric_versions AS current_rubric
                (id, logical_code, version, family, skill, task_family, criteria, ordinal_scale,
                 provenance_id, content_hash, approved_at, created_at)
            VALUES (:id, :logicalCode, :version, :family, :skill, :taskFamily, :criteria::jsonb,
                    :ordinalScale::jsonb, :provenanceId, :contentHash, :approvedAt, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET content_hash = EXCLUDED.content_hash
            RETURNING id
        """;
        return jdbcTemplate.queryForObject(sql, new MapSqlParameterSource()
                .addValue("id", id).addValue("logicalCode", rubric.logicalCode()).addValue("version", rubric.version())
                .addValue("family", rubric.family().name()).addValue("skill", rubric.skill())
                .addValue("taskFamily", rubric.taskFamily()).addValue("criteria", toJson(rubric.criteria()))
                .addValue("ordinalScale", toJson(rubric.ordinalScale())).addValue("provenanceId", rubric.provenanceId())
                .addValue("contentHash", rubric.contentHash())
                .addValue("approvedAt", rubric.approvedAt() == null ? null : Timestamp.from(rubric.approvedAt())), UUID.class);
    }

    public void insertFormComponent(FormComponentPlacement component) {
        String sql = """
            INSERT INTO exams.form_components (id, parent_form_id, child_form_id, role, ordinal)
            VALUES (:id, :parentFormId, :childFormId, :role, :ordinal)
            ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", component.id()).addValue("parentFormId", component.parentFormId())
                .addValue("childFormId", component.childFormId()).addValue("role", component.role())
                .addValue("ordinal", component.ordinal()));
    }

    public void insertPackageFormGroup(FormGroupPlacement placement) {
        String sql = """
            INSERT INTO exams.form_groups (id, part_id, group_id, ordinal, display_numbering)
            VALUES (:id, :partId, :groupId, :ordinal, :displayNumbering)
            ON CONFLICT (id) DO UPDATE SET display_numbering = EXCLUDED.display_numbering
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", placement.id()).addValue("partId", placement.partId())
                .addValue("groupId", placement.groupId()).addValue("ordinal", placement.ordinal())
                .addValue("displayNumbering", placement.displayNumbering()));
    }

    public void insertPackageGroupStimulus(GroupStimulusPlacement placement) {
        String sql = """
            INSERT INTO exams.group_stimuli (id, group_id, stimulus_id, role, ordinal)
            VALUES (:id, :groupId, :stimulusId, :role, :ordinal)
            ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", placement.id()).addValue("groupId", placement.groupId())
                .addValue("stimulusId", placement.stimulusId()).addValue("role", placement.role())
                .addValue("ordinal", placement.ordinal()));
    }

    public void insertStimulusAsset(StimulusAssetPlacement placement) {
        String sql = """
            INSERT INTO exams.stimulus_assets (id, stimulus_id, asset_id, role, ordinal)
            VALUES (:id, :stimulusId, :assetId, :role, :ordinal)
            ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", placement.id()).addValue("stimulusId", placement.stimulusId())
                .addValue("assetId", placement.assetId()).addValue("role", placement.role())
                .addValue("ordinal", placement.ordinal()));
    }

    public UUID insertSource(SourceRecord source) {
        UUID id = source.id() != null ? source.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.sources AS current_source (id, code, name, owner, publisher, source_type, reference_meta, created_at)
            VALUES (:id, :code, :name, :owner, :publisher, :sourceType, :referenceMeta::jsonb, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("code", source.code())
                .addValue("name", source.name())
                .addValue("owner", source.owner())
                .addValue("publisher", source.publisher())
                .addValue("sourceType", source.sourceType())
                .addValue("referenceMeta", toJson(source.referenceMeta()));
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public UUID insertLicense(LicenseRecord license) {
        UUID id = license.id() != null ? license.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.licenses AS current_license (id, source_id, license_code, provenance_category, commercial_rights,
                redistribution_rights, derivative_rights, permitted_purposes, permitted_territories,
                valid_from, valid_until, attribution, evidence_asset_id, legal_status, created_at)
            VALUES (:id, :sourceId, :licenseCode, :provCat, :commRights, :redistRights, :derivRights,
                :purposes::jsonb, :territories::jsonb, :validFrom, :validUntil, :attribution, :evidenceAssetId,
                :legalStatus, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET legal_status = EXCLUDED.legal_status
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("sourceId", license.sourceId())
                .addValue("licenseCode", license.licenseCode())
                .addValue("provCat", license.provenanceCategory().name())
                .addValue("commRights", license.commercialRights())
                .addValue("redistRights", license.redistributionRights())
                .addValue("derivRights", license.derivativeRights())
                .addValue("purposes", toJson(license.permittedPurposes()))
                .addValue("territories", toJson(license.permittedTerritories()))
                .addValue("validFrom", license.validFrom() != null ? Timestamp.from(license.validFrom()) : null)
                .addValue("validUntil", license.validUntil() != null ? Timestamp.from(license.validUntil()) : null)
                .addValue("attribution", license.attribution())
                .addValue("evidenceAssetId", license.evidenceAssetId())
                .addValue("legalStatus", license.legalStatus());
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public UUID insertSpecification(SpecificationVersionRecord spec) {
        UUID id = spec.id() != null ? spec.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.specification_versions AS current_spec (id, logical_code, version, family, variant, delivery_mode,
                blueprint, timing_policy, navigation_policy, playback_policy, source_references, content_hash,
                approved_at, created_at)
            VALUES (:id, :logicalCode, :version, :family, :variant, :deliveryMode,
                :blueprint::jsonb, :timingPolicy::jsonb, :navigationPolicy::jsonb, :playbackPolicy::jsonb,
                :sourceReferences::jsonb, :contentHash, :approvedAt, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET content_hash = EXCLUDED.content_hash
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("logicalCode", spec.logicalCode())
                .addValue("version", spec.version())
                .addValue("family", spec.family().name())
                .addValue("variant", spec.variant())
                .addValue("deliveryMode", spec.deliveryMode())
                .addValue("blueprint", toJson(spec.blueprint()))
                .addValue("timingPolicy", toJson(spec.timingPolicy()))
                .addValue("navigationPolicy", toJson(spec.navigationPolicy()))
                .addValue("playbackPolicy", toJson(spec.playbackPolicy()))
                .addValue("sourceReferences", toJson(spec.sourceReferences()))
                .addValue("contentHash", spec.contentHash())
                .addValue("approvedAt", spec.approvedAt() != null ? Timestamp.from(spec.approvedAt()) : null);
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public UUID insertCalibration(CalibrationVersionRecord calib) {
        UUID id = calib.id() != null ? calib.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.calibration_versions AS current_calibration (id, logical_code, version, method, maturity_stage,
                population_desc, sample_meta, comparison_group, validation_report, uncertainty_model,
                approved_at, created_at)
            VALUES (:id, :logicalCode, :version, :method, :maturityStage, :popDesc, :sampleMeta::jsonb,
                :compGroup, :valReport, :uncModel::jsonb, :approvedAt, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET method = EXCLUDED.method
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("logicalCode", calib.logicalCode())
                .addValue("version", calib.version())
                .addValue("method", calib.method())
                .addValue("maturityStage", calib.maturityStage())
                .addValue("popDesc", calib.populationDesc())
                .addValue("sampleMeta", toJson(calib.sampleMeta()))
                .addValue("compGroup", calib.comparisonGroup())
                .addValue("valReport", calib.validationReport())
                .addValue("uncModel", toJson(calib.uncertaintyModel()))
                .addValue("approvedAt", calib.approvedAt() != null ? Timestamp.from(calib.approvedAt()) : null);
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public UUID insertScoringScheme(ScoringSchemeVersionRecord scheme) {
        UUID id = scheme.id() != null ? scheme.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.scoring_scheme_versions AS current_scheme (id, logical_code, version, family, variant, scope,
                normalization_version, rubric_references, calibration_id, mapping_table, aggregation_rules,
                content_hash, approved_at, created_at)
            VALUES (:id, :logicalCode, :version, :family, :variant, :scope, :normVer,
                :rubricRefs::jsonb, :calibId, :mappingTable::jsonb, :aggRules::jsonb,
                :contentHash, :approvedAt, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET content_hash = EXCLUDED.content_hash
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("logicalCode", scheme.logicalCode())
                .addValue("version", scheme.version())
                .addValue("family", scheme.family().name())
                .addValue("variant", scheme.variant())
                .addValue("scope", scheme.scope())
                .addValue("normVer", scheme.normalizationVersion())
                .addValue("rubricRefs", toJson(scheme.rubricReferences()))
                .addValue("calibId", scheme.calibrationId())
                .addValue("mappingTable", toJson(scheme.mappingTable()))
                .addValue("aggRules", toJson(scheme.aggregationRules()))
                .addValue("contentHash", scheme.contentHash())
                .addValue("approvedAt", scheme.approvedAt() != null ? Timestamp.from(scheme.approvedAt()) : null);
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public UUID insertFormVersion(FormVersionRecord form) {
        UUID id = form.id() != null ? form.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.form_versions (id, logical_key, version, title, family, variant, scope,
                catalog_node_id, specification_id, scoring_scheme_id, lifecycle_state, provenance_id,
                author_id, content_hash, published_at, retired_at, created_at)
            VALUES (:id, :logicalKey, :version, :title, :family, :variant, :scope,
                :catalogNodeId, :specId, :schemeId, :lifecycleState, :provenanceId,
                :authorId, :contentHash, :publishedAt, :retiredAt, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET lifecycle_state = EXCLUDED.lifecycle_state,
                published_at = EXCLUDED.published_at
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("logicalKey", form.logicalKey())
                .addValue("version", form.version())
                .addValue("title", form.title())
                .addValue("family", form.family().name())
                .addValue("variant", form.variant())
                .addValue("scope", form.scope())
                .addValue("catalogNodeId", form.catalogNodeId())
                .addValue("specId", form.specificationId())
                .addValue("schemeId", form.scoringSchemeId())
                .addValue("lifecycleState", form.lifecycleState().name())
                .addValue("provenanceId", form.provenanceId())
                .addValue("authorId", form.authorId())
                .addValue("contentHash", form.contentHash())
                .addValue("publishedAt", form.publishedAt() != null ? Timestamp.from(form.publishedAt()) : null)
                .addValue("retiredAt", form.retiredAt() != null ? Timestamp.from(form.retiredAt()) : null);
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public UUID insertSection(SectionRecord section) {
        UUID id = section.id() != null ? section.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.sections (id, form_id, skill, ordinal, spec_section_key, scoring_scheme_id,
                duration_seconds, timing_policy)
            VALUES (:id, :formId, :skill, :ordinal, :specSectionKey, :scoringSchemeId,
                :durationSeconds, :timingPolicy::jsonb)
            ON CONFLICT (id) DO UPDATE SET duration_seconds = EXCLUDED.duration_seconds
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("formId", section.formId())
                .addValue("skill", section.skill().name())
                .addValue("ordinal", section.ordinal())
                .addValue("specSectionKey", section.specSectionKey())
                .addValue("scoringSchemeId", section.scoringSchemeId())
                .addValue("durationSeconds", section.durationSeconds())
                .addValue("timingPolicy", toJson(section.timingPolicy()));
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public UUID insertPart(PartRecord part) {
        UUID id = part.id() != null ? part.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.parts (id, section_id, part_code, ordinal, instructions, timing_policy)
            VALUES (:id, :sectionId, :partCode, :ordinal, :instructions, :timingPolicy::jsonb)
            ON CONFLICT (id) DO UPDATE SET instructions = EXCLUDED.instructions
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("sectionId", part.sectionId())
                .addValue("partCode", part.partCode())
                .addValue("ordinal", part.ordinal())
                .addValue("instructions", part.instructions())
                .addValue("timingPolicy", toJson(part.timingPolicy()));
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public UUID insertGroup(GroupVersionRecord group) {
        UUID id = group.id() != null ? group.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.group_versions AS current_group (id, logical_group_key, version, question_type, construct,
                skill, topic, difficulty_estimate, provenance_id, content_hash, created_at)
            VALUES (:id, :logicalKey, :version, :questionType, :construct, :skill, :topic,
                :difficultyEstimate, :provenanceId, :contentHash, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET content_hash = EXCLUDED.content_hash
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("logicalKey", group.logicalGroupKey())
                .addValue("version", group.version())
                .addValue("questionType", group.questionType())
                .addValue("construct", group.construct())
                .addValue("skill", group.skill().name())
                .addValue("topic", group.topic())
                .addValue("difficultyEstimate", group.difficultyEstimate())
                .addValue("provenanceId", group.provenanceId())
                .addValue("contentHash", group.contentHash());
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public void insertFormGroup(UUID partId, UUID groupId, int ordinal, String displayNumbering) {
        String sql = """
            INSERT INTO exams.form_groups (id, part_id, group_id, ordinal, display_numbering)
            VALUES (gen_random_uuid(), :partId, :groupId, :ordinal, :displayNumbering)
            ON CONFLICT (part_id, ordinal) DO UPDATE SET group_id = EXCLUDED.group_id
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("partId", partId)
                .addValue("groupId", groupId)
                .addValue("ordinal", ordinal)
                .addValue("displayNumbering", displayNumbering));
    }

    public UUID insertStimulus(StimulusVersionRecord stimulus) {
        UUID id = stimulus.id() != null ? stimulus.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.stimulus_versions AS current_stimulus (id, logical_stimulus_key, version, kind, title,
                body_payload, provenance_id, content_hash, created_at)
            VALUES (:id, :logicalKey, :version, :kind, :title, :bodyPayload::jsonb,
                :provenanceId, :contentHash, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET content_hash = EXCLUDED.content_hash
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("logicalKey", stimulus.logicalStimulusKey())
                .addValue("version", stimulus.version())
                .addValue("kind", stimulus.kind())
                .addValue("title", stimulus.title())
                .addValue("bodyPayload", toJson(stimulus.bodyPayload()))
                .addValue("provenanceId", stimulus.provenanceId())
                .addValue("contentHash", stimulus.contentHash());
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public void insertGroupStimulus(UUID groupId, UUID stimulusId, String role, int ordinal) {
        String sql = """
            INSERT INTO exams.group_stimuli (id, group_id, stimulus_id, role, ordinal)
            VALUES (gen_random_uuid(), :groupId, :stimulusId, :role, :ordinal)
            ON CONFLICT (group_id, role, ordinal) DO UPDATE SET stimulus_id = EXCLUDED.stimulus_id
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("groupId", groupId)
                .addValue("stimulusId", stimulusId)
                .addValue("role", role)
                .addValue("ordinal", ordinal));
    }

    public UUID insertItem(ItemVersionRecord item) {
        UUID id = item.id() != null ? item.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.item_versions AS current_item (id, group_id, logical_item_key, version, prompt,
                interaction_type, option_definitions, construct, provenance_id, content_hash, created_at, ordinal)
            VALUES (:id, :groupId, :logicalKey, :version, :prompt, :interactionType,
                :optionDefs::jsonb, :construct, :provenanceId, :contentHash, clock_timestamp(), :ordinal)
            ON CONFLICT (id) DO UPDATE SET prompt = EXCLUDED.prompt, ordinal = COALESCE(EXCLUDED.ordinal, current_item.ordinal)
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("groupId", item.groupId())
                .addValue("logicalKey", item.logicalItemKey())
                .addValue("version", item.version())
                .addValue("prompt", item.prompt())
                .addValue("interactionType", item.interactionType())
                .addValue("optionDefs", toJson(item.optionDefinitions()))
                .addValue("construct", item.construct())
                .addValue("provenanceId", item.provenanceId())
                .addValue("contentHash", item.contentHash())
                .addValue("ordinal", item.ordinal());
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public void insertAnswerSpec(AnswerSpecRecord spec) {
        UUID id = spec.id() != null ? spec.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.answer_specs (id, item_id, accepted_answers, normalization_policy,
                cardinality, word_limit, credit_units, explanation, rubric_id, created_at)
            VALUES (:id, :itemId, :acceptedAnswers::jsonb, :normPolicy::jsonb, :cardinality,
                :wordLimit, :creditUnits, :explanation, :rubricId, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET accepted_answers = EXCLUDED.accepted_answers,
                explanation = EXCLUDED.explanation
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("itemId", spec.itemId())
                .addValue("acceptedAnswers", toJson(spec.acceptedAnswers()))
                .addValue("normPolicy", toJson(spec.normalizationPolicy()))
                .addValue("cardinality", spec.cardinality())
                .addValue("wordLimit", spec.wordLimit())
                .addValue("creditUnits", spec.creditUnits())
                .addValue("explanation", spec.explanation())
                .addValue("rubricId", spec.rubricId()));
    }

    public UUID insertAsset(AssetRecord asset) {
        UUID id = asset.id() != null ? asset.id() : UUID.randomUUID();
        String sql = """
            INSERT INTO exams.assets AS current_asset (id, provenance_id, object_key, version_id, sha256_hash, mime_type,
                byte_size, duration_ms, dimensions, validation_state, created_at)
            VALUES (:id, :provenanceId, :objectKey, :versionId, :sha256Hash, :mimeType,
                :byteSize, :durationMs, :dimensions, :validationState, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET sha256_hash = EXCLUDED.sha256_hash
            RETURNING id
        """;
        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("id", id)
                .addValue("provenanceId", asset.provenanceId())
                .addValue("objectKey", asset.objectKey())
                .addValue("versionId", asset.versionId())
                .addValue("sha256Hash", asset.sha256Hash())
                .addValue("mimeType", asset.mimeType())
                .addValue("byteSize", asset.byteSize())
                .addValue("durationMs", asset.durationMs())
                .addValue("dimensions", asset.dimensions())
                .addValue("validationState", asset.validationState());
        return jdbcTemplate.queryForObject(sql, params, UUID.class);
    }

    public void insertContentReview(UUID formId, ReviewGate gate, Long reviewerId, ReviewDecision decision,
                                    String hash, String notes) {
        String sql = """
            INSERT INTO exams.content_reviews (id, form_id, gate, reviewer_user_id, decision,
                reviewed_closure_hash, notes, created_at)
            VALUES (gen_random_uuid(), :formId, :gate, :reviewerId, :decision, :hash, :notes, clock_timestamp())
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("formId", formId)
                .addValue("gate", gate.name())
                .addValue("reviewerId", reviewerId)
                .addValue("decision", decision.name())
                .addValue("hash", hash)
                .addValue("notes", notes));
    }

    public void updateFormLifecycle(UUID formId, LifecycleState state, Instant publishedAt, Instant retiredAt) {
        String sql = """
            UPDATE exams.form_versions
            SET lifecycle_state = :state,
                published_at = COALESCE(:publishedAt, published_at),
                retired_at = COALESCE(:retiredAt, retired_at)
            WHERE id = :formId
        """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("formId", formId)
                .addValue("state", state.name())
                .addValue("publishedAt", publishedAt != null ? Timestamp.from(publishedAt) : null)
                .addValue("retiredAt", retiredAt != null ? Timestamp.from(retiredAt) : null));
    }
}
