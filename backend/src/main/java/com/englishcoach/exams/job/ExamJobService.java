package com.englishcoach.exams.job;

import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.SubmissionRecord;
import com.englishcoach.exams.model.ExamScoringRecords.*;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ExamAttemptStatus;
import com.englishcoach.exams.model.ExamTypes.JobStageStatus;
import com.englishcoach.exams.model.ExamTypes.JobStatus;
import com.englishcoach.exams.model.ExamTypes.ResultStatus;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class ExamJobService {

    private final ExamScoringRepository scoringRepository;
    private final ExamAttemptRepository attemptRepository;

    /**
     * Enqueues durable scoring jobs for a newly submitted attempt.
     */
    @Transactional
    public void enqueueSubmissionJobs(UUID submissionId, ExamFamily family, String scope) {
        log.info("Enqueueing scoring jobs for submission {} family {} scope {}", submissionId, family, scope);

        // Job 1: Process and score submission
        JobRecord scoringJob = new JobRecord(
                UUID.randomUUID(),
                submissionId,
                "SUBMISSION_SCORING",
                "v1",
                1,
                JobStatus.PENDING,
                Instant.now(),
                null,
                null,
                0,
                3,
                null,
                Instant.now(),
                Instant.now()
        );
        scoringRepository.insertJob(scoringJob);
    }

    /**
     * Get current progress of scoring for an attempt.
     */
    public Optional<ScoringProgressDto> getAttemptScoringProgress(UUID attemptId) {
        Optional<SubmissionRecord> subOpt = attemptRepository.findSubmissionByAttemptId(attemptId);
        if (subOpt.isEmpty()) {
            // Older submitted attempts can predate durable submission records. Reading
            // their history must terminate without inventing a score or enqueuing work.
            // Result controllers enforce ownership before calling this method.
            return attemptRepository.findAttemptById(attemptId)
                    .filter(attempt -> attempt.status() == ExamAttemptStatus.SUBMITTED)
                    .map(attempt -> new ScoringProgressDto(attemptId, ResultStatus.REVIEW_REQUIRED,
                            true, List.of(), "Submission saved; scoring feedback is unavailable.", null));
        }
        SubmissionRecord submission = subOpt.get();
        List<JobRecord> jobs = scoringRepository.findJobsBySubmissionId(submission.id());
        List<JobStageRecord> stages = scoringRepository.findStagesBySubmissionId(submission.id());

        boolean allCompleted = !jobs.isEmpty() && jobs.stream().allMatch(j -> j.status() == JobStatus.COMPLETED);
        boolean hasFailed = jobs.stream().anyMatch(j -> j.status() == JobStatus.FAILED);
        boolean needsReview = jobs.stream().anyMatch(j -> j.status() == JobStatus.REVIEW_REQUIRED);
        boolean active = jobs.stream().anyMatch(j -> j.status() == JobStatus.PENDING || j.status() == JobStatus.RUNNING
                || j.status() == JobStatus.RETRY_WAIT);

        ResultStatus status;
        if (allCompleted) {
            status = ResultStatus.COMPLETED;
        } else if (!active && hasFailed) {
            status = ResultStatus.FAILED;
        } else if (!active && (needsReview || jobs.isEmpty() || jobs.stream().anyMatch(j -> j.status() == JobStatus.PARTIAL))) {
            status = ResultStatus.REVIEW_REQUIRED;
        } else {
            status = ResultStatus.PARTIAL;
        }

        List<JobStageSummaryDto> stageSummaries = stages.stream()
                .map(s -> new JobStageSummaryDto(s.stageKey(), s.status(), s.durationMs()))
                .toList();

        // Internal provider/SQL errors stay in operator logs, never learner progress payloads.
        String failureMessage = status == ResultStatus.FAILED || status == ResultStatus.REVIEW_REQUIRED
                ? "Submission saved; scoring feedback is unavailable." : null;

        return Optional.of(new ScoringProgressDto(
                attemptId,
                status,
                allCompleted,
                stageSummaries,
                failureMessage,
                active ? Instant.now().plusSeconds(30) : null
        ));
    }

    /**
     * Admin/Operator manual retry for a failed job.
     */
    @Transactional
    public boolean retryJob(UUID jobId, Long operatorId) {
        log.info("Operator {} requested retry for job {}", operatorId, jobId);
        return scoringRepository.resetJobToPending(jobId);
    }
}
