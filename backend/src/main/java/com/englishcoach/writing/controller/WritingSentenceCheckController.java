package com.englishcoach.writing.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import com.englishcoach.writing.dto.SentenceCheckResultDto;
import com.englishcoach.writing.dto.SentenceCheckSubmissionRequest;
import com.englishcoach.writing.service.WritingAssessmentService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@Slf4j
@RestController
@RequestMapping("/api/v1/writing")
@RequiredArgsConstructor
public class WritingSentenceCheckController {

    private final WritingAssessmentService writingAssessmentService;

    private Long requireUserId(UserDetailsImpl userDetails) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required for sentence check operations");
        }
        return userDetails.getId();
    }

    @RequirePremiumAi("WRITING_AI_FEEDBACK")
    @PostMapping("/sentence-checks")
    public ResponseEntity<SentenceCheckResultDto> submitSentenceCheck(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody SentenceCheckSubmissionRequest request
    ) {
        Long userId = requireUserId(userDetails);
        log.info("Received sentence check request from user {}", userId);
        SentenceCheckResultDto result = writingAssessmentService.submitSentenceCheck(userId, request);
        return ResponseEntity.status(HttpStatus.CREATED).body(result);
    }

    @GetMapping("/assessments/{id}")
    public ResponseEntity<SentenceCheckResultDto> getAssessment(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingAssessmentService.getAssessment(userId, id));
    }

    @PostMapping("/assessments/{id}/retry")
    public ResponseEntity<SentenceCheckResultDto> retryAssessment(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingAssessmentService.retryAssessment(userId, id));
    }
}
