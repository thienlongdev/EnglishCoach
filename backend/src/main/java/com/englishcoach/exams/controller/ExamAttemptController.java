package com.englishcoach.exams.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.PublicAttemptManifestDto;
import com.englishcoach.exams.model.ExamProfileRecords.AttemptHistoryItemDto;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.service.ExamAttemptService;
import com.englishcoach.exams.service.ExamResponseService;
import com.englishcoach.exams.service.ExamTimingService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Slf4j
@RestController
@RequestMapping("/api/v1/exams")
@RequiredArgsConstructor
public class ExamAttemptController {

    private final ExamAttemptService attemptService;
    private final ExamResponseService responseService;
    private final ExamTimingService timingService;
    private final com.englishcoach.exams.security.ExamRateLimiter rateLimiter;

    @PostMapping("/attempts")
    public ResponseEntity<AttemptStateDto> createAttempt(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestBody CreateAttemptRequest request
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        rateLimiter.check(com.englishcoach.exams.security.ExamRateLimiter.Operation.CREATE_ATTEMPT, userDetails.getId());
        AttemptStateDto attempt = attemptService.createAttempt(userDetails.getId(), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(attempt);
    }

    @GetMapping("/attempts/{id}")
    public ResponseEntity<AttemptStateDto> getAttempt(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(attemptService.getAttemptState(userDetails.getId(), id));
    }

    @PostMapping("/attempts/{id}/ready")
    public ResponseEntity<AttemptStateDto> markReady(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(attemptService.markReady(userDetails.getId(), id));
    }

    @PostMapping("/attempts/{id}/start")
    public ResponseEntity<AttemptStateDto> startAttempt(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @RequestBody(required = false) Map<String, String> body
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        String sessionId = body != null ? body.get("sessionId") : null;
        return ResponseEntity.ok(attemptService.startAttempt(userDetails.getId(), id, sessionId));
    }

    @PostMapping("/attempts/{id}/sync")
    public ResponseEntity<SyncTimingResponseDto> syncTiming(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @RequestBody SyncTimingRequest request
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        AttemptRecord attempt = attemptService.getOwnedAttempt(userDetails.getId(), id);
        return ResponseEntity.ok(timingService.syncTiming(attempt, request.sessionEpoch()));
    }

    @PostMapping("/attempts/{id}/takeover")
    public ResponseEntity<AttemptStateDto> takeoverSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(attemptService.takeoverSession(userDetails.getId(), id));
    }

    @GetMapping({"/attempts/{id}/manifest", "/attempts/{id}/groups"})
    public ResponseEntity<PublicAttemptManifestDto> getManifest(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(attemptService.getAttemptManifest(userDetails.getId(), id));
    }

    @PutMapping("/attempts/{id}/responses")
    public ResponseEntity<SaveReceiptDto> saveResponses(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @RequestBody SaveResponseBatchRequest request
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        SaveReceiptDto receipt = responseService.saveResponseBatch(userDetails.getId(), id, request);
        return ResponseEntity.ok(receipt);
    }

    @PostMapping("/attempts/{id}/submit")
    public ResponseEntity<Map<String, Object>> submitAttempt(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @RequestBody SubmitAttemptRequest request
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        // Echo Sentinel (EC-SEC-2026-019): completion is executed inside ExamResponseService#submitAttemptWithOutcome
        // ONLY after ownership, revision, deadline, and section validations succeed and attempt transitions to SUBMITTED.
        ExamResponseService.SubmitOutcome outcome = responseService.submitAttemptWithOutcome(userDetails.getId(), id, request);
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("attemptId", id);
        body.put("submissionId", outcome.submissionId());
        body.put("status", "SUBMITTED");
        // Exams Phase 9C/9D: a replayed submit and answers refused by the server deadline are reported, never hidden
        body.put("replayed", outcome.replayed());
        body.put("finalResponsesNotApplied", outcome.finalResponsesNotApplied());
        if (outcome.closure() != null) body.put("closure", outcome.closure());
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(body);
    }

    @PostMapping("/attempts/{id}/sections/{sectionId}/complete")
    public ResponseEntity<AttemptStateDto> completeSection(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @PathVariable UUID sectionId,
            @RequestBody(required = false) CompleteSectionRequest request
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(attemptService.completeSectionAndAdvance(userDetails.getId(), id, sectionId, request));
    }

    @GetMapping({"/history", "/attempts/history"})
    public ResponseEntity<List<AttemptHistoryItemDto>> getHistory(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) String family,
            @RequestParam(required = false) String variant,
            @RequestParam(required = false) String mode,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam(defaultValue = "0") int offset
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        ExamFamily fam = family != null ? ExamFamily.fromString(family) : null;
        ExamAttemptMode attMode = mode != null ? ExamAttemptMode.fromString(mode) : null;
        List<AttemptHistoryItemDto> history = attemptService.getHistory(
                userDetails.getId(), fam, variant, attMode, limit, offset);
        return ResponseEntity.ok(history);
    }

    @GetMapping("/attempts/active-simulation")
    public ResponseEntity<ActiveSimulationAttemptSummary> getActiveSimulation(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return attemptService.getActiveSimulationSummary(userDetails.getId())
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    @PostMapping("/attempts/{id}/abandon")
    public ResponseEntity<Map<String, Object>> abandonAttempt(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        attemptService.abandonAttempt(userDetails.getId(), id);
        return ResponseEntity.ok(Map.of(
                "attemptId", id,
                "status", ExamAttemptStatus.INVALIDATED.name(),
                "message", "Attempt has been successfully abandoned."
        ));
    }
}
