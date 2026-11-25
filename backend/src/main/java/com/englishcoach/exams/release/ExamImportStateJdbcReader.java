package com.englishcoach.exams.release;

import com.englishcoach.exams.content.ExamPackageIdentity;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

import java.util.*;

/**
 * Exams Recovery Phase 5D — the planner's view of a target database. SELECT statements only (never a write); the
 * package identity is the one the importer recorded in {@code exams.content_qa_runs.findings -> 'packageIdentity'}
 * (no schema change). Imports made before Phase 5 carry no identity and are reported as such by the planner.
 */
public final class ExamImportStateJdbcReader implements ExamImportPlanner.StateReader {

    private final NamedParameterJdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public ExamImportStateJdbcReader(NamedParameterJdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    @Override
    public List<ExamImportPlanner.ImportedVersion> importsForSource(String sourceKey) {
        return jdbc.query("""
                SELECT i.package_id, i.package_version, i.content_hash, i.form_id, f.version AS form_version,
                       f.lifecycle_state, q.findings -> 'packageIdentity' AS identity
                  FROM exams.content_package_imports i
                  JOIN exams.form_versions f ON f.id = i.form_id
                  JOIN exams.content_qa_runs q ON q.package_import_id = i.id
                 WHERE i.status = 'IMPORTED'
                   AND q.findings -> 'packageIdentity' ->> 'sourceKey' = :sourceKey
                 ORDER BY i.package_version
                """, new MapSqlParameterSource("sourceKey", sourceKey), (rs, n) -> {
            ExamPackageIdentity identity = null;
            String json = rs.getString("identity");
            if (json != null) {
                try {
                    identity = ExamPackageIdentity.fromMap(mapper.readValue(json, Map.class)).orElse(null);
                } catch (Exception ignored) {
                    identity = null;
                }
            }
            return new ExamImportPlanner.ImportedVersion(rs.getString("package_id"), rs.getInt("package_version"),
                    rs.getString("content_hash"), (UUID) rs.getObject("form_id"), rs.getInt("form_version"),
                    rs.getString("lifecycle_state"), identity);
        });
    }

    @Override
    public List<ExamImportPlanner.FormRef> formsByLogicalKey(String logicalKey) {
        return formsByLogicalKeys(List.of(logicalKey));
    }

    @Override
    public List<ExamImportPlanner.FormRef> formsByLogicalKeys(Collection<String> logicalKeys) {
        if (logicalKeys == null || logicalKeys.isEmpty()) return List.of();
        return jdbc.query("""
                SELECT id, logical_key, version, lifecycle_state FROM exams.form_versions
                 WHERE logical_key IN (:keys) ORDER BY logical_key, version
                """, new MapSqlParameterSource("keys", new ArrayList<>(logicalKeys)),
                (rs, n) -> new ExamImportPlanner.FormRef((UUID) rs.getObject("id"), rs.getString("logical_key"),
                        rs.getInt("version"), rs.getString("lifecycle_state")));
    }
}
