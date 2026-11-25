package com.englishcoach.exams.measurement.repository;

import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.*;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

/** JDBC boundary for measurement-only tables and the existing runtime facts. */
@Repository
@RequiredArgsConstructor
public class ExamMeasurementRepository {

    private final NamedParameterJdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    private String json(Object value) {
        if (value == null) return null;
        try { return objectMapper.writeValueAsString(value); }
        catch (JsonProcessingException e) { throw new IllegalArgumentException("Invalid measurement JSON", e); }
    }

    private Map<String, Object> map(String value) {
        if (value == null || value.isBlank()) return Map.of();
        try { return objectMapper.readValue(value, new TypeReference<>() {}); }
        catch (JsonProcessingException e) { return Map.of("_invalid_json", true); }
    }

    private List<Map<String, Object>> mapList(String value) {
        if (value == null || value.isBlank()) return List.of();
        try { return objectMapper.readValue(value, new TypeReference<>() {}); }
        catch (JsonProcessingException e) { return List.of(); }
    }

    private List<String> stringList(String value) {
        if (value == null || value.isBlank()) return List.of();
        try { return objectMapper.readValue(value, new TypeReference<>() {}); }
        catch (JsonProcessingException e) { return List.of(); }
    }

    private static Instant instant(Timestamp value) { return value == null ? null : value.toInstant(); }

    public List<RuntimeObservationRow> findRuntimeObservationRows(UUID attemptId) {
        String sql = """
            SELECT a.id AS attempt_id, sub.id AS submission_id, r.id AS response_id, a.user_id,
                   a.form_id, f.version AS form_version, f.content_hash AS form_content_hash,
                   r.item_id, i.version AS item_version, i.content_hash AS item_content_hash,
                   a.family, a.variant, a.scope, sec.skill, g.question_type AS task_family,
                   a.attempt_mode, a.pinned_manifest_hash AS manifest_hash,
                   sub.submission_hash, r.revision AS response_revision,
                   r.answer_payload, r.text_response,
                   CASE WHEN jsonb_typeof(r.answer_payload) = 'string'
                        THEN r.answer_payload #>> '{}' ELSE NULL END AS selected_option,
                   ans.accepted_answers, ans.normalization_policy, ans.cardinality,
                   ans.credit_units,
                   CASE WHEN EXISTS (
                       SELECT 1 FROM exams.exposures e
                        WHERE e.user_id = a.user_id
                          AND e.logical_content_key = i.logical_item_key
                          AND e.version = i.version
                   ) THEN 'FAMILIAR' ELSE 'UNKNOWN' END AS exposure_status,
                   a.submitted_at
              FROM exams.attempts a
              JOIN exams.submissions sub ON sub.attempt_id = a.id
              JOIN exams.responses r ON r.attempt_id = a.id
              JOIN exams.form_versions f ON f.id = a.form_id
              JOIN exams.item_versions i ON i.id = r.item_id
              JOIN exams.sections sec ON sec.id = r.section_id AND sec.form_id = a.form_id
              JOIN exams.group_versions g ON g.id = i.group_id
              LEFT JOIN exams.answer_specs ans ON ans.item_id = r.item_id
             WHERE a.id = :attemptId
             ORDER BY r.placement_id
            """;
        return jdbcTemplate.query(sql, new MapSqlParameterSource("attemptId", attemptId), (rs, n) ->
                new RuntimeObservationRow(
                        (UUID) rs.getObject("attempt_id"), (UUID) rs.getObject("submission_id"),
                        (UUID) rs.getObject("response_id"), rs.getLong("user_id"),
                        (UUID) rs.getObject("form_id"), rs.getInt("form_version"), rs.getString("form_content_hash"),
                        (UUID) rs.getObject("item_id"), rs.getInt("item_version"), rs.getString("item_content_hash"),
                        com.englishcoach.exams.model.ExamTypes.ExamFamily.valueOf(rs.getString("family")),
                        rs.getString("variant"), rs.getString("scope"),
                        com.englishcoach.exams.model.ExamTypes.SkillType.valueOf(rs.getString("skill")),
                        rs.getString("task_family"), rs.getString("attempt_mode"), rs.getString("manifest_hash"),
                        rs.getString("submission_hash"), rs.getLong("response_revision"), map(rs.getString("answer_payload")),
                        rs.getString("text_response"), rs.getString("selected_option"), null, rs.getObject("accepted_answers") != null,
                        rs.getObject("accepted_answers") == null ? Map.of() : map(rs.getString("accepted_answers")),
                        rs.getObject("normalization_policy") == null ? Map.of() : map(rs.getString("normalization_policy")),
                        rs.getObject("cardinality") == null ? 1 : rs.getInt("cardinality"),
                        rs.getObject("credit_units") == null ? 1.0 : rs.getDouble("credit_units"),
                        ExposureStatus.valueOf(rs.getString("exposure_status")), instant(rs.getTimestamp("submitted_at"))
                ));
    }

    public Optional<UUID> latestGrantedConsent(Long participantUserId, String purpose) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject("""
                SELECT id FROM exams.measurement_consents
                 WHERE participant_user_id = :participantUserId AND purpose = :purpose AND status = 'GRANTED'
                 ORDER BY created_at DESC LIMIT 1
                """, new MapSqlParameterSource().addValue("participantUserId", participantUserId).addValue("purpose", purpose),
                    (rs, n) -> (UUID) rs.getObject("id")));
        } catch (EmptyResultDataAccessException e) { return Optional.empty(); }
    }

    public Optional<String> latestConsentStatus(Long participantUserId, String purpose) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject("""
                SELECT status FROM exams.measurement_consents
                 WHERE participant_user_id = :participantUserId AND purpose = :purpose
                 ORDER BY created_at DESC LIMIT 1
                """, new MapSqlParameterSource().addValue("participantUserId", participantUserId)
                    .addValue("purpose", purpose), (rs, n) -> rs.getString("status")));
        } catch (EmptyResultDataAccessException e) { return Optional.empty(); }
    }

    public UUID recordConsent(Long participantUserId, String purpose, String status, Long actorUserId, String consentHash) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update("""
            INSERT INTO exams.measurement_consents
                (id, participant_user_id, purpose, status, actor_user_id, consent_hash)
            VALUES (:id, :participantUserId, :purpose, :status, :actorUserId, :consentHash)
            """, new MapSqlParameterSource().addValue("id", id).addValue("participantUserId", participantUserId)
                .addValue("purpose", purpose).addValue("status", status).addValue("actorUserId", actorUserId)
                .addValue("consentHash", consentHash));
        return id;
    }

    public UUID insertEvent(RuntimeObservationRow row, ConsentStatus consentStatus, UUID consentReference,
                             SourceType sourceType, EvidenceClass evidenceClass, OutcomeStatus outcome,
                             OutcomeSource outcomeSource, Double scoreAwarded, Double maxScore,
                             Long responseTimeMs, String selectedOption, Map<String, Object> responsePayload,
                             String eventHash, Long createdBy) {
        UUID id = UUID.randomUUID();
        String sql = """
            INSERT INTO exams.measurement_events
              (id, attempt_id, submission_id, response_id, user_id, form_id, item_id, family, variant, scope,
               skill, task_family, attempt_mode, form_version, item_version, form_content_hash, item_content_hash,
               manifest_hash, submission_hash, response_revision, exposure_status, consent_status, consent_reference,
               source_type, evidence_class, outcome_status, outcome_source, score_awarded, max_score,
               response_time_ms, selected_option, response_payload, event_hash, created_by)
            VALUES (:id, :attemptId, :submissionId, :responseId, :userId, :formId, :itemId, :family, :variant, :scope,
               :skill, :taskFamily, :attemptMode, :formVersion, :itemVersion, :formContentHash, :itemContentHash,
               :manifestHash, :submissionHash, :responseRevision, :exposureStatus, :consentStatus, :consentReference,
               :sourceType, :evidenceClass, :outcomeStatus, :outcomeSource, :scoreAwarded, :maxScore,
               :responseTimeMs, :selectedOption, CAST(:responsePayload AS jsonb), :eventHash, :createdBy)
            """;
        jdbcTemplate.update(sql, new MapSqlParameterSource()
                .addValue("id", id).addValue("attemptId", row.attemptId()).addValue("submissionId", row.submissionId())
                .addValue("responseId", row.responseId()).addValue("userId", row.userId()).addValue("formId", row.formId())
                .addValue("itemId", row.itemId()).addValue("family", row.family().name()).addValue("variant", row.variant())
                .addValue("scope", row.scope()).addValue("skill", row.skill().name()).addValue("taskFamily", row.taskFamily())
                .addValue("attemptMode", row.attemptMode()).addValue("formVersion", row.formVersion()).addValue("itemVersion", row.itemVersion())
                .addValue("formContentHash", row.formContentHash()).addValue("itemContentHash", row.itemContentHash())
                .addValue("manifestHash", row.manifestHash()).addValue("submissionHash", row.submissionHash())
                .addValue("responseRevision", row.responseRevision()).addValue("exposureStatus", row.exposureStatus().name())
                .addValue("consentStatus", consentStatus.name()).addValue("consentReference", consentReference)
                .addValue("sourceType", sourceType.name()).addValue("evidenceClass", evidenceClass.name())
                .addValue("outcomeStatus", outcome.name()).addValue("outcomeSource", outcomeSource.name())
                .addValue("scoreAwarded", scoreAwarded).addValue("maxScore", maxScore).addValue("responseTimeMs", responseTimeMs)
                .addValue("selectedOption", selectedOption).addValue("responsePayload", json(responsePayload))
                .addValue("eventHash", eventHash).addValue("createdBy", createdBy));
        return id;
    }

    public List<MeasurementEvent> findEventsByAttempt(UUID attemptId) {
        return jdbcTemplate.query("SELECT * FROM exams.measurement_events WHERE attempt_id = :attemptId ORDER BY created_at, id",
                new MapSqlParameterSource("attemptId", attemptId), this::mapEvent);
    }

    public List<MeasurementEvent> findEventsByRun(UUID runId) {
        return jdbcTemplate.query("""
            SELECT e.* FROM exams.measurement_events e
            JOIN exams.measurement_run_events re ON re.event_id = e.id
             WHERE re.run_id = :runId AND re.disposition = 'INCLUDE'
             ORDER BY e.created_at, e.id
            """, new MapSqlParameterSource("runId", runId), this::mapEvent);
    }

    private MeasurementEvent mapEvent(java.sql.ResultSet rs, int n) throws java.sql.SQLException {
        return new MeasurementEvent((UUID) rs.getObject("id"), (UUID) rs.getObject("attempt_id"),
                (UUID) rs.getObject("submission_id"), (UUID) rs.getObject("response_id"), rs.getLong("user_id"),
                (UUID) rs.getObject("form_id"), (UUID) rs.getObject("item_id"),
                com.englishcoach.exams.model.ExamTypes.ExamFamily.valueOf(rs.getString("family")), rs.getString("variant"),
                rs.getString("scope"), com.englishcoach.exams.model.ExamTypes.SkillType.valueOf(rs.getString("skill")),
                rs.getString("task_family"), rs.getString("attempt_mode"), rs.getInt("form_version"), rs.getInt("item_version"),
                rs.getString("form_content_hash"), rs.getString("item_content_hash"), rs.getString("manifest_hash"),
                rs.getString("submission_hash"), rs.getLong("response_revision"), ExposureStatus.valueOf(rs.getString("exposure_status")),
                ConsentStatus.valueOf(rs.getString("consent_status")), (UUID) rs.getObject("consent_reference"),
                SourceType.valueOf(rs.getString("source_type")), EvidenceClass.valueOf(rs.getString("evidence_class")),
                OutcomeStatus.valueOf(rs.getString("outcome_status")), OutcomeSource.valueOf(rs.getString("outcome_source")),
                rs.getObject("score_awarded") == null ? null : rs.getDouble("score_awarded"),
                rs.getObject("max_score") == null ? null : rs.getDouble("max_score"),
                rs.getObject("response_time_ms") == null ? null : rs.getLong("response_time_ms"), rs.getString("selected_option"),
                map(rs.getString("response_payload")), rs.getString("event_hash"), rs.getLong("created_by"), instant(rs.getTimestamp("created_at")));
    }

    public UUID createRun(com.englishcoach.exams.model.ExamTypes.ExamFamily family,
                          com.englishcoach.exams.model.ExamTypes.SkillType skill, UUID formId,
                          Map<String, Object> filter, String consentPolicyVersion, String inputHash, Long createdBy) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update("""
            INSERT INTO exams.measurement_runs
                (id, family, skill, form_id, sample_filter, consent_policy_version, input_hash, created_by)
            VALUES (:id, :family, :skill, :formId, CAST(:filter AS jsonb), :consentPolicyVersion, :inputHash, :createdBy)
            """, new MapSqlParameterSource().addValue("id", id).addValue("family", family.name())
                .addValue("skill", skill == null ? null : skill.name()).addValue("formId", formId)
                .addValue("filter", json(filter == null ? Map.of() : filter)).addValue("consentPolicyVersion", consentPolicyVersion)
                .addValue("inputHash", inputHash).addValue("createdBy", createdBy));
        return id;
    }

    public void attachRunEvent(UUID runId, UUID eventId, String disposition, String reason) {
        jdbcTemplate.update("""
            INSERT INTO exams.measurement_run_events(run_id, event_id, disposition, reason)
            VALUES (:runId, :eventId, :disposition, :reason)
            """, new MapSqlParameterSource().addValue("runId", runId).addValue("eventId", eventId)
                .addValue("disposition", disposition).addValue("reason", reason));
    }

    public void insertExclusion(UUID runId, UUID eventId, String reason, String detail, Long actorUserId) {
        jdbcTemplate.update("""
            INSERT INTO exams.measurement_exclusions(run_id, event_id, reason, detail, actor_user_id)
            VALUES (:runId, :eventId, :reason, :detail, :actorUserId)
            """, new MapSqlParameterSource().addValue("runId", runId).addValue("eventId", eventId)
                .addValue("reason", reason).addValue("detail", detail).addValue("actorUserId", actorUserId));
    }

    public void updateRunCounts(UUID runId, RunStatus status, int raw, int clean, int excluded, Instant finalizedAt) {
        jdbcTemplate.update("""
            UPDATE exams.measurement_runs
               SET status = :status, raw_count = :raw, clean_count = :clean, excluded_count = :excluded,
                   finalized_at = :finalizedAt
             WHERE id = :runId
            """, new MapSqlParameterSource().addValue("status", status.name()).addValue("raw", raw)
                .addValue("clean", clean).addValue("excluded", excluded).addValue("finalizedAt", finalizedAt)
                .addValue("runId", runId));
    }

    public void insertItemStatistic(UUID runId, ItemStatistic stat) {
        jdbcTemplate.update("""
            INSERT INTO exams.item_statistics
              (run_id, item_id, sample_size, valid_count, p_value, item_rest_point_biserial,
               omission_rate, median_response_time_ms, distractor_rates, reliability_status, flags)
            VALUES (:runId, :itemId, :sampleSize, :validCount, :pValue, :pointBiserial,
               :omissionRate, :medianTime, CAST(:distractors AS jsonb), :status, CAST(:flags AS jsonb))
            """, new MapSqlParameterSource().addValue("runId", runId).addValue("itemId", stat.itemId())
                .addValue("sampleSize", stat.sampleSize()).addValue("validCount", stat.validCount())
                .addValue("pValue", stat.pValue()).addValue("pointBiserial", stat.itemRestPointBiserial())
                .addValue("omissionRate", stat.omissionRate()).addValue("medianTime", stat.medianResponseTimeMs())
                .addValue("distractors", json(stat.distractorRates())).addValue("status", stat.calculationStatus())
                .addValue("flags", json(stat.flags())));
    }

    public Optional<RunSummary> findRun(UUID runId) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject("SELECT * FROM exams.measurement_runs WHERE id = :id",
                    new MapSqlParameterSource("id", runId), (rs, n) -> new RunSummary((UUID) rs.getObject("id"),
                            com.englishcoach.exams.model.ExamTypes.ExamFamily.valueOf(rs.getString("family")),
                            rs.getString("skill") == null ? null : com.englishcoach.exams.model.ExamTypes.SkillType.valueOf(rs.getString("skill")),
                            (UUID) rs.getObject("form_id"), RunStatus.valueOf(rs.getString("status")), rs.getInt("raw_count"),
                            rs.getInt("clean_count"), rs.getInt("excluded_count"), rs.getString("input_hash"),
                            rs.getString("consent_policy_version"), instant(rs.getTimestamp("created_at")), instant(rs.getTimestamp("finalized_at")))));
        } catch (EmptyResultDataAccessException e) { return Optional.empty(); }
    }

    public List<ItemStatistic> findItemStatistics(UUID runId) {
        return jdbcTemplate.query("""
            SELECT item_id, sample_size, valid_count, p_value, item_rest_point_biserial,
                   omission_rate, median_response_time_ms, distractor_rates, reliability_status, flags
              FROM exams.item_statistics WHERE run_id = :runId ORDER BY item_id
            """, new MapSqlParameterSource("runId", runId), (rs, n) -> new ItemStatistic(
                (UUID) rs.getObject("item_id"), rs.getInt("sample_size"), rs.getInt("valid_count"),
                rs.getObject("p_value") == null ? null : rs.getDouble("p_value"),
                rs.getObject("item_rest_point_biserial") == null ? null : rs.getDouble("item_rest_point_biserial"),
                rs.getObject("omission_rate") == null ? null : rs.getDouble("omission_rate"),
                rs.getObject("median_response_time_ms") == null ? null : rs.getLong("median_response_time_ms"),
                map(rs.getString("distractor_rates")).entrySet().stream().collect(java.util.stream.Collectors.toMap(
                        Map.Entry::getKey, e -> ((Number) e.getValue()).doubleValue(), (a, b) -> a, LinkedHashMap::new)),
                rs.getString("reliability_status"), stringList(rs.getString("flags"))));
    }

    public UUID createCalibrationPackage(CalibrationPackageRequest request, Long createdBy) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update("""
            INSERT INTO exams.calibration_packages
              (id, logical_code, version, form_id, scoring_scheme_id, measurement_run_id, method, maturity_stage,
               mapping_table, uncertainty_model, evidence_hash, validation_report, created_by)
            VALUES (:id, :logicalCode, :version, :formId, :schemeId, :runId, :method, :stage,
                    CAST(:mapping AS jsonb), CAST(:uncertainty AS jsonb), :evidenceHash, :validationReport, :createdBy)
            """, new MapSqlParameterSource().addValue("id", id).addValue("logicalCode", request.logicalCode())
                .addValue("version", request.version()).addValue("formId", request.formId()).addValue("schemeId", request.scoringSchemeId())
                .addValue("runId", request.measurementRunId()).addValue("method", request.method()).addValue("stage", request.maturityStage())
                .addValue("mapping", json(request.mappingTable())).addValue("uncertainty", json(request.uncertaintyModel()))
                .addValue("evidenceHash", request.evidenceHash()).addValue("validationReport", request.validationReport())
                .addValue("createdBy", createdBy));
        return id;
    }

    public void approveCalibration(UUID packageId, Long approver, Instant approvedAt) {
        int updated = jdbcTemplate.update("""
            UPDATE exams.calibration_packages
               SET approval_state = 'APPROVED', approved_by = :approver, approved_at = :approvedAt
             WHERE id = :id AND approval_state = 'PENDING_APPROVAL'
            """, new MapSqlParameterSource().addValue("id", packageId).addValue("approver", approver).addValue("approvedAt", approvedAt));
        if (updated != 1) throw new IllegalStateException("Calibration package is missing or already transitioned");
    }

    public Optional<CalibrationPackage> findCalibrationPackage(UUID id) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject("SELECT * FROM exams.calibration_packages WHERE id = :id",
                    new MapSqlParameterSource("id", id), (rs, n) -> new CalibrationPackage((UUID) rs.getObject("id"),
                            rs.getString("logical_code"), rs.getInt("version"), (UUID) rs.getObject("form_id"),
                            (UUID) rs.getObject("scoring_scheme_id"), (UUID) rs.getObject("measurement_run_id"), rs.getString("method"),
                            rs.getString("maturity_stage"), map(rs.getString("mapping_table")), map(rs.getString("uncertainty_model")),
                            rs.getString("evidence_hash"), rs.getString("validation_report"), rs.getString("approval_state"),
                            rs.getObject("approved_by") == null ? null : rs.getLong("approved_by"), instant(rs.getTimestamp("approved_at")),
                            rs.getLong("created_by"), instant(rs.getTimestamp("created_at")))));
        } catch (EmptyResultDataAccessException e) { return Optional.empty(); }
    }

    public boolean scoringSchemeBelongsToForm(UUID formId, UUID scoringSchemeId) {
        Integer count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.form_versions WHERE id = :formId AND scoring_scheme_id = :schemeId",
                new MapSqlParameterSource().addValue("formId", formId).addValue("schemeId", scoringSchemeId), Integer.class);
        return count != null && count == 1;
    }

    public boolean runHasApprovalEvidence(UUID runId) {
        Integer count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.measurement_runs WHERE id = :runId AND status = 'FINAL'",
                new MapSqlParameterSource("runId", runId), Integer.class);
        return count != null && count == 1;
    }

    public UUID createGoldDataset(String logicalCode, int version,
                                  com.englishcoach.exams.model.ExamTypes.ExamFamily family,
                                  com.englishcoach.exams.model.ExamTypes.SkillType skill, UUID rubricVersionId,
                                  String consentPolicyVersion, String provenanceStatement, Long createdBy) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update("""
            INSERT INTO exams.human_gold_datasets
              (id, logical_code, version, family, skill, rubric_version_id, consent_policy_version,
               provenance_statement, created_by)
            VALUES (:id, :logicalCode, :version, :family, :skill, :rubricVersionId, :consentPolicyVersion,
                    :provenanceStatement, :createdBy)
            """, new MapSqlParameterSource().addValue("id", id).addValue("logicalCode", logicalCode)
                .addValue("version", version).addValue("family", family.name()).addValue("skill", skill.name())
                .addValue("rubricVersionId", rubricVersionId).addValue("consentPolicyVersion", consentPolicyVersion)
                .addValue("provenanceStatement", provenanceStatement).addValue("createdBy", createdBy));
        return id;
    }

    public Optional<GoldDataset> findGoldDataset(UUID id) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject("SELECT * FROM exams.human_gold_datasets WHERE id = :id",
                    new MapSqlParameterSource("id", id), (rs, n) -> new GoldDataset((UUID) rs.getObject("id"),
                            rs.getString("logical_code"), rs.getInt("version"),
                            com.englishcoach.exams.model.ExamTypes.ExamFamily.valueOf(rs.getString("family")),
                            com.englishcoach.exams.model.ExamTypes.SkillType.valueOf(rs.getString("skill")),
                            (UUID) rs.getObject("rubric_version_id"), rs.getString("consent_policy_version"),
                            rs.getString("provenance_statement"), rs.getString("status"),
                            rs.getObject("locked_by") == null ? null : rs.getLong("locked_by"), instant(rs.getTimestamp("locked_at")),
                            rs.getLong("created_by"), instant(rs.getTimestamp("created_at")))));
        } catch (EmptyResultDataAccessException e) { return Optional.empty(); }
    }

    public void lockGoldDataset(UUID datasetId, Long actorId) {
        int updated = jdbcTemplate.update("""
            UPDATE exams.human_gold_datasets
               SET status = 'LOCKED', locked_by = :actorId, locked_at = clock_timestamp()
             WHERE id = :datasetId AND status = 'DRAFT'
            """, new MapSqlParameterSource().addValue("datasetId", datasetId).addValue("actorId", actorId));
        if (updated != 1) throw new IllegalStateException("Gold dataset is missing or already locked");
    }

    public boolean grantedConsent(UUID consentId, Long participantUserId, String purpose) {
        Integer count = jdbcTemplate.queryForObject("""
            SELECT COUNT(*) FROM exams.measurement_consents
             WHERE id = :consentId AND participant_user_id = :participantUserId
               AND purpose = :purpose AND status = 'GRANTED'
            """, new MapSqlParameterSource().addValue("consentId", consentId)
                .addValue("participantUserId", participantUserId).addValue("purpose", purpose), Integer.class);
        return count != null && count == 1;
    }

    public Optional<Long> responseOwner(UUID responseId) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject("""
                SELECT a.user_id FROM exams.responses r JOIN exams.attempts a ON a.id = r.attempt_id
                 WHERE r.id = :responseId
                """, new MapSqlParameterSource("responseId", responseId), (rs, n) -> rs.getLong("user_id")));
        } catch (EmptyResultDataAccessException e) { return Optional.empty(); }
    }

    public UUID insertGoldMember(UUID datasetId, UUID responseId, UUID attemptId,
                                 com.englishcoach.exams.model.ExamTypes.ExamFamily family,
                                 com.englishcoach.exams.model.ExamTypes.SkillType skill, UUID consentId,
                                 Split split, Long createdBy) {
        UUID id = UUID.randomUUID();
        int updated = jdbcTemplate.update("""
            INSERT INTO exams.human_gold_members
              (id, dataset_id, response_id, attempt_id, family, skill, consent_id, split, response_hash, created_by)
            SELECT :id, :datasetId, r.id, r.attempt_id, :family, :skill, :consentId, :split,
                   encode(digest(CAST(r.id AS text) || ':' || CAST(r.revision AS text), 'sha256'), 'hex'), :createdBy
              FROM exams.responses r
              JOIN exams.attempts a ON a.id = r.attempt_id
             WHERE r.id = :responseId AND r.attempt_id = :attemptId
               AND a.status = 'SUBMITTED'
            """, new MapSqlParameterSource().addValue("id", id).addValue("datasetId", datasetId)
                .addValue("responseId", responseId).addValue("attemptId", attemptId).addValue("family", family.name())
                .addValue("skill", skill.name()).addValue("consentId", consentId).addValue("split", split.name())
                .addValue("createdBy", createdBy));
        if (updated != 1) throw new IllegalArgumentException("Response is not a submitted runtime row");
        return id;
    }

    public UUID createRaterAssignment(UUID datasetId, UUID responseId, UUID attemptId,
                                      com.englishcoach.exams.model.ExamTypes.ExamFamily family,
                                      com.englishcoach.exams.model.ExamTypes.SkillType skill,
                                      Long raterUserId, Long assignedBy) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update("""
            INSERT INTO exams.rater_assignments
              (id, dataset_id, response_id, attempt_id, family, skill, rater_user_id, assigned_by)
            VALUES (:id, :datasetId, :responseId, :attemptId, :family, :skill, :raterUserId, :assignedBy)
            """, new MapSqlParameterSource().addValue("id", id).addValue("datasetId", datasetId)
                .addValue("responseId", responseId).addValue("attemptId", attemptId).addValue("family", family.name())
                .addValue("skill", skill.name()).addValue("raterUserId", raterUserId).addValue("assignedBy", assignedBy));
        return id;
    }

    public Optional<RaterAssignment> findRaterAssignment(UUID assignmentId) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject("SELECT * FROM exams.rater_assignments WHERE id = :id",
                    new MapSqlParameterSource("id", assignmentId), (rs, n) -> new RaterAssignment((UUID) rs.getObject("id"),
                            (UUID) rs.getObject("dataset_id"), (UUID) rs.getObject("response_id"), (UUID) rs.getObject("attempt_id"),
                            com.englishcoach.exams.model.ExamTypes.ExamFamily.valueOf(rs.getString("family")),
                            com.englishcoach.exams.model.ExamTypes.SkillType.valueOf(rs.getString("skill")),
                            rs.getLong("rater_user_id"), rs.getLong("assigned_by"), rs.getBoolean("blind_to_other_ratings"),
                            rs.getString("status"), instant(rs.getTimestamp("created_at")))));
        } catch (EmptyResultDataAccessException e) { return Optional.empty(); }
    }

    public List<RaterAssignment> findRaterAssignmentsForUser(UUID datasetId, Long raterUserId) {
        return jdbcTemplate.query("""
            SELECT * FROM exams.rater_assignments
             WHERE dataset_id = :datasetId AND rater_user_id = :raterUserId
             ORDER BY created_at DESC
            """, new MapSqlParameterSource().addValue("datasetId", datasetId).addValue("raterUserId", raterUserId),
                (rs, n) -> new RaterAssignment((UUID) rs.getObject("id"), (UUID) rs.getObject("dataset_id"),
                        (UUID) rs.getObject("response_id"), (UUID) rs.getObject("attempt_id"),
                        com.englishcoach.exams.model.ExamTypes.ExamFamily.valueOf(rs.getString("family")),
                        com.englishcoach.exams.model.ExamTypes.SkillType.valueOf(rs.getString("skill")),
                        rs.getLong("rater_user_id"), rs.getLong("assigned_by"), rs.getBoolean("blind_to_other_ratings"),
                        rs.getString("status"), instant(rs.getTimestamp("created_at"))));
    }

    /**
     * Return only submitted ratings to an independent adjudicator.  Assigned
     * raters receive an empty result so the two independent ratings stay blind
     * until the adjudication action.
     */
    public List<RaterRatingSummary> findRatingsForAdjudication(UUID datasetId, UUID responseId, Long actorId) {
        Integer assigned = jdbcTemplate.queryForObject("""
            SELECT COUNT(*) FROM exams.rater_assignments
             WHERE dataset_id = :datasetId AND response_id = :responseId AND rater_user_id = :actorId
            """, new MapSqlParameterSource().addValue("datasetId", datasetId)
                .addValue("responseId", responseId).addValue("actorId", actorId), Integer.class);
        if (assigned != null && assigned > 0) return List.of();
        return jdbcTemplate.query("""
            SELECT rr.id, rr.assignment_id, rr.criterion_scores, rr.overall_score,
                   rr.confidence, rr.rating_hash, rr.submitted_at
              FROM exams.rater_ratings rr
              JOIN exams.rater_assignments a ON a.id = rr.assignment_id
             WHERE a.dataset_id = :datasetId AND a.response_id = :responseId
               AND a.status = 'SUBMITTED'
             ORDER BY rr.submitted_at ASC, rr.id ASC
            """, new MapSqlParameterSource().addValue("datasetId", datasetId)
                .addValue("responseId", responseId), (rs, n) -> new RaterRatingSummary(
                    (UUID) rs.getObject("id"), (UUID) rs.getObject("assignment_id"),
                    map(rs.getString("criterion_scores")),
                    rs.getObject("overall_score") == null ? null : rs.getDouble("overall_score"),
                    rs.getObject("confidence") == null ? null : rs.getDouble("confidence"),
                    rs.getString("rating_hash"), instant(rs.getTimestamp("submitted_at"))));
    }

    /**
     * Check dataset membership, linked participant consent, response/attempt
     * identity, and rater independence before any recording is opened.
     */
    public Optional<RaterRecordingAccess> findRaterRecordingAccess(UUID assignmentId, Long actorId) {
        try {
            return Optional.ofNullable(jdbcTemplate.queryForObject("""
                SELECT a.id AS assignment_id, a.dataset_id, a.attempt_id, a.response_id, r.recording_id
                  FROM exams.rater_assignments a
                  JOIN exams.human_gold_members gm
                    ON gm.dataset_id = a.dataset_id AND gm.response_id = a.response_id
                  JOIN exams.measurement_consents mc
                    ON mc.id = gm.consent_id AND mc.purpose = 'EXAMS_HUMAN_RATING' AND mc.status = 'GRANTED'
                  JOIN exams.responses r
                    ON r.id = a.response_id AND r.attempt_id = a.attempt_id
                  JOIN exams.human_gold_datasets d
                    ON d.id = a.dataset_id AND d.status IN ('LOCKED', 'RELEASED')
                 WHERE a.id = :assignmentId
                   AND r.recording_id IS NOT NULL
                   AND (a.rater_user_id = :actorId OR NOT EXISTS (
                        SELECT 1 FROM exams.rater_assignments other
                         WHERE other.dataset_id = a.dataset_id
                           AND other.response_id = a.response_id
                           AND other.rater_user_id = :actorId
                   ))
                """, new MapSqlParameterSource().addValue("assignmentId", assignmentId)
                    .addValue("actorId", actorId), (rs, n) -> new RaterRecordingAccess(
                        (UUID) rs.getObject("assignment_id"), (UUID) rs.getObject("dataset_id"),
                        (UUID) rs.getObject("attempt_id"), (UUID) rs.getObject("response_id"),
                        (UUID) rs.getObject("recording_id"))));
        } catch (EmptyResultDataAccessException e) { return Optional.empty(); }
    }

    public Optional<RaterAssignmentView> findRaterAssignmentView(UUID assignmentId, Long raterUserId) {
        try {
            RaterAssignmentView view = jdbcTemplate.queryForObject("""
                SELECT a.id AS assignment_id, a.dataset_id, a.response_id, a.attempt_id, a.family, a.skill,
                       a.rater_user_id, a.assigned_by, a.blind_to_other_ratings, a.status, a.created_at AS assignment_created_at,
                       r.item_id, r.answer_payload, r.text_response, r.recording_id,
                       i.prompt, i.interaction_type, i.option_definitions, sec.skill AS response_skill,
                       ans.rubric_id
                  FROM exams.rater_assignments a
                  JOIN exams.responses r ON r.id = a.response_id AND r.attempt_id = a.attempt_id
                  JOIN exams.item_versions i ON i.id = r.item_id
                  JOIN exams.sections sec ON sec.id = r.section_id
                  LEFT JOIN exams.answer_specs ans ON ans.item_id = i.id
                 WHERE a.id = :assignmentId AND a.rater_user_id = :raterUserId
                """, new MapSqlParameterSource().addValue("assignmentId", assignmentId).addValue("raterUserId", raterUserId),
                    (rs, n) -> {
                        RaterAssignment assignment = new RaterAssignment((UUID) rs.getObject("assignment_id"),
                                (UUID) rs.getObject("dataset_id"), (UUID) rs.getObject("response_id"),
                                (UUID) rs.getObject("attempt_id"),
                                com.englishcoach.exams.model.ExamTypes.ExamFamily.valueOf(rs.getString("family")),
                                com.englishcoach.exams.model.ExamTypes.SkillType.valueOf(rs.getString("skill")),
                                rs.getLong("rater_user_id"), rs.getLong("assigned_by"), rs.getBoolean("blind_to_other_ratings"),
                                rs.getString("status"), instant(rs.getTimestamp("assignment_created_at")));
                        UUID itemId = (UUID) rs.getObject("item_id");
                        List<Map<String, Object>> assets = jdbcTemplate.query("""
                            SELECT st.id AS stimulus_id, st.title, st.body_payload, ast.id AS asset_id,
                                   ast.object_key, ast.mime_type, ast.duration_ms, sa.role
                              FROM exams.item_versions i
                              JOIN exams.group_stimuli gs ON gs.group_id = i.group_id
                              JOIN exams.stimulus_versions st ON st.id = gs.stimulus_id
                              LEFT JOIN exams.stimulus_assets sa ON sa.stimulus_id = st.id
                              LEFT JOIN exams.assets ast ON ast.id = sa.asset_id
                             WHERE i.id = :itemId ORDER BY gs.ordinal, sa.ordinal
                            """, new MapSqlParameterSource("itemId", itemId), (assetRs, assetRow) -> {
                                Map<String, Object> asset = new LinkedHashMap<>();
                                asset.put("stimulusId", assetRs.getObject("stimulus_id"));
                                asset.put("title", assetRs.getString("title"));
                                asset.put("bodyPayload", map(assetRs.getString("body_payload")));
                                asset.put("assetId", assetRs.getObject("asset_id"));
                                asset.put("objectKey", assetRs.getString("object_key"));
                                asset.put("mimeType", assetRs.getString("mime_type"));
                                asset.put("durationMs", assetRs.getObject("duration_ms"));
                                asset.put("role", assetRs.getString("role"));
                                return asset;
                            });
                        return new RaterAssignmentView(assignment, itemId, rs.getString("prompt"), rs.getString("interaction_type"),
                                map(rs.getString("option_definitions")),
                                com.englishcoach.exams.model.ExamTypes.SkillType.valueOf(rs.getString("response_skill")),
                                (UUID) rs.getObject("rubric_id"), map(rs.getString("answer_payload")), rs.getString("text_response"),
                                (UUID) rs.getObject("recording_id"), assets);
                    });
            return Optional.ofNullable(view);
        } catch (EmptyResultDataAccessException e) { return Optional.empty(); }
    }

    public void insertRating(RatingSubmission rating, Long actorId) {
        int updated = jdbcTemplate.update("""
            INSERT INTO exams.rater_ratings
              (assignment_id, rater_user_id, rubric_version_id, criterion_scores, overall_score, confidence, rating_hash)
            SELECT :assignmentId, rater_user_id, :rubricVersionId, CAST(:criterionScores AS jsonb), :overallScore, :confidence, :ratingHash
              FROM exams.rater_assignments
             WHERE id = :assignmentId AND rater_user_id = :actorId AND status = 'ASSIGNED'
            """, new MapSqlParameterSource().addValue("assignmentId", rating.assignmentId()).addValue("actorId", actorId)
                .addValue("rubricVersionId", rating.rubricVersionId()).addValue("criterionScores", json(rating.criterionScores()))
                .addValue("overallScore", rating.overallScore()).addValue("confidence", rating.confidence())
                .addValue("ratingHash", rating.ratingHash()));
        if (updated != 1) throw new IllegalStateException("Assignment is not assigned to this authenticated rater");
        jdbcTemplate.update("UPDATE exams.rater_assignments SET status = 'SUBMITTED' WHERE id = :id AND status = 'ASSIGNED'",
                new MapSqlParameterSource("id", rating.assignmentId()));
    }

    public void insertAdjudication(UUID responseId, UUID datasetId, Long adjudicatorId, UUID selectedRatingId,
                                   Map<String, Object> finalScores, String disagreementReason, String decisionHash) {
        Integer participantCount = jdbcTemplate.queryForObject("""
            SELECT COUNT(*) FROM exams.rater_assignments a
             WHERE a.response_id = :responseId AND (a.dataset_id = :datasetId OR :datasetId IS NULL)
               AND a.rater_user_id = :adjudicatorId
            """, new MapSqlParameterSource().addValue("responseId", responseId).addValue("datasetId", datasetId)
                .addValue("adjudicatorId", adjudicatorId), Integer.class);
        if (participantCount != null && participantCount > 0) throw new IllegalArgumentException("Adjudicator cannot be an assigned rater");
        Integer independentRatings = jdbcTemplate.queryForObject("""
            SELECT COUNT(*) FROM exams.rater_ratings rr
            JOIN exams.rater_assignments a ON a.id = rr.assignment_id
             WHERE a.response_id = :responseId AND (a.dataset_id = :datasetId OR :datasetId IS NULL)
               AND a.status = 'SUBMITTED'
            """, new MapSqlParameterSource().addValue("responseId", responseId).addValue("datasetId", datasetId), Integer.class);
        if (independentRatings == null || independentRatings < 2) {
            throw new IllegalStateException("Adjudication requires two submitted independent ratings");
        }
        if (selectedRatingId != null) {
            Integer selected = jdbcTemplate.queryForObject("""
                SELECT COUNT(*) FROM exams.rater_ratings rr
                JOIN exams.rater_assignments a ON a.id = rr.assignment_id
                 WHERE rr.id = :selectedRatingId AND a.response_id = :responseId
                   AND (a.dataset_id = :datasetId OR :datasetId IS NULL)
                """, new MapSqlParameterSource().addValue("selectedRatingId", selectedRatingId)
                    .addValue("responseId", responseId).addValue("datasetId", datasetId), Integer.class);
            if (selected == null || selected != 1) throw new IllegalArgumentException("Selected rating is outside the disagreement");
        }
        jdbcTemplate.update("""
            INSERT INTO exams.rater_adjudications
              (response_id, dataset_id, adjudicator_user_id, selected_rating_id, final_scores, disagreement_reason, decision_hash)
            VALUES (:responseId, :datasetId, :adjudicatorId, :selectedRatingId, CAST(:finalScores AS jsonb), :reason, :decisionHash)
            """, new MapSqlParameterSource().addValue("responseId", responseId).addValue("datasetId", datasetId)
                .addValue("adjudicatorId", adjudicatorId).addValue("selectedRatingId", selectedRatingId)
                .addValue("finalScores", json(finalScores)).addValue("reason", disagreementReason).addValue("decisionHash", decisionHash));
    }

    public boolean datasetContainsMember(UUID datasetId, UUID memberId) {
        Integer count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM exams.human_gold_members WHERE dataset_id = :datasetId AND id = :memberId",
                new MapSqlParameterSource().addValue("datasetId", datasetId).addValue("memberId", memberId), Integer.class);
        return count != null && count == 1;
    }

    public UUID createEvaluationRun(UUID datasetId, String scorerName, String scorerVersion, Map<String, Object> splitPolicy,
                                    String lockedTestHash, Long createdBy) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update("""
            INSERT INTO exams.scorer_evaluation_runs
              (id, dataset_id, scorer_name, scorer_version, split_policy, locked_test_hash, created_by)
            VALUES (:id, :datasetId, :scorerName, :scorerVersion, CAST(:splitPolicy AS jsonb), :lockedTestHash, :createdBy)
            """, new MapSqlParameterSource().addValue("id", id).addValue("datasetId", datasetId)
                .addValue("scorerName", scorerName).addValue("scorerVersion", scorerVersion)
                .addValue("splitPolicy", json(splitPolicy)).addValue("lockedTestHash", lockedTestHash).addValue("createdBy", createdBy));
        return id;
    }

    public void insertEvaluationRecord(UUID runId, EvaluationRecord record) {
        jdbcTemplate.update("""
            INSERT INTO exams.scorer_evaluation_records
              (run_id, member_id, split, criterion, human_score, ai_score, abstained, subgroup)
            VALUES (:runId, :memberId, :split, :criterion, :humanScore, :aiScore, :abstained, :subgroup)
            """, new MapSqlParameterSource().addValue("runId", runId).addValue("memberId", record.memberId())
                .addValue("split", record.split().name()).addValue("criterion", record.criterion())
                .addValue("humanScore", record.humanScore()).addValue("aiScore", record.aiScore())
                .addValue("abstained", record.abstained()).addValue("subgroup", record.subgroup()));
    }

    public void completeEvaluation(UUID runId, String status, Map<String, Object> metrics,
                                   Map<String, Object> criterionReports, Map<String, Object> subgroupReports,
                                   Map<String, Object> abstentionReport) {
        jdbcTemplate.update("""
            UPDATE exams.scorer_evaluation_runs
               SET status = :status, metrics = CAST(:metrics AS jsonb), criterion_reports = CAST(:criterionReports AS jsonb),
                   subgroup_reports = CAST(:subgroupReports AS jsonb), abstention_report = CAST(:abstentionReport AS jsonb),
                   completed_at = clock_timestamp()
             WHERE id = :runId AND status IN ('DRAFT', 'RUNNING')
            """, new MapSqlParameterSource().addValue("runId", runId).addValue("status", status)
                .addValue("metrics", json(metrics)).addValue("criterionReports", json(criterionReports))
                .addValue("subgroupReports", json(subgroupReports)).addValue("abstentionReport", json(abstentionReport)));
    }
}
