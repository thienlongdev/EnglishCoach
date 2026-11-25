package com.englishcoach.exams.measurement.service;

import com.englishcoach.exams.measurement.analytics.ExamScorerEvaluation;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.*;
import com.englishcoach.exams.measurement.repository.ExamMeasurementRepository;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.InputStream;
import java.io.SequenceInputStream;
import java.time.Instant;
import java.util.*;

/** Authenticated human rating and locked-gold/evaluation workflow. */
@Service
@RequiredArgsConstructor
public class ExamRaterService {

    private final ExamMeasurementRepository repository;
    private final ExamMediaRepository mediaRepository;
    private final ExamObjectStorage objectStorage;

    @Transactional(readOnly = true)
    public Optional<GoldDataset> getGoldDataset(UUID datasetId) {
        return repository.findGoldDataset(datasetId);
    }

    @Transactional(readOnly = true)
    public List<RaterAssignment> getRaterAssignments(UUID datasetId, Long raterUserId) {
        return repository.findRaterAssignmentsForUser(datasetId, raterUserId);
    }

    @Transactional(readOnly = true)
    public List<RaterRatingSummary> getRatingsForAdjudication(UUID datasetId, UUID responseId, Long actorId) {
        return repository.findRatingsForAdjudication(datasetId, responseId, actorId);
    }

    @Transactional(readOnly = true)
    public Optional<RaterAssignmentView> getAssignmentView(UUID assignmentId, Long actorId) {
        return repository.findRaterAssignmentView(assignmentId, actorId);
    }

    @Transactional
    public UUID createDataset(String logicalCode, int version, ExamFamily family, SkillType skill,
                              UUID rubricVersionId, String consentPolicyVersion, String provenanceStatement,
                              Long actorId) {
        if (logicalCode == null || logicalCode.isBlank() || version <= 0 || family == null || skill == null
                || consentPolicyVersion == null || consentPolicyVersion.isBlank()
                || provenanceStatement == null || provenanceStatement.isBlank()) {
            throw new IllegalArgumentException("Human-gold dataset identity/provenance is incomplete");
        }
        return repository.createGoldDataset(logicalCode, version, family, skill, rubricVersionId,
                consentPolicyVersion, provenanceStatement, actorId);
    }

    @Transactional
    public UUID addMember(UUID datasetId, UUID responseId, UUID attemptId, UUID consentId, Split split, Long actorId) {
        GoldDataset dataset = repository.findGoldDataset(datasetId).orElseThrow(() -> new IllegalArgumentException("Dataset not found"));
        if (!"DRAFT".equals(dataset.status())) throw new IllegalStateException("Gold dataset is locked");
        Long owner = repository.responseOwner(responseId).orElseThrow(() -> new IllegalArgumentException("Response not found"));
        if (!repository.grantedConsent(consentId, owner, "EXAMS_HUMAN_RATING")) {
            throw new IllegalArgumentException("A participant consent action is required for human-gold membership");
        }
        if (split == null) throw new IllegalArgumentException("Gold split is required");
        return repository.insertGoldMember(datasetId, responseId, attemptId, dataset.family(), dataset.skill(), consentId, split, actorId);
    }

    @Transactional
    public void lockDataset(UUID datasetId, Long actorId) {
        GoldDataset dataset = repository.findGoldDataset(datasetId).orElseThrow(() -> new IllegalArgumentException("Dataset not found"));
        if (!"DRAFT".equals(dataset.status())) throw new IllegalStateException("Gold dataset is already locked");
        repository.lockGoldDataset(datasetId, actorId);
    }

    @Transactional
    public UUID assign(UUID datasetId, UUID responseId, UUID attemptId, Long raterUserId, Long assignedBy) {
        GoldDataset dataset = repository.findGoldDataset(datasetId).orElseThrow(() -> new IllegalArgumentException("Dataset not found"));
        if (!"LOCKED".equals(dataset.status())) throw new IllegalStateException("Assignments require a locked gold dataset");
        if (Objects.equals(raterUserId, assignedBy)) throw new IllegalArgumentException("Rater and assigning operator must be independent");
        return repository.createRaterAssignment(datasetId, responseId, attemptId, dataset.family(), dataset.skill(), raterUserId, assignedBy);
    }

    @Transactional
    public void rate(RatingSubmission submission, Long actorId) {
        if (submission == null || submission.assignmentId() == null || submission.criterionScores() == null
                || submission.criterionScores().isEmpty() || submission.ratingHash() == null
                || !submission.ratingHash().matches("[0-9a-fA-F]{64}")) {
            throw new IllegalArgumentException("Rating must contain criteria and an immutable hash");
        }
        RaterAssignment assignment = repository.findRaterAssignment(submission.assignmentId())
                .orElseThrow(() -> new IllegalArgumentException("Assignment not found"));
        if (!Objects.equals(assignment.raterUserId(), actorId)) throw new IllegalArgumentException("Authenticated rater does not own assignment");
        RatingSubmission authenticatedSubmission = new RatingSubmission(submission.assignmentId(), actorId,
                submission.rubricVersionId(), submission.criterionScores(), submission.overallScore(),
                submission.confidence(), submission.ratingHash());
        repository.insertRating(authenticatedSubmission, actorId);
    }

    /**
     * Open a sealed recording only after the measurement repository has proved
     * assignment ownership or adjudicator independence, dataset membership,
     * response/attempt linkage, and still-granted participant consent.
     */
    @Transactional(readOnly = true)
    public RaterRecordingStream openRecording(UUID assignmentId, Long actorId) {
        RaterRecordingAccess access = repository.findRaterRecordingAccess(assignmentId, actorId)
                .orElseThrow(() -> new SecurityException("Recording is not available to this authenticated rater"));
        var recording = mediaRepository.findRecordingById(access.recordingId())
                .orElseThrow(() -> new IllegalArgumentException("Recording not found"));
        if (!Objects.equals(recording.attemptId(), access.attemptId())
                || !Objects.equals(recording.responseId(), access.responseId())) {
            throw new SecurityException("Recording identity does not match the assigned response");
        }
        if (recording.state() != com.englishcoach.exams.model.ExamTypes.RecordingState.SEALED
                && recording.state() != com.englishcoach.exams.model.ExamTypes.RecordingState.VERIFIED) {
            throw new IllegalStateException("Recording is not sealed for rating");
        }
        var chunks = mediaRepository.findChunksByRecordingId(access.recordingId());
        if (chunks.isEmpty()) throw new IllegalStateException("Recording has no sealed chunks");
        if (chunks.size() > ExamMediaService.MAX_CHUNKS_PER_RECORDING) {
            throw new IllegalStateException("Recording exceeds maximum chunk count");
        }
        long bytes = 0;
        for (var chunk : chunks) {
            bytes += chunk.byteSize();
            if (bytes > ExamMediaService.MAX_RECORDING_TOTAL_BYTES) {
                throw new IllegalStateException("Recording exceeds maximum allowed size");
            }
        }
        Vector<InputStream> streams = new Vector<>();
        try {
            for (var chunk : chunks) {
                streams.add(objectStorage.getObjectStream(chunk.objectKey()));
            }
        } catch (RuntimeException e) {
            for (InputStream s : streams) {
                try { if (s != null) s.close(); } catch (Exception ignored) {}
            }
            throw e;
        }
        String contentType = ExamMediaService.sanitizeAudioMediaType(recording.codec()).toString();
        return new RaterRecordingStream(new SequenceInputStream(streams.elements()), contentType, bytes);
    }

    public record RaterRecordingStream(InputStream stream, String contentType, long contentLength) {}

    @Transactional
    public void adjudicate(UUID responseId, UUID datasetId, UUID selectedRatingId, Map<String, Object> finalScores,
                            String disagreementReason, String decisionHash, Long adjudicatorId) {
        if (responseId == null || finalScores == null || finalScores.isEmpty()
                || disagreementReason == null || disagreementReason.isBlank()
                || decisionHash == null || !decisionHash.matches("[0-9a-fA-F]{64}")) {
            throw new IllegalArgumentException("Adjudication requires final scores, reason, and hash");
        }
        repository.insertAdjudication(responseId, datasetId, adjudicatorId, selectedRatingId, finalScores,
                disagreementReason, decisionHash);
    }

    @Transactional
    public EvaluationReport evaluate(UUID datasetId, String scorerName, String scorerVersion, String lockedTestHash,
                                     List<EvaluationRecord> records, Long actorId) {
        GoldDataset dataset = repository.findGoldDataset(datasetId).orElseThrow(() -> new IllegalArgumentException("Dataset not found"));
        if (!"LOCKED".equals(dataset.status()) && !"RELEASED".equals(dataset.status()))
            throw new IllegalStateException("Evaluation requires a locked gold dataset");
        if (lockedTestHash == null || !lockedTestHash.matches("[0-9a-fA-F]{64}"))
            throw new IllegalArgumentException("Locked test hash is required");
        if (records == null || records.isEmpty()) throw new IllegalArgumentException("Evaluation records are required");
        for (EvaluationRecord record : records) {
            if (!repository.datasetContainsMember(datasetId, record.memberId()))
                throw new IllegalArgumentException("Evaluation record is outside the selected dataset");
        }
        EvaluationReport report = ExamScorerEvaluation.evaluate(records, true, ExamScorerEvaluation.Policy.defaultPolicy());
        UUID runId = repository.createEvaluationRun(datasetId, scorerName, scorerVersion,
                Map.of("splits", List.of("DEVELOPMENT", "CALIBRATION", "VALIDATION", "TEST")), lockedTestHash, actorId);
        records.forEach(record -> repository.insertEvaluationRecord(runId, record));
        repository.completeEvaluation(runId, report.overall().status(), metricMap(report.overall()),
                report.byCriterion().entrySet().stream().collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, e -> metricMap(e.getValue()))),
                report.bySubgroup().entrySet().stream().collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, e -> metricMap(e.getValue()))),
                Map.of("abstentionRate", report.overall().abstentionRate(), "abstainedCount", report.overall().abstainedCount()));
        return report;
    }

    private Map<String, Object> metricMap(EvaluationMetrics metrics) {
        return Map.ofEntries(
                Map.entry("sampleSize", metrics.sampleSize()), Map.entry("scoredCount", metrics.scoredCount()),
                Map.entry("abstainedCount", metrics.abstainedCount()), Map.entry("mae", nullable(metrics.mae())),
                Map.entry("rmse", nullable(metrics.rmse())), Map.entry("exactRate", nullable(metrics.exactRate())),
                Map.entry("adjacentRate", nullable(metrics.adjacentRate())), Map.entry("kappa", nullable(metrics.kappa())),
                Map.entry("correlation", nullable(metrics.correlation())), Map.entry("abstentionRate", metrics.abstentionRate()),
                Map.entry("status", metrics.status()), Map.entry("reason", nullable(metrics.reason())));
    }

    private Object nullable(Object value) { return value == null ? "UNDEFINED" : value; }
}
