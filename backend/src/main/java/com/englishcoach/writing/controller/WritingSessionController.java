package com.englishcoach.writing.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.enums.WritingSessionStage;
import com.englishcoach.writing.service.WritingSessionService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@Slf4j
@RestController
@RequestMapping("/api/v1/writing")
@RequiredArgsConstructor
public class WritingSessionController {

    private final WritingSessionService writingSessionService;

    private Long requireUserId(UserDetailsImpl userDetails) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required for writing session operations");
        }
        return userDetails.getId();
    }

    @GetMapping("/capabilities")
    public ResponseEntity<WritingCapabilitiesDto> getCapabilities() {
        return ResponseEntity.ok(writingSessionService.getCapabilities());
    }

    @GetMapping("/profile")
    public ResponseEntity<WritingProfileDto> getProfile(
            @AuthenticationPrincipal UserDetailsImpl userDetails) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.getProfile(userId));
    }

    @PatchMapping("/profile")
    public ResponseEntity<WritingProfileDto> updateProfile(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestBody WritingProfileDto dto) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.updateProfile(userId, dto));
    }

    @GetMapping("/tasks")
    public ResponseEntity<List<Map<String, Object>>> getTasks(
            @RequestParam(required = false) String category,
            @RequestParam(required = false) String level) {
        return ResponseEntity.ok(writingSessionService.getTasks(category, level));
    }

    @PostMapping("/sessions")
    public ResponseEntity<WritingSessionDto> createSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody CreateSessionRequest request) {
        Long userId = requireUserId(userDetails);
        WritingSessionDto session = writingSessionService.createSession(userId, request);
        return ResponseEntity.status(HttpStatus.CREATED).body(session);
    }

    @GetMapping("/sessions/{id}")
    public ResponseEntity<WritingSessionDto> getSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.getSession(userId, id));
    }

    @GetMapping("/sessions/{id}/detail")
    public ResponseEntity<WritingSessionDetailDto> getSessionDetail(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.getSessionDetail(userId, id));
    }

    @PatchMapping("/sessions/{id}/working-copy")
    public ResponseEntity<WritingSessionDto> updateWorkingCopy(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id,
            @Valid @RequestBody UpdateWorkingCopyRequest request) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.updateWorkingCopy(userId, id, request));
    }

    @PatchMapping("/sessions/{id}/stage")
    public ResponseEntity<WritingSessionDto> advanceStage(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id,
            @Valid @RequestBody AdvanceStageRequest request) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.advanceStage(userId, id, request));
    }

    @GetMapping("/sessions")
    public ResponseEntity<List<WritingSessionDto>> listSessions(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) WritingSessionStage stage,
            @RequestParam(required = false) Boolean completed) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.listSessions(userId, stage, completed));
    }

    @DeleteMapping("/sessions/{id}")
    public ResponseEntity<Void> deleteSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id) {
        Long userId = requireUserId(userDetails);
        writingSessionService.deleteSession(userId, id);
        return ResponseEntity.noContent().build();
    }

    @RequirePremiumAi("WRITING_AI_FEEDBACK")
    @PostMapping("/sessions/{id}/plan/organize")
    public ResponseEntity<PlanOrganizationResultDto> organizePlan(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.organizePlan(userId, id));
    }

    @RequirePremiumAi(value = "WRITING_AI_FEEDBACK", serviceManagedReservation = true)
    @PostMapping("/sessions/{id}/drafts")
    public ResponseEntity<DocumentAssessmentResultDto> submitDraft(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id,
            @RequestBody(required = false) SubmitDraftRequest request) {
        Long userId = requireUserId(userDetails);
        Long expectedRevision = request != null ? request.getExpectedRevision() : null;
        String clientMutationId = request != null ? request.getClientMutationId() : null;
        return ResponseEntity.ok(writingSessionService.submitDraft(userId, id, expectedRevision, clientMutationId));
    }

    @GetMapping("/sessions/{id}/assessments/{assessmentId}")
    public ResponseEntity<DocumentAssessmentResultDto> getAssessment(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id,
            @PathVariable String assessmentId) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.getAssessment(userId, id, assessmentId));
    }

    @GetMapping("/sessions/{id}/comparison")
    public ResponseEntity<DraftComparisonResultDto> compareDrafts(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id,
            @RequestParam(required = false) String draft1Id,
            @RequestParam(required = false) String draft2Id) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.compareDrafts(userId, id, draft1Id, draft2Id));
    }

    @RequirePremiumAi(value = "WRITING_AI_FEEDBACK", serviceManagedReservation = true)
    @PostMapping("/sessions/{id}/complete")
    public ResponseEntity<WritingSessionDto> completeSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id,
            @RequestBody(required = false) CompleteSessionRequest request) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.completeSession(userId, id, request));
    }

    @PatchMapping("/sessions/{id}/favorite")
    public ResponseEntity<WritingSessionDto> setFavorite(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id,
            @RequestParam boolean isFavorite) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.setFavorite(userId, id, isFavorite));
    }

    @GetMapping("/portfolio")
    public ResponseEntity<List<PortfolioSummaryItemDto>> getPortfolio(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) String state,
            @RequestParam(required = false) Boolean favorite) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.getPortfolio(userId, state, favorite));
    }

    @GetMapping("/for-you")
    public ResponseEntity<ForYouDashboardDto> getForYou(
            @AuthenticationPrincipal UserDetailsImpl userDetails) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(writingSessionService.getForYou(userId));
    }
}
