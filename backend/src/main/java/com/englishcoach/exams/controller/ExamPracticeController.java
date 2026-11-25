package com.englishcoach.exams.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.practice.ExamPracticeRecords.*;
import com.englishcoach.exams.practice.ExamPracticeService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

/**
 * Exams Phase 6 — Practice + Review. The learner names a form and a canonical scope code; the server resolves the
 * content. Attempt-scoped endpoints are owner-only: a missing, foreign or non-practice attempt is a 404. The runner
 * itself is the canonical attempt runtime ({@code /api/v1/exams/attempts/{id}/...}).
 */
@RestController
@RequestMapping("/api/v1/exams")
@RequiredArgsConstructor
public class ExamPracticeController {

    private final ExamPracticeService practiceService;
    private final com.englishcoach.exams.security.ExamRateLimiter rateLimiter;

    /** Public (same as form details): learner-safe availability per scope, no internal reason codes. */
    @GetMapping("/forms/{formId}/practice-scopes")
    public ResponseEntity<PracticeCatalogDto> getPracticeScopes(@PathVariable UUID formId) {
        return ResponseEntity.ok(practiceService.getCatalog(formId));
    }

    @PostMapping("/practice/attempts")
    public ResponseEntity<PracticeAttemptDto> createPracticeAttempt(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestBody CreatePracticeAttemptRequest request
    ) {
        if (userDetails == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        rateLimiter.check(com.englishcoach.exams.security.ExamRateLimiter.Operation.CREATE_PRACTICE_ATTEMPT, userDetails.getId());
        PracticeAttemptDto dto = practiceService.createPracticeAttempt(userDetails.getId(), request);
        return ResponseEntity.status(dto.resumedExisting() ? HttpStatus.OK : HttpStatus.CREATED).body(dto);
    }

    @PostMapping("/practice/attempts/{attemptId}/again")
    public ResponseEntity<PracticeAttemptDto> practiceAgain(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID attemptId,
            @RequestBody(required = false) PracticeAgainRequest request
    ) {
        if (userDetails == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        rateLimiter.check(com.englishcoach.exams.security.ExamRateLimiter.Operation.PRACTICE_AGAIN, userDetails.getId());
        PracticeAttemptDto dto = practiceService.practiceAgain(userDetails.getId(), attemptId,
                request == null ? null : request.clientMutationId());
        return ResponseEntity.status(dto.resumedExisting() ? HttpStatus.OK : HttpStatus.CREATED).body(dto);
    }

    @GetMapping("/practice/attempts/{attemptId}/result")
    public ResponseEntity<PracticeResultDto> getPracticeResult(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID attemptId
    ) {
        if (userDetails == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        return ResponseEntity.ok(practiceService.getResult(userDetails.getId(), attemptId));
    }

    /** Correct answers only after submission, from the attempt snapshot, to the owner (409 before submission). */
    @GetMapping("/practice/attempts/{attemptId}/review")
    public ResponseEntity<PracticeReviewDto> getPracticeReview(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID attemptId
    ) {
        if (userDetails == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        return ResponseEntity.ok(practiceService.getReview(userDetails.getId(), attemptId));
    }
}
