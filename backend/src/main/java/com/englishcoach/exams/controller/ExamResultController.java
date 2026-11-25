package com.englishcoach.exams.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.job.ExamJobService;
import com.englishcoach.exams.model.ExamScoringRecords.AttemptReviewDto;
import com.englishcoach.exams.model.ExamScoringRecords.ExamResultDto;
import com.englishcoach.exams.model.ExamScoringRecords.ScoringProgressDto;
import com.englishcoach.exams.service.ExamResultService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.Optional;
import java.util.UUID;

@Slf4j
@RestController
@RequestMapping("/api/v1/exams/results")
public class ExamResultController {

    private final ExamResultService resultService;
    private final ExamJobService jobService;
    /** Exams Phase 9A: the admin read of a learner's result is decided by the canonical official-admin check. */
    private final com.englishcoach.auth.policy.AdminIdentityService adminIdentity;

    @org.springframework.beans.factory.annotation.Autowired
    public ExamResultController(ExamResultService resultService, ExamJobService jobService,
                                com.englishcoach.auth.policy.AdminIdentityService adminIdentity) {
        this.resultService = resultService;
        this.jobService = jobService;
        this.adminIdentity = adminIdentity;
    }

    /** Test wiring without the identity service: nobody is treated as an administrator (fail closed). */
    public ExamResultController(ExamResultService resultService, ExamJobService jobService) {
        this(resultService, jobService, null);
    }

    private boolean officialAdmin(UserDetailsImpl userDetails) {
        return userDetails != null && adminIdentity != null && adminIdentity.isOfficialAdmin(userDetails.getId());
    }

    /**
     * Get attempt result. Returns 200 OK with any persisted terminal ExamResultDto,
     * or 202 Accepted with ScoringProgressDto if scoring is currently underway.
     */
    @GetMapping("/{attemptId}")
    public ResponseEntity<?> getResult(
            @PathVariable UUID attemptId,
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(401).build();
        }
        Long userId = userDetails.getId();
        boolean isAdmin = officialAdmin(userDetails);

        Optional<ExamResultDto> resultOpt = resultService.getAttemptResult(attemptId, userId, isAdmin);
        if (resultOpt.isPresent()) {
            ExamResultDto res = resultOpt.get();
            // The worker persists an artifact after scoring, including REVIEW_REQUIRED / FAILED.
            // Numeric-score eligibility is enforced by the result service. It is not a job-progress
            // condition: a finished submission without an Overall must remain readable.
            return ResponseEntity.ok(res);
        }

        // If not ready yet, return progress status
        Optional<ScoringProgressDto> progressOpt = jobService.getAttemptScoringProgress(attemptId);
        if (progressOpt.isPresent()) {
            return ResponseEntity.accepted().body(progressOpt.get());
        }

        return ResponseEntity.notFound().build();
    }

    /**
     * Get scoring progress specifically.
     */
    @GetMapping("/{attemptId}/progress")
    public ResponseEntity<ScoringProgressDto> getProgress(
            @PathVariable UUID attemptId,
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(401).build();
        }
        Long userId = userDetails.getId();
        boolean isAdmin = officialAdmin(userDetails);

        // Enforce attempt ownership before exposing scoring progress
        resultService.getAttemptResult(attemptId, userId, isAdmin);

        return jobService.getAttemptScoringProgress(attemptId)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Get post-exam item-by-item review.
     * Enforces embargo: cannot review unsubmitted simulations.
     */
    @GetMapping("/{attemptId}/review")
    public ResponseEntity<AttemptReviewDto> getReview(
            @PathVariable UUID attemptId,
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(401).build();
        }
        Long userId = userDetails.getId();
        boolean isAdmin = officialAdmin(userDetails);

        AttemptReviewDto review = resultService.getAttemptReview(attemptId, userId, isAdmin);
        return ResponseEntity.ok(review);
    }

    /**
     * Get post-exam Speaking review specifically.
     * Enforces embargo: cannot review unsubmitted simulations.
     */
    @GetMapping("/{attemptId}/speaking-review")
    public ResponseEntity<com.englishcoach.exams.model.ExamSpeakingReviewRecords.SpeakingAttemptReviewDto> getSpeakingReview(
            @PathVariable UUID attemptId,
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(401).build();
        }
        Long userId = userDetails.getId();
        boolean isAdmin = officialAdmin(userDetails);

        AttemptReviewDto review = resultService.getAttemptReview(attemptId, userId, isAdmin);
        if (review.speakingReview() == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(review.speakingReview());
    }
}
