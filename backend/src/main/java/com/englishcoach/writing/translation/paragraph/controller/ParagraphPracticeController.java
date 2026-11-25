package com.englishcoach.writing.translation.paragraph.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.writing.translation.paragraph.dto.*;
import com.englishcoach.writing.translation.paragraph.service.ParagraphCatalogService;
import com.englishcoach.writing.translation.paragraph.service.ParagraphSessionService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Slf4j
@RestController
@RequestMapping("/api/v1/writing/translation/paragraphs")
@RequiredArgsConstructor
public class ParagraphPracticeController {

    private final ParagraphCatalogService catalogService;
    private final ParagraphSessionService sessionService;
    private final com.englishcoach.writing.translation.paragraph.service.ParagraphAttemptService attemptService;
    private final com.englishcoach.writing.translation.paragraph.service.ParagraphAssistanceService assistanceService;

    private Long requireUserId(UserDetailsImpl userDetails) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new AccessDeniedException("Authentication required for paragraph translation operations");
        }
        return userDetails.getId();
    }

    @GetMapping("/catalog")
    public ResponseEntity<ParagraphCatalogResponse> getCatalog(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        return ResponseEntity.ok(catalogService.getCatalog(userId));
    }

    @GetMapping
    public ResponseEntity<Page<ParagraphPassageSummaryDto>> getPassages(
            @RequestParam(required = false) String genre,
            @RequestParam(required = false) String topic,
            @PageableDefault(size = 20) Pageable pageable
    ) {
        return ResponseEntity.ok(catalogService.getPassagesPaged(genre, topic, pageable));
    }

    @PostMapping("/sessions")
    public ResponseEntity<ParagraphSessionResponse> startSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody ParagraphStartRequest request
    ) {
        Long userId = requireUserId(userDetails);
        log.info("User {} starting/resuming paragraph translation session", userId);
        return ResponseEntity.status(HttpStatus.CREATED).body(sessionService.startSession(userId, request));
    }

    @GetMapping("/sessions/active")
    public ResponseEntity<ParagraphSessionResponse> getActiveSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = requireUserId(userDetails);
        ParagraphSessionResponse session = sessionService.getActiveSession(userId);
        if (session == null) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok(session);
    }

    @GetMapping("/sessions/{sessionId}")
    public ResponseEntity<ParagraphSessionResponse> getSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(sessionService.getSession(userId, sessionId));
    }

    @PostMapping("/sessions/{sessionId}/draft")
    public ResponseEntity<ParagraphDraftResponse> saveDraft(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId,
            @Valid @RequestBody ParagraphDraftRequest request
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(sessionService.saveDraft(userId, sessionId, request));
    }

    @PostMapping("/sessions/{sessionId}/navigate")
    public ResponseEntity<ParagraphSessionResponse> navigateSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId,
            @Valid @RequestBody ParagraphNavigationRequest request
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(sessionService.navigateSession(userId, sessionId, request.getTargetOrdinal()));
    }

    @PostMapping("/sessions/{sessionId}/skip")
    public ResponseEntity<ParagraphSessionResponse> skipItem(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId,
            @RequestBody Map<String, Integer> body
    ) {
        Long userId = requireUserId(userDetails);
        Integer ordinal = body != null ? body.get("ordinal") : null;
        if (ordinal == null) {
            throw new IllegalArgumentException("Target ordinal is required");
        }
        return ResponseEntity.ok(sessionService.skipItem(userId, sessionId, ordinal));
    }

    @com.englishcoach.premium.interceptor.RequirePremiumAi("TRANSLATION_AI_GRADING")
    @PostMapping("/sessions/{sessionId}/attempts")
    public ResponseEntity<ParagraphAttemptResponse> processAttempt(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId,
            @Valid @RequestBody ParagraphAttemptRequest request
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(attemptService.processAttempt(userId, sessionId, request));
    }

    @GetMapping("/sessions/{sessionId}/items/{itemId}/attempts")
    public ResponseEntity<List<ParagraphAttemptResponse>> getAttemptsForItem(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId,
            @PathVariable UUID itemId
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(attemptService.getAttemptsForItem(userId, sessionId, itemId));
    }

    @PostMapping("/sessions/{sessionId}/assistance")
    public ResponseEntity<ParagraphAssistanceResponse> getAssistance(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId,
            @Valid @RequestBody ParagraphAssistanceRequest request
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(assistanceService.getAssistance(userId, sessionId, request));
    }
}
