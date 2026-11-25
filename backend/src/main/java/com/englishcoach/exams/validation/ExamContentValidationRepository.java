package com.englishcoach.exams.validation;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.validation.ExamContentTree.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.*;

/**
 * Read-only loader of the canonical {@link ExamContentTree} for one form (its own sections plus the sections of
 * its component forms) and the store of persisted validation results ({@code exams.form_content_validations},
 * V71). Four ordered queries per bounded batch; no per-form or per-item round trips.
 */
@Repository
@RequiredArgsConstructor
public class ExamContentValidationRepository {

    private static final String FORM_SECTIONS_CTE = """
            WITH secs AS (
                SELECT s.form_id AS root_id, s.id, s.form_id, s.skill, s.ordinal, s.duration_seconds, s.is_runnable,
                       NULL::varchar AS component_health, 0 AS component_ordinal
                FROM exams.sections s WHERE s.form_id IN (:formIds)
                UNION ALL
                SELECT fc.parent_form_id AS root_id, s.id, s.form_id, s.skill, s.ordinal, s.duration_seconds, s.is_runnable,
                       cf.primary_health_status, fc.ordinal + 1
                FROM exams.form_components fc
                JOIN exams.form_versions cf ON cf.id = fc.child_form_id
                JOIN exams.sections s ON s.form_id = fc.child_form_id
                WHERE fc.parent_form_id IN (:formIds)
            )
            """;

    private final NamedParameterJdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public record CatalogInput(String revision, ExamCatalogStructuralSummary persisted) {}

    /** Hash every canonical validation input on the DB, returning only hashes and small audit summaries.
     * Extra stored item/answer fields conservatively invalidate; licence/publication facts stay outside this key.
     * SHA-256 is a freshness key, never a replacement for the canonical validator's content fingerprint.
     */
    public Map<UUID, CatalogInput> catalogInputs(Collection<UUID> ids) {
        if (ids.isEmpty()) return Map.of();
        var p = new MapSqlParameterSource("formIds", ids).addValue("validator", ExamFormValidator.VALIDATOR_VERSION);
        Map<UUID, CatalogInput> out = new LinkedHashMap<>();
        jdbc.query(FORM_SECTIONS_CTE + """
                , nodes AS (
                    SELECT f.id root_id, jsonb_build_array('F',f.id,f.version,f.content_hash,f.family,f.variant,f.scope,
                        f.primary_health_status,f.scoring_scheme_id IS NOT NULL,sp.blueprint)::text node
                    FROM exams.form_versions f LEFT JOIN exams.specification_versions sp ON sp.id=f.specification_id
                    WHERE f.id IN (:formIds)
                    UNION ALL
                    SELECT root_id, jsonb_build_array('S',id,form_id,skill,ordinal,duration_seconds,
                        is_runnable,component_health,component_ordinal)::text FROM secs
                    UNION ALL
                    SELECT sc.root_id, jsonb_build_array('P',p.id,p.section_id,p.part_code,p.ordinal)::text
                    FROM secs sc JOIN exams.parts p ON p.section_id=sc.id
                    UNION ALL
                    SELECT sc.root_id, jsonb_build_array('I',fg.id,fg.part_id,fg.group_id,fg.ordinal,
                        fg.display_numbering,to_jsonb(iv),to_jsonb(a))::text
                    FROM secs sc JOIN exams.parts p ON p.section_id=sc.id
                    JOIN exams.form_groups fg ON fg.part_id=p.id
                    LEFT JOIN exams.item_versions iv ON iv.group_id=fg.group_id
                    LEFT JOIN exams.answer_specs a ON a.item_id=iv.id
                    UNION ALL
                    SELECT sc.root_id, jsonb_build_array('ST',fg.id,gs.ordinal,sv.id,sv.kind,
                        (sv.body_payload IS NOT NULL AND sv.body_payload::text NOT IN ('{}','null','[]')),
                        ast.id,ast.mime_type,ast.validation_state)::text
                    FROM secs sc JOIN exams.parts p ON p.section_id=sc.id
                    JOIN exams.form_groups fg ON fg.part_id=p.id
                    JOIN exams.group_stimuli gs ON gs.group_id=fg.group_id
                    JOIN exams.stimulus_versions sv ON sv.id=gs.stimulus_id
                    LEFT JOIN exams.stimulus_assets sa ON sa.stimulus_id=sv.id
                    LEFT JOIN exams.assets ast ON ast.id=sa.asset_id
                ), digests AS (
                    SELECT root_id, encode(sha256(convert_to(node,'UTF8')),'hex') hash FROM nodes
                ), revisions AS (
                    SELECT root_id, encode(sha256(convert_to(string_agg(hash,'' ORDER BY hash),'UTF8')),'hex') revision
                    FROM digests GROUP BY root_id
                )
                SELECT r.root_id,r.revision,v.content_fingerprint,v.report->'catalogSummary' AS summary
                FROM revisions r LEFT JOIN LATERAL (
                    SELECT content_fingerprint,report FROM exams.form_content_validations
                    WHERE form_id=r.root_id AND validator_version=:validator
                        AND report->'catalogSummary'->>'inputRevision'=r.revision
                    ORDER BY evaluated_at DESC LIMIT 1
                ) v ON TRUE
                """, p, (ResultSet rs) -> {
            UUID id = (UUID) rs.getObject("root_id");
            String revision = rs.getString("revision");
            ExamCatalogStructuralSummary summary = null;
            try {
                String raw = rs.getString("summary");
                if (raw != null && raw.length() <= 64 * 1024) {
                    var parsed = objectMapper.readValue(raw, ExamCatalogStructuralSummary.class);
                    if (parsed.matches(id, revision) && parsed.contentFingerprint().equals(rs.getString("content_fingerprint"))) summary = parsed;
                }
            } catch (Exception ignored) { /* Malformed or old audit data is a miss, never a grant. */ }
            out.put(id, new CatalogInput(revision, summary));
        });
        return out;
    }

    public Optional<ExamContentTree> loadTree(UUID formId) {
        return Optional.ofNullable(loadTrees(List.of(formId)).get(formId));
    }

    /** Empty when the form does not exist. Any SQL error propagates (the service fails closed). */
    public Map<UUID, ExamContentTree> loadTrees(Collection<UUID> formIds) {
        if (formIds.isEmpty()) return Map.of();
        MapSqlParameterSource p = new MapSqlParameterSource("formIds", formIds);
        List<Map<String, Object>> forms = jdbc.queryForList("""
                SELECT f.id, f.family, f.variant, f.scope, f.primary_health_status, f.scoring_scheme_id, sp.blueprint::text AS blueprint
                FROM exams.form_versions f
                LEFT JOIN exams.specification_versions sp ON sp.id = f.specification_id
                WHERE f.id IN (:formIds)
                """, p);
        if (forms.isEmpty()) return Map.of();

        record SectionRow(UUID rootId, UUID id, UUID formId, SkillType skill, int ordinal, int duration, Boolean enabled, String health, int comp) {}
        List<SectionRow> sectionRows = jdbc.query(FORM_SECTIONS_CTE + """
                SELECT root_id, id, form_id, skill, ordinal, duration_seconds, is_runnable, component_health, component_ordinal
                FROM secs ORDER BY root_id, component_ordinal, ordinal, id
                """, p, (rs, n) -> new SectionRow((UUID) rs.getObject("root_id"), (UUID) rs.getObject("id"), (UUID) rs.getObject("form_id"),
                SkillType.valueOf(rs.getString("skill")), rs.getInt("ordinal"), rs.getInt("duration_seconds"),
                (Boolean) rs.getObject("is_runnable"), rs.getString("component_health"), rs.getInt("component_ordinal")));

        record PartRow(UUID sectionId, UUID partId, String partCode, int partOrdinal) {}
        record PlacementRow(UUID partId, UUID placementId, UUID groupId, int ordinal, String displayNumbering) {}
        Map<UUID, PartRow> parts = new LinkedHashMap<>();
        Map<UUID, PlacementRow> placements = new LinkedHashMap<>();
        Map<UUID, List<ItemNode>> itemsByPlacement = new HashMap<>();
        jdbc.query(FORM_SECTIONS_CTE + """
                , scoped_items AS (
                    SELECT sc.ordinal AS sec_ordinal, p.section_id, p.id AS part_id, p.part_code, p.ordinal AS part_ordinal,
                           fg.id AS placement_id, fg.group_id, fg.ordinal AS group_ordinal, fg.display_numbering,
                           iv.id AS item_id, iv.logical_item_key, iv.ordinal AS item_ordinal, iv.prompt, iv.interaction_type,
                           iv.option_definitions::text AS option_definitions
                    FROM (SELECT DISTINCT id, ordinal FROM secs) sc
                    JOIN exams.parts p ON p.section_id = sc.id
                    LEFT JOIN exams.form_groups fg ON fg.part_id = p.id
                    LEFT JOIN exams.item_versions iv ON iv.group_id = fg.group_id
                ),
                ans_ranked AS (
                    SELECT a.item_id, a.id, a.accepted_answers, a.cardinality, a.word_limit, a.rubric_id,
                           COUNT(*) OVER (PARTITION BY a.item_id) AS answer_count,
                           ROW_NUMBER() OVER (PARTITION BY a.item_id ORDER BY a.created_at, a.id) AS rn
                    FROM exams.answer_specs a
                    WHERE a.item_id IN (SELECT DISTINCT item_id FROM scoped_items WHERE item_id IS NOT NULL)
                )
                SELECT si.section_id, si.part_id, si.part_code, si.part_ordinal,
                       si.placement_id, si.group_id, si.group_ordinal, si.display_numbering,
                       si.item_id, si.logical_item_key, si.item_ordinal, si.prompt, si.interaction_type,
                       si.option_definitions,
                       COALESCE(ar.answer_count, 0) AS answer_count,
                       ar.id AS answer_id, ar.accepted_answers::text AS accepted_answers, ar.cardinality, ar.word_limit, ar.rubric_id
                FROM scoped_items si
                LEFT JOIN ans_ranked ar ON ar.item_id = si.item_id AND ar.rn = 1
                ORDER BY si.sec_ordinal, si.part_ordinal, si.part_id, si.group_ordinal, si.placement_id,
                         COALESCE(si.item_ordinal, 2147483647), si.item_id
                """, p, (ResultSet rs) -> {
            UUID partId = (UUID) rs.getObject("part_id");
            parts.computeIfAbsent(partId, k -> {
                try {
                    return new PartRow((UUID) rs.getObject("section_id"), partId, rs.getString("part_code"), rs.getInt("part_ordinal"));
                } catch (SQLException e) {
                    throw new IllegalStateException(e);
                }
            });
            UUID placementId = (UUID) rs.getObject("placement_id");
            if (placementId == null) return;
            placements.putIfAbsent(placementId, new PlacementRow(partId, placementId, (UUID) rs.getObject("group_id"), rs.getInt("group_ordinal"), rs.getString("display_numbering")));
            UUID itemId = (UUID) rs.getObject("item_id");
            if (itemId == null) return;
            UUID answerId = (UUID) rs.getObject("answer_id");
            AnswerNode answer = answerId == null ? null : new AnswerNode(answerId, rs.getString("accepted_answers"),
                    rs.getInt("cardinality"), (Integer) rs.getObject("word_limit"), (UUID) rs.getObject("rubric_id"));
            itemsByPlacement.computeIfAbsent(placementId, k -> new ArrayList<>()).add(new ItemNode(itemId,
                    rs.getString("logical_item_key"), (Integer) rs.getObject("item_ordinal"), rs.getString("prompt"),
                    rs.getString("interaction_type"), rs.getString("option_definitions"), answer, rs.getInt("answer_count")));
        });

        Map<UUID, Map<UUID, StimulusBuilder>> stimuliByGroup = new HashMap<>();
        jdbc.query(FORM_SECTIONS_CTE + """
                SELECT DISTINCT gs.group_id, gs.ordinal AS link_ordinal, sv.id AS stimulus_id, sv.kind,
                       (sv.body_payload IS NOT NULL AND sv.body_payload::text NOT IN ('{}', 'null', '[]')) AS has_payload,
                       ast.id AS asset_id, ast.mime_type, ast.validation_state
                FROM (SELECT DISTINCT id, ordinal FROM secs) sc
                JOIN exams.parts p ON p.section_id = sc.id
                JOIN exams.form_groups fg ON fg.part_id = p.id
                JOIN exams.group_stimuli gs ON gs.group_id = fg.group_id
                JOIN exams.stimulus_versions sv ON sv.id = gs.stimulus_id
                LEFT JOIN exams.stimulus_assets sa ON sa.stimulus_id = sv.id
                LEFT JOIN exams.assets ast ON ast.id = sa.asset_id
                ORDER BY gs.group_id, gs.ordinal, sv.id, ast.id
                """, p, (ResultSet rs) -> {
            UUID groupId = (UUID) rs.getObject("group_id");
            UUID stimulusId = (UUID) rs.getObject("stimulus_id");
            StimulusBuilder b = stimuliByGroup.computeIfAbsent(groupId, k -> new LinkedHashMap<>())
                    .computeIfAbsent(stimulusId, k -> {
                        try {
                            return new StimulusBuilder(stimulusId, rs.getString("kind"), rs.getBoolean("has_payload"));
                        } catch (SQLException e) {
                            throw new IllegalStateException(e);
                        }
                    });
            UUID assetId = (UUID) rs.getObject("asset_id");
            if (assetId != null && b.assets.stream().noneMatch(a -> a.id().equals(assetId))) {
                b.assets.add(new AssetNode(assetId, rs.getString("mime_type"), rs.getString("validation_state")));
            }
        });

        Map<UUID, List<GroupNode>> groupsByPart = new HashMap<>();
        for (PlacementRow pr : placements.values()) {
            List<StimulusNode> stimuli = stimuliByGroup.getOrDefault(pr.groupId(), Map.of()).values().stream()
                    .map(StimulusBuilder::build).toList();
            groupsByPart.computeIfAbsent(pr.partId(), k -> new ArrayList<>()).add(new GroupNode(pr.groupId(), pr.placementId(),
                    pr.ordinal(), stimuli, itemsByPlacement.getOrDefault(pr.placementId(), List.of()), pr.displayNumbering()));
        }
        Map<UUID, List<PartNode>> partsBySection = new HashMap<>();
        for (PartRow pr : parts.values()) {
            partsBySection.computeIfAbsent(pr.sectionId(), k -> new ArrayList<>()).add(new PartNode(pr.partId(), pr.partCode(),
                    pr.partOrdinal(), groupsByPart.getOrDefault(pr.partId(), List.of())));
        }
        Map<UUID, List<SectionNode>> sectionsByRoot = new HashMap<>();
        for (SectionRow s : sectionRows) {
            sectionsByRoot.computeIfAbsent(s.rootId(), k -> new ArrayList<>()).add(new SectionNode(s.id(), s.formId(), s.skill(), s.ordinal(), s.duration(), s.enabled(), s.health(),
                    partsBySection.getOrDefault(s.id(), List.of())));
        }
        Map<UUID, ExamContentTree> result = new LinkedHashMap<>();
        for (Map<String, Object> form : forms) {
            UUID formId = (UUID) form.get("id");
            result.put(formId, new ExamContentTree(formId, ExamFamily.valueOf((String) form.get("family")),
                (String) form.get("variant"), (String) form.get("scope"), (String) form.get("primary_health_status"),
                form.get("scoring_scheme_id") != null, parseMap((String) form.get("blueprint")), sectionsByRoot.getOrDefault(formId, List.of())));
        }
        return result;
    }

    // ─── Persisted validation results (V71 exams.form_content_validations) ─────────────────

    /** Append-only; one row per (form, validator version, content fingerprint). UNKNOWN is never stored. */
    public boolean insertValidation(ExamFormValidationReport report, String trigger) {
        return insertValidation(report, trigger, null);
    }

    public boolean insertValidation(ExamFormValidationReport report, String trigger, ExamCatalogStructuralSummary summary) {
        if (report.status() == ExamContentValidationStatus.UNKNOWN || report.contentFingerprint() == null) return false;
        return jdbc.update(INSERT_VALIDATION_SQL, validationParams(report, trigger, summary)) > 0;
    }

    public void insertValidations(List<ExamFormValidationReport> reports, String trigger) {
        insertValidations(reports, trigger, Map.of());
    }

    public void insertValidations(List<ExamFormValidationReport> reports, String trigger,
            Map<UUID, ExamCatalogStructuralSummary> summaries) {
        var rows = reports.stream().filter(r -> r.status() != ExamContentValidationStatus.UNKNOWN && r.contentFingerprint() != null).toList();
        if (rows.isEmpty()) return;
        int valuesAt = INSERT_VALIDATION_SQL.indexOf("VALUES ") + 7;
        int conflictAt = INSERT_VALIDATION_SQL.indexOf("ON CONFLICT");
        String valueTemplate = INSERT_VALIDATION_SQL.substring(valuesAt, conflictAt).trim();
        List<String> values = new ArrayList<>();
        MapSqlParameterSource combined = new MapSqlParameterSource();
        for (int index = 0; index < rows.size(); index++) {
            String value = valueTemplate;
            for (var entry : validationParams(rows.get(index), trigger, summaries.get(rows.get(index).formId())).getValues().entrySet()) {
                String renamed = entry.getKey() + "_" + index;
                value = value.replaceAll(":" + entry.getKey() + "\\b", ":" + renamed);
                combined.addValue(renamed, entry.getValue());
            }
            values.add(value);
        }
        jdbc.update(INSERT_VALIDATION_SQL.substring(0, valuesAt) + String.join(",", values)
                + " " + INSERT_VALIDATION_SQL.substring(conflictAt), combined);
    }

    private static final String INSERT_VALIDATION_SQL = """
                INSERT INTO exams.form_content_validations
                    (form_id, validator_version, content_fingerprint, status, full_simulation_eligible,
                     practice_skills, simulation_skills, blocking_count, standard_count, report, trigger_source, evaluated_at)
                VALUES (:formId, :version, :fingerprint, :status, :full,
                        CAST(:practice AS jsonb), CAST(:simulation AS jsonb), :blocking, :standard, CAST(:report AS jsonb),
                        :trigger, :evaluatedAt)
                ON CONFLICT (form_id, validator_version, content_fingerprint) DO NOTHING
                """;

    private MapSqlParameterSource validationParams(ExamFormValidationReport report, String trigger, ExamCatalogStructuralSummary summary) {
        int blocking = 0;
        int standard = 0;
        for (ExamValidationDiagnostic d : report.allDiagnostics()) {
            if (d.severity() == ExamValidationSeverity.BLOCKING) blocking++;
            else if (d.severity() == ExamValidationSeverity.STANDARD) standard++;
        }
        return new MapSqlParameterSource()
                .addValue("formId", report.formId())
                .addValue("version", report.validatorVersion())
                .addValue("fingerprint", report.contentFingerprint())
                .addValue("status", report.status().name())
                .addValue("full", report.fullSimulationEligible())
                .addValue("practice", toJson(ExamFormValidationReport.skillNames(report.practiceSkills())))
                .addValue("simulation", toJson(ExamFormValidationReport.skillNames(report.simulationSkills())))
                .addValue("blocking", blocking)
                .addValue("standard", standard)
                .addValue("report", auditJson(report, summary))
                .addValue("trigger", trigger)
                .addValue("evaluatedAt", Timestamp.from(report.evaluatedAt()));

    }

    private String auditJson(ExamFormValidationReport report, ExamCatalogStructuralSummary summary) {
        if (summary == null) return toJson(report);
        com.fasterxml.jackson.databind.node.ObjectNode json = objectMapper.valueToTree(report);
        json.set("catalogSummary", objectMapper.valueToTree(summary));
        return toJson(json);
    }

    /** Newest first; summary columns only (the full report is served from a fresh evaluation). */
    public List<Map<String, Object>> findValidationHistory(UUID formId, int limit) {
        return jdbc.queryForList("""
                SELECT validator_version, content_fingerprint, status, full_simulation_eligible,
                       practice_skills::text AS practice_skills, simulation_skills::text AS simulation_skills,
                       blocking_count, standard_count, trigger_source, evaluated_at
                FROM exams.form_content_validations
                WHERE form_id = :formId
                ORDER BY evaluated_at DESC, id DESC
                LIMIT :limit
                """, new MapSqlParameterSource("formId", formId).addValue("limit", Math.max(1, Math.min(limit, 50))));
    }

    private Map<String, Object> parseMap(String json) {
        if (json == null || json.isBlank()) return Map.of();
        try {
            Map<String, Object> m = objectMapper.readValue(json, new TypeReference<LinkedHashMap<String, Object>>() {});
            return m == null ? Map.of() : m;
        } catch (Exception e) {
            return Map.of();
        }
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("VALIDATION_SERIALIZATION_FAILED", e);
        }
    }

    private static final class StimulusBuilder {
        private final UUID id;
        private final String kind;
        private final boolean hasPayload;
        private final List<AssetNode> assets = new ArrayList<>();

        StimulusBuilder(UUID id, String kind, boolean hasPayload) {
            this.id = id;
            this.kind = kind;
            this.hasPayload = hasPayload;
        }

        StimulusNode build() {
            return new StimulusNode(id, kind, hasPayload, assets);
        }
    }
}
