package com.englishcoach.exams.service;

import com.englishcoach.exams.model.ExamProfileRecords.*;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.exams.repository.ExamProfileRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class ExamProfileService {

    private final ExamProfileRepository profileRepository;
    private final ExamRecommendationService recommendationService;

    /**
     * Build IELTS Competency Profile read model.
     * Invariants:
     * - ONLY trusted SIMULATION evidence included (enforced by DB trigger & worker).
     * - Overall score only computed from eligible same-attempt measurements.
     * - Independent skill tests never create Overall.
     * - Never merge with TOEIC.
     */
    public IeltsProfileDto getIeltsProfile(Long userId) {
        MetricSummaryDto overallSummary = buildMetricSummary(userId, ExamFamily.IELTS, ScoreMetric.FULL_OVERALL.name());
        MetricSummaryDto listeningSummary = buildMetricSummary(userId, ExamFamily.IELTS, ScoreMetric.LISTENING.name());
        MetricSummaryDto readingSummary = buildMetricSummary(userId, ExamFamily.IELTS, ScoreMetric.READING.name());
        MetricSummaryDto writingSummary = buildMetricSummary(userId, ExamFamily.IELTS, ScoreMetric.WRITING.name());
        MetricSummaryDto speakingSummary = buildMetricSummary(userId, ExamFamily.IELTS, ScoreMetric.SPEAKING.name());

        List<ProfileEvidenceRecord> allEvidence = profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.IELTS, ScoreMetric.FULL_OVERALL.name());
        List<ProfileEvidenceRecord> lList = profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.IELTS, ScoreMetric.LISTENING.name());
        List<ProfileEvidenceRecord> rList = profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.IELTS, ScoreMetric.READING.name());
        List<ProfileEvidenceRecord> wList = profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.IELTS, ScoreMetric.WRITING.name());
        List<ProfileEvidenceRecord> sList = profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.IELTS, ScoreMetric.SPEAKING.name());

        // Group evidence by artifactId to ensure all components strictly belong to the same canonical scoring run
        Map<UUID, List<ProfileEvidenceRecord>> byArtifact = new LinkedHashMap<>();
        for (ProfileEvidenceRecord ev : allEvidence) byArtifact.computeIfAbsent(ev.artifactId(), k -> new ArrayList<>()).add(ev);
        for (ProfileEvidenceRecord ev : lList) byArtifact.computeIfAbsent(ev.artifactId(), k -> new ArrayList<>()).add(ev);
        for (ProfileEvidenceRecord ev : rList) byArtifact.computeIfAbsent(ev.artifactId(), k -> new ArrayList<>()).add(ev);
        for (ProfileEvidenceRecord ev : wList) byArtifact.computeIfAbsent(ev.artifactId(), k -> new ArrayList<>()).add(ev);
        for (ProfileEvidenceRecord ev : sList) byArtifact.computeIfAbsent(ev.artifactId(), k -> new ArrayList<>()).add(ev);

        List<IeltsObservationDto> observations = new ArrayList<>();
        Set<UUID> seenAttempts = new HashSet<>();

        // Sort artifacts descending by measurement date
        List<Map.Entry<UUID, List<ProfileEvidenceRecord>>> sortedEntries = new ArrayList<>(byArtifact.entrySet());
        sortedEntries.sort((e1, e2) -> e2.getValue().get(0).measurementDate().compareTo(e1.getValue().get(0).measurementDate()));

        for (Map.Entry<UUID, List<ProfileEvidenceRecord>> entry : sortedEntries) {
            UUID artifactId = entry.getKey();
            List<ProfileEvidenceRecord> list = entry.getValue();
            ProfileEvidenceRecord first = list.get(0);
            UUID attemptId = first.attemptId();

            if (seenAttempts.contains(attemptId)) {
                continue;
            }

            Double overall = null, listening = null, reading = null, writing = null, speaking = null;
            for (ProfileEvidenceRecord ev : list) {
                if (ScoreMetric.FULL_OVERALL.name().equals(ev.metric())) overall = ev.scoreValue();
                else if (ScoreMetric.LISTENING.name().equals(ev.metric())) listening = ev.scoreValue();
                else if (ScoreMetric.READING.name().equals(ev.metric())) reading = ev.scoreValue();
                else if (ScoreMetric.WRITING.name().equals(ev.metric())) writing = ev.scoreValue();
                else if (ScoreMetric.SPEAKING.name().equals(ev.metric())) speaking = ev.scoreValue();
            }

            boolean isOSR = "OSR".equalsIgnoreCase(first.scope());
            boolean isFullMock = "FULL".equalsIgnoreCase(first.scope()) || "FULL_MOCK".equalsIgnoreCase(first.scope())
                    || (first.cohortKey() != null && first.cohortKey().toUpperCase().contains("FULL"));
            // Atomic Full Mock Invariant: require all 5 metrics to be present on the same canonical run
            if (isFullMock && (overall == null || listening == null || reading == null || writing == null || speaking == null)) {
                continue;
            }

            seenAttempts.add(attemptId);
            observations.add(new IeltsObservationDto(
                    attemptId,
                    artifactId,
                    first.measurementDate(),
                    first.cohortKey(),
                    first.scope(),
                    overall,
                    listening,
                    reading,
                    writing,
                    speaking,
                    first.exposureStatus(),
                    isOSR
            ));
        }

        // Sort descending by date
        observations.sort(Comparator.comparing(IeltsObservationDto::date).reversed());

        // Canonical top card synchronization: If newest observation is a complete Full Mock,
        // guarantee all 5 top cards reflect the exact same canonical artifact
        if (!observations.isEmpty()) {
            IeltsObservationDto latestObs = observations.get(0);
            if (latestObs.overall() != null && latestObs.listening() != null && latestObs.reading() != null
                    && latestObs.writing() != null && latestObs.speaking() != null) {
                overallSummary = new MetricSummaryDto(latestObs.overall(), overallSummary.best(), latestObs.date(), overallSummary.bestDate(), overallSummary.trendSlope(), overallSummary.trendDirection());
                listeningSummary = new MetricSummaryDto(latestObs.listening(), listeningSummary.best(), latestObs.date(), listeningSummary.bestDate(), listeningSummary.trendSlope(), listeningSummary.trendDirection());
                readingSummary = new MetricSummaryDto(latestObs.reading(), readingSummary.best(), latestObs.date(), readingSummary.bestDate(), readingSummary.trendSlope(), readingSummary.trendDirection());
                writingSummary = new MetricSummaryDto(latestObs.writing(), writingSummary.best(), latestObs.date(), writingSummary.bestDate(), writingSummary.trendSlope(), writingSummary.trendDirection());
                speakingSummary = new MetricSummaryDto(latestObs.speaking(), speakingSummary.best(), latestObs.date(), speakingSummary.bestDate(), speakingSummary.trendSlope(), speakingSummary.trendDirection());
            }
        }

        String confidenceState = observations.isEmpty() ?
                "INSUFFICIENT_COMPARABLE_EVIDENCE" : "SIMULATION_EVIDENCE";

        List<RecommendationDto> recommendations = recommendationService.getUserRecommendations(userId);

        return new IeltsProfileDto(
                overallSummary,
                listeningSummary,
                readingSummary,
                writingSummary,
                speakingSummary,
                observations,
                "IELTS_STANDARD_ACADEMIC_GT",
                confidenceState,
                recommendations
        );
    }

    /**
     * Build TOEIC Competency Profile read model.
     * Invariants:
     * - ONLY trusted SIMULATION evidence included.
     * - Listening (5-495), Reading (5-495), L&R Total (10-990).
     * - Speaking (0-200), Writing (0-200).
     * - ABSOLUTE INVARIANT: NO 4-skill Overall for TOEIC!
     * - Never merge with IELTS.
     */
    public ToeicProfileDto getToeicProfile(Long userId) {
        MetricSummaryDto lrTotalSummary = buildMetricSummary(userId, ExamFamily.TOEIC, ScoreMetric.LR_TOTAL.name());
        MetricSummaryDto listeningSummary = buildMetricSummary(userId, ExamFamily.TOEIC, ScoreMetric.LISTENING.name());
        MetricSummaryDto readingSummary = buildMetricSummary(userId, ExamFamily.TOEIC, ScoreMetric.READING.name());
        MetricSummaryDto speakingSummary = buildMetricSummary(userId, ExamFamily.TOEIC, ScoreMetric.SPEAKING.name());
        MetricSummaryDto writingSummary = buildMetricSummary(userId, ExamFamily.TOEIC, ScoreMetric.WRITING.name());

        List<ProfileEvidenceRecord> lrList = profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.LR_TOTAL.name());
        List<ProfileEvidenceRecord> lList = profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.LISTENING.name());
        List<ProfileEvidenceRecord> rList = profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.READING.name());
        List<ProfileEvidenceRecord> sList = profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.SPEAKING.name());
        List<ProfileEvidenceRecord> wList = profileRepository.findEvidenceByUserAndMetric(userId, ExamFamily.TOEIC, ScoreMetric.WRITING.name());

        Map<UUID, List<ProfileEvidenceRecord>> byAttempt = new LinkedHashMap<>();
        for (ProfileEvidenceRecord ev : lrList) byAttempt.computeIfAbsent(ev.attemptId(), k -> new ArrayList<>()).add(ev);
        for (ProfileEvidenceRecord ev : lList) byAttempt.computeIfAbsent(ev.attemptId(), k -> new ArrayList<>()).add(ev);
        for (ProfileEvidenceRecord ev : rList) byAttempt.computeIfAbsent(ev.attemptId(), k -> new ArrayList<>()).add(ev);
        for (ProfileEvidenceRecord ev : sList) byAttempt.computeIfAbsent(ev.attemptId(), k -> new ArrayList<>()).add(ev);
        for (ProfileEvidenceRecord ev : wList) byAttempt.computeIfAbsent(ev.attemptId(), k -> new ArrayList<>()).add(ev);

        List<ToeicObservationDto> observations = new ArrayList<>();
        for (Map.Entry<UUID, List<ProfileEvidenceRecord>> entry : byAttempt.entrySet()) {
            UUID attemptId = entry.getKey();
            List<ProfileEvidenceRecord> list = entry.getValue();
            ProfileEvidenceRecord first = list.get(0);

            Double lrTotal = null, listening = null, reading = null, speaking = null, writing = null;
            for (ProfileEvidenceRecord ev : list) {
                if (ScoreMetric.LR_TOTAL.name().equals(ev.metric())) lrTotal = ev.scoreValue();
                else if (ScoreMetric.LISTENING.name().equals(ev.metric())) listening = ev.scoreValue();
                else if (ScoreMetric.READING.name().equals(ev.metric())) reading = ev.scoreValue();
                else if (ScoreMetric.SPEAKING.name().equals(ev.metric())) speaking = ev.scoreValue();
                else if (ScoreMetric.WRITING.name().equals(ev.metric())) writing = ev.scoreValue();
            }

            observations.add(new ToeicObservationDto(
                    attemptId,
                    first.artifactId(),
                    first.measurementDate(),
                    first.cohortKey(),
                    lrTotal,
                    listening,
                    reading,
                    speaking,
                    writing,
                    first.exposureStatus()
            ));
        }

        observations.sort(Comparator.comparing(ToeicObservationDto::date).reversed());

        String confidenceState = observations.isEmpty() ?
                "INSUFFICIENT_COMPARABLE_EVIDENCE" : "SIMULATION_EVIDENCE";

        List<RecommendationDto> recommendations = recommendationService.getUserRecommendations(userId);

        return new ToeicProfileDto(
                lrTotalSummary,
                listeningSummary,
                readingSummary,
                speakingSummary,
                writingSummary,
                observations,
                "TOEIC_STANDARD_LR_SW",
                confidenceState,
                recommendations
        );
    }

    private MetricSummaryDto buildMetricSummary(Long userId, ExamFamily family, String metric) {
        Optional<ProfileEvidenceRecord> latestOpt = profileRepository.findLatestEvidence(userId, family, metric);
        Optional<ProfileEvidenceRecord> bestOpt = profileRepository.findBestEvidence(userId, family, metric);
        List<ProfileEvidenceRecord> all = profileRepository.findEvidenceByUserAndMetric(userId, family, metric);

        if (latestOpt.isEmpty() || bestOpt.isEmpty()) {
            return new MetricSummaryDto(null, null, null, null, null, "INSUFFICIENT_DATA");
        }

        ProfileEvidenceRecord latest = latestOpt.get();
        ProfileEvidenceRecord best = bestOpt.get();

        String direction = "STABLE";
        Double slope = null;
        if (all.size() >= 2) {
            double firstVal = all.get(0).scoreValue();
            double lastVal = all.get(all.size() - 1).scoreValue();
            slope = lastVal - firstVal;
            if (slope > 0.2) direction = "IMPROVING";
            else if (slope < -0.2) direction = "DECLINING";
        }

        return new MetricSummaryDto(
                latest.scoreValue(),
                best.scoreValue(),
                latest.measurementDate(),
                best.measurementDate(),
                slope,
                direction
        );
    }
}
