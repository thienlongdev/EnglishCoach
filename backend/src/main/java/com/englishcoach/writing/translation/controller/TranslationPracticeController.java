package com.englishcoach.writing.translation.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.writing.translation.dto.*;
import com.englishcoach.writing.translation.service.*;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@Slf4j
@RestController
@RequestMapping("/api/v1/writing/translation")
@RequiredArgsConstructor
public class TranslationPracticeController {

    private final TranslationCatalogService catalogService;
    private final TranslationSessionService sessionService;
    private final TranslationDraftService draftService;
    private final TranslationHintService hintService;
    private final TranslationAttemptService attemptService;

    private Long requireUserId(UserDetailsImpl userDetails) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new AccessDeniedException("Authentication required for translation operations");
        }
        return userDetails.getId();
    }

    @GetMapping("/catalog")
    public ResponseEntity<TranslationCatalogResponse> getCatalog(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        return ResponseEntity.ok(catalogService.getCatalog(userId));
    }

    @PostMapping("/sessions")
    public ResponseEntity<TranslationSessionResponse> startSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody TranslationStartRequest request
    ) {
        Long userId = requireUserId(userDetails);
        log.info("User {} starting translation session", userId);
        return ResponseEntity.status(HttpStatus.CREATED).body(sessionService.startSession(userId, request));
    }

    @GetMapping("/sessions/{sessionId}")
    public ResponseEntity<TranslationSessionResponse> getSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(sessionService.getSession(userId, sessionId));
    }

    @PostMapping("/sessions/{sessionId}/draft")
    public ResponseEntity<TranslationDraftResponse> saveDraft(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId,
            @Valid @RequestBody TranslationDraftRequest request
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(draftService.saveDraft(userId, sessionId, request));
    }

    @PostMapping("/sessions/{sessionId}/hint")
    public ResponseEntity<TranslationHintResponse> processHint(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId,
            @Valid @RequestBody TranslationHintRequest request
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(hintService.processHint(userId, sessionId, request));
    }

    @com.englishcoach.premium.interceptor.RequirePremiumAi("TRANSLATION_AI_GRADING")
    @PostMapping("/sessions/{sessionId}/attempts")
    public ResponseEntity<TranslationAttemptResponse> submitAttempt(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId,
            @Valid @RequestBody TranslationAttemptRequest request
    ) {
        Long userId = requireUserId(userDetails);
        log.info("User {} submitting attempt for session {}", userId, sessionId);
        return ResponseEntity.status(HttpStatus.CREATED).body(attemptService.submitAttempt(userId, sessionId, request));
    }

    @PostMapping("/sessions/{sessionId}/navigate")
    public ResponseEntity<TranslationSessionResponse> navigateSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID sessionId,
            @RequestBody java.util.Map<String, Short> body
    ) {
        Long userId = requireUserId(userDetails);
        Short ordinal = body != null ? body.get("ordinal") : null;
        if (ordinal == null || ordinal < 1) {
            throw new IllegalArgumentException("Target ordinal is required");
        }
        return ResponseEntity.ok(sessionService.navigateSession(userId, sessionId, ordinal));
    }
}
