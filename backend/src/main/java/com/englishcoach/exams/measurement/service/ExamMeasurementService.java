package com.englishcoach.exams.measurement.service;

import com.englishcoach.exams.measurement.analytics.ExamCttAnalytics;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.*;
import com.englishcoach.exams.measurement.repository.ExamMeasurementRepository;
import com.englishcoach.exams.model.ExamContentRecords.AnswerSpecRecord;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Orchestrates collection from the real runtime tables and calculation of an
 * append-only pilot run.  It never accepts a caller-provided learner or human
 * label as evidence.
 */
@Service
@RequiredArgsConstructor
public class ExamMeasurementService {

    private final ExamMeasurementRepository repository;
    private final ExamObjectiveScorer objectiveScorer;

    @Transactional
    public List<UUID> collectRuntimeAttempt(UUID attemptId, Long operatorId) {
        List<RuntimeObservationRow> rows = repository.findRuntimeObservationRows(attemptId);
        if (rows.isEmpty()) throw new IllegalArgumentException("No submitted runtime rows for attempt: " + attemptId);
        List<UUID> eventIds = new ArrayList<>();
        for (RuntimeObservationRow row : rows) {
            Optional<String> latestConsent = repository.latestConsentStatus(row.userId(), "EXAMS_PILOT");
            ConsentStatus consent = latestConsent.map(v -> ConsentStatus.valueOf(v)).orElse(ConsentStatus.UNKNOWN);
            UUID consentReference = consent == ConsentStatus.GRANTED
                    ? repository.latestGrantedConsent(row.userId(), "EXAMS_PILOT").orElse(null) : null;

            Outcome outcome = outcome(row);
            String eventHash = sha256(String.join("|", row.attemptId().toString(), row.submissionId().toString(),
                    row.responseId().toString(), row.manifestHash(), row.submissionHash(), String.valueOf(row.responseRevision()),
                    String.valueOf(outcome.status), String.valueOf(outcome.scoreAwarded)));
            UUID eventId = repository.insertEvent(row, consent, consentReference,
                    SourceType.RUNTIME_EXPORT, EvidenceClass.RUNTIME_OPERATIONAL, outcome.status, outcome.source,
                    outcome.scoreAwarded, outcome.maxScore, row.responseTimeMs(), row.selectedOption(), row.answerPayload(),
                    eventHash, operatorId);
            eventIds.add(eventId);
        }
        return List.copyOf(eventIds);
    }

    private Outcome outcome(RuntimeObservationRow row) {
        Object learnerResponse = row.answerPayload() == null || row.answerPayload().isEmpty()
                ? row.textResponse() : row.answerPayload();
        double max = row.creditUnits() > 0 ? row.creditUnits() : 1.0;
        if (learnerResponse == null || (learnerResponse instanceof String s && s.isBlank())) {
            return new Outcome(OutcomeStatus.OMITTED, OutcomeSource.UNAVAILABLE, 0.0, max);
        }
        if (!row.hasAnswerSpec() || row.acceptedAnswers() == null || row.acceptedAnswers().isEmpty()) {
            return new Outcome(OutcomeStatus.UNKNOWN, OutcomeSource.UNAVAILABLE, null, null);
        }
        AnswerSpecRecord spec = new AnswerSpecRecord(null, row.itemId(), row.acceptedAnswers(), row.normalizationPolicy(),
                row.cardinality(), null, max, null, null, null);
        ExamObjectiveScorer.ItemScoreResult result = objectiveScorer.scoreItem(row.itemId(), learnerResponse, spec);
        return new Outcome(result.isCorrect() ? OutcomeStatus.CORRECT : OutcomeStatus.INCORRECT,
                OutcomeSource.ANSWER_SPEC, result.creditAwarded(), result.maxCredit());
    }

    @Transactional(readOnly = true)
    public List<MeasurementEvent> getAttemptEvents(UUID attemptId) {
        return repository.findEventsByAttempt(attemptId);
    }

    @Transactional(readOnly = true)
    public Optional<Map<String, Object>> getRunWithItemStatistics(UUID runId) {
        return repository.findRun(runId)
                .map(run -> Map.of("run", run, "items", repository.findItemStatistics(runId)));
    }

    @Transactional(readOnly = true)
    public List<MeasurementEvent> getRunEvents(UUID runId) {
        return repository.findEventsByRun(runId);
    }

    @Transactional
    public UUID recordPilotConsent(Long participantUserId, Long actorUserId, String status, String consentHash) {
        return recordConsent(participantUserId, actorUserId, "EXAMS_PILOT", status, consentHash);
    }

    @Transactional
    public UUID recordHumanRatingConsent(Long participantUserId, Long actorUserId, String status, String consentHash) {
        return recordConsent(participantUserId, actorUserId, "EXAMS_HUMAN_RATING", status, consentHash);
    }

    private UUID recordConsent(Long participantUserId, Long actorUserId, String purpose, String status, String consentHash) {
        if (participantUserId == null || actorUserId == null || !participantUserId.equals(actorUserId)) {
            throw new IllegalArgumentException("Consent must be an authenticated participant action");
        }
        if (!Set.of("GRANTED", "WITHDRAWN").contains(status) || consentHash == null || consentHash.length() != 64) {
            throw new IllegalArgumentException("Consent status/hash is invalid");
        }
        return repository.recordConsent(participantUserId, purpose, status, actorUserId, consentHash);
    }

    @Transactional
    public UUID createRun(com.englishcoach.exams.model.ExamTypes.ExamFamily family,
                          com.englishcoach.exams.model.ExamTypes.SkillType skill, UUID formId,
                          List<UUID> attemptIds, Map<String, Object> filter,
                          String consentPolicyVersion, Long operatorId) {
        if (attemptIds == null || attemptIds.isEmpty()) throw new IllegalArgumentException("At least one attempt is required");
        List<MeasurementEvent> events = attemptIds.stream().filter(Objects::nonNull)
                .flatMap(id -> repository.findEventsByAttempt(id).stream()).toList();
        List<MeasurementEvent> matching = events.stream().filter(e -> e.family() == family)
                .filter(e -> skill == null || e.skill() == skill)
                .filter(e -> formId == null || formId.equals(e.formId())).toList();
        if (matching.isEmpty()) throw new IllegalArgumentException("No collected events match the run scope");
        String inputHash = sha256(matching.stream().map(MeasurementEvent::id).sorted().map(UUID::toString)
                .collect(Collectors.joining("|")));
        UUID runId = repository.createRun(family, skill, formId, filter, consentPolicyVersion, inputHash, operatorId);
        int excluded = 0;
        for (MeasurementEvent event : matching) {
            String reason = exclusionReason(event);
            if (reason == null) repository.attachRunEvent(runId, event.id(), "INCLUDE", null);
            else {
                repository.attachRunEvent(runId, event.id(), "EXCLUDE", reason);
                repository.insertExclusion(runId, event.id(), reason, exclusionDetail(event), operatorId);
                excluded++;
            }
        }
        repository.updateRunCounts(runId, RunStatus.RAW, matching.size(), matching.size() - excluded, excluded, null);
        return runId;
    }

    private String exclusionReason(MeasurementEvent event) {
        if (event.consentStatus() != ConsentStatus.GRANTED) return "CONSENT_NOT_GRANTED";
        if (event.evidenceClass() != EvidenceClass.RUNTIME_OPERATIONAL) return "SYNTHETIC_EVIDENCE_NOT_PILOT";
        if (event.attemptMode() == null || !event.attemptMode().equals("EXAM_SIMULATION")) return "NOT_EXAM_SIMULATION";
        if (event.exposureStatus() == ExposureStatus.FAMILIAR) return "EXPOSED_CONTENT";
        if (event.outcomeStatus() == OutcomeStatus.UNKNOWN || event.outcomeStatus() == OutcomeStatus.ABSTAINED) return "OUTCOME_UNKNOWN";
        return null;
    }

    private String exclusionDetail(MeasurementEvent event) {
        return "event=" + event.id() + ";user=" + event.userId() + ";consent=" + event.consentStatus()
                + ";exposure=" + event.exposureStatus() + ";outcome=" + event.outcomeStatus();
    }

    @Transactional
    public AnalysisReport calculateRun(UUID runId) {
        RunSummary run = repository.findRun(runId).orElseThrow(() -> new IllegalArgumentException("Run not found: " + runId));
        if (run.status() != RunStatus.RAW && run.status() != RunStatus.CLEAN) {
            throw new IllegalStateException("Run is immutable after calculation: " + run.status());
        }
        List<MeasurementEvent> events = repository.findEventsByRun(runId);
        List<ExamCttAnalytics.Observation> observations = events.stream().map(e ->
                new ExamCttAnalytics.Observation(e.attemptId() == null ? null : UUID.nameUUIDFromBytes(("attempt:" + e.attemptId()).getBytes(StandardCharsets.UTF_8)),
                        e.itemId(), e.outcomeStatus(), e.scoreAwarded() == null ? 0 : e.scoreAwarded(),
                        e.maxScore() == null ? 0 : e.maxScore(), e.responseTimeMs(), e.selectedOption())).toList();
        AnalysisReport report = ExamCttAnalytics.report(runId, observations, ExamCttAnalytics.Policy.pilotDefault());
        report.itemStatistics().forEach(stat -> repository.insertItemStatistic(runId, stat));
        RunStatus status = "CALCULATED".equals(report.status()) ? RunStatus.FINAL : RunStatus.INSUFFICIENT;
        repository.updateRunCounts(runId, status, run.rawCount(), report.cleanCount(), run.excludedCount(), Instant.now());
        return report;
    }

    private record Outcome(OutcomeStatus status, OutcomeSource source, Double scoreAwarded, Double maxScore) {}

    public static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(64);
            for (byte b : digest) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) { throw new IllegalStateException("SHA-256 unavailable", e); }
    }
}
