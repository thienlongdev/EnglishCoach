package com.englishcoach.speaking.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.SpeakingResult;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.service.SpeakingContextService;
import com.englishcoach.speaking.service.SpeakingFeedbackService;
import com.englishcoach.speaking.service.SpeakingProgressService;
import com.englishcoach.speaking.service.SpeakingRoleplayService;
import com.englishcoach.speaking.service.SpeakingService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/speaking")
@RequiredArgsConstructor
public class SpeakingController {

    private final SpeakingService speakingService;
    private final SpeakingContextService speakingContextService;
    private final SpeakingRoleplayService speakingRoleplayService;
    private final SpeakingFeedbackService speakingFeedbackService;
    private final SpeakingProgressService speakingProgressService;
    private final com.englishcoach.speaking.service.SpeakingProgressAggregationService speakingProgressAggregationService;
    private final com.englishcoach.speaking.service.SpeakingShadowingService speakingShadowingService;
    private final com.englishcoach.speaking.service.SpeakingShadowingUnitService speakingShadowingUnitService;
    private final com.englishcoach.speaking.service.SpeakingAudioStorageService speakingAudioStorageService;
    private final com.englishcoach.speaking.service.SpeakingQuickCheckService speakingQuickCheckService;
    private final com.englishcoach.speaking.service.SpeakingTtsService speakingTtsService;

    @GetMapping("/shadowing/materials/{materialId}/units")
    public ResponseEntity<List<SpeakingShadowingUnitDto>> getShadowingUnits(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long materialId) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        return ResponseEntity.ok(speakingShadowingUnitService.getOrGenerateUnits(materialId, userId));
    }

    @GetMapping("/shadowing/sessions/active")
    public ResponseEntity<ShadowingSessionStateDto> getOrCreateActiveShadowingSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam Long materialId) {
        return ResponseEntity.ok(speakingShadowingService.getOrCreateActiveSession(userDetails.getId(), materialId));
    }

    @GetMapping("/shadowing/sessions/{sessionId}/state")
    public ResponseEntity<ShadowingSessionStateDto> getShadowingSessionState(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId) {
        return ResponseEntity.ok(speakingShadowingService.getSessionState(userDetails.getId(), sessionId));
    }

    @PostMapping("/shadowing/sessions/{sessionId}/advance")
    public ResponseEntity<ShadowingSessionStateDto> advanceShadowingSessionUnit(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId,
            @RequestParam(required = false) Long unitId,
            @RequestParam(defaultValue = "COMPLETE") String action) {
        return ResponseEntity.ok(speakingShadowingService.advanceSessionUnit(userDetails.getId(), sessionId, unitId, action));
    }

    @PostMapping("/sessions/{sessionId}/shadowing-attempts")
    public ResponseEntity<SpeakingShadowingAttemptDto> recordShadowingAttempt(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId,
            @Valid @RequestBody SpeakingShadowingAttemptRequest request) {
        return ResponseEntity.ok(speakingShadowingService.recordAttempt(userDetails.getId(), sessionId, request));
    }

    @GetMapping("/materials/{materialId}/shadowing-progress")
    public ResponseEntity<List<ShadowingSegmentProgressDto>> getMaterialShadowingProgress(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long materialId) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        speakingShadowingUnitService.verifyMaterialVisible(materialId, userId);
        return ResponseEntity.ok(speakingShadowingService.getMaterialProgress(userDetails.getId(), materialId));
    }

    @GetMapping("/sessions/{sessionId}/shadowing-progress")
    public ResponseEntity<List<ShadowingSegmentProgressDto>> getSessionShadowingProgress(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId) {
        return ResponseEntity.ok(speakingShadowingService.getSessionProgress(userDetails.getId(), sessionId));
    }

    @GetMapping("/progress/summary")
    public ResponseEntity<SpeakingProgressSummaryDto> getSpeakingProgressSummary(
            @AuthenticationPrincipal UserDetailsImpl userDetails) {
        return ResponseEntity.ok(speakingProgressAggregationService.getSpeakingProgressSummary(userDetails.getId()));
    }

    @GetMapping("/history")
    public ResponseEntity<SpeakingSessionHistoryPageDto> getSpeakingSessionHistory(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) String mode,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "10") int size) {
        int safePage = Math.max(0, page);
        int safeSize = Math.max(1, Math.min(50, size));
        return ResponseEntity.ok(speakingProgressAggregationService.getSpeakingSessionHistory(userDetails.getId(), mode, safePage, safeSize));
    }

    @GetMapping("/history/{sessionId}")
    public ResponseEntity<SpeakingSessionDetailDto> getSpeakingSessionDetail(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId) {
        return ResponseEntity.ok(speakingProgressAggregationService.getSpeakingSessionDetail(userDetails.getId(), sessionId));
    }

    @GetMapping("/recurring-issues")
    public ResponseEntity<List<SpeakingRecurringIssueDto>> getRecurringIssues(
            @AuthenticationPrincipal UserDetailsImpl userDetails) {
        return ResponseEntity.ok(speakingProgressAggregationService.getRecurringIssues(userDetails.getId()));
    }

    @GetMapping("/progress")
    public ResponseEntity<SpeakingProgressDto> getSpeakingProgress(@AuthenticationPrincipal UserDetailsImpl userDetails) {
        return ResponseEntity.ok(speakingProgressService.getUserSpeakingProgress(userDetails.getId()));
    }

    @GetMapping("/context")
    public ResponseEntity<SpeakingContextDto> getSpeakingContext(
            @RequestParam String sourceType,
            @RequestParam Long sourceId,
            @AuthenticationPrincipal UserDetailsImpl userDetails) {
        Long userId = (userDetails != null) ? userDetails.getId() : null;
        SpeakingContextDto context = speakingContextService.resolveContext(sourceType, sourceId, userId);
        return ResponseEntity.ok(context);
    }

    @RequirePremiumAi(value = "SPEAKING_ROLEPLAY", requestIdParam = "clientTurnId")
    @PostMapping("/sessions/{sessionId}/turns")
    public ResponseEntity<RoleplayTurnResponseDto> submitTurn(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId,
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "clientTurnId", required = false) String clientTurnId) {
        RoleplayTurnResponseDto response = speakingRoleplayService.processTurn(
                userDetails.getId(),
                sessionId,
                file,
                clientTurnId
        );
        return ResponseEntity.ok(response);
    }

    @GetMapping("/sessions/{sessionId}/turns")
    public ResponseEntity<List<SpeakingTurnDto>> getSessionTurns(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId) {
        return ResponseEntity.ok(speakingRoleplayService.getSessionTurns(userDetails.getId(), sessionId));
    }

    @RequirePremiumAi("SPEAKING_ROLEPLAY")
    @PostMapping("/sessions/{sessionId}/turns/{turnId}/feedback")
    public ResponseEntity<SpeakingTurnFeedbackDto> getOrGenerateTurnFeedback(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId,
            @PathVariable Long turnId) {
        SpeakingTurnFeedbackDto feedback = speakingFeedbackService.getOrGenerateFeedback(
                userDetails.getId(),
                sessionId,
                turnId
        );
        return ResponseEntity.ok(feedback);
    }

    @GetMapping("/sessions/{sessionId}/turns/{turnId}/pronunciation")
    public ResponseEntity<PronunciationV2ResponseDto> getTurnPronunciation(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId,
            @PathVariable Long turnId) {
        PronunciationV2ResponseDto response = speakingRoleplayService.getTurnPronunciation(
                userDetails.getId(),
                sessionId,
                turnId
        );
        return ResponseEntity.ok(response);
    }

    @GetMapping("/sessions/{sessionId}/turns/{turnId}/feedback")
    public ResponseEntity<SpeakingTurnFeedbackDto> getTurnFeedback(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId,
            @PathVariable Long turnId) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(speakingRoleplayService.getTurnFeedback(userId, sessionId, turnId));
    }

    @GetMapping("/results")
    public ResponseEntity<List<SpeakingResult>> getResults(@AuthenticationPrincipal UserDetailsImpl userDetails) {
        return ResponseEntity.ok(speakingService.getUserResults(userDetails.getId()));
    }

    @PostMapping("/results")
    public ResponseEntity<Void> retiredResultSubmission() {
        return ResponseEntity.status(org.springframework.http.HttpStatus.GONE).build();
    }

    @RequirePremiumAi("SPEAKING_PRONUNCIATION")
    @PostMapping("/analyze")
    public ResponseEntity<Map<String, Object>> analyzeAudio(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "referenceText", required = false) String referenceText) {
        return ResponseEntity.ok(speakingService.forwardAudioForAnalysis(file, referenceText));
    }

    @RequirePremiumAi(value = "SPEAKING_PRONUNCIATION", requestIdParam = "attemptId")
    @PostMapping(value = "/ecsm/analyze", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<EcsmAnalysisResponseDto> analyzeEcsm(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "expectedText", required = false) String expectedText,
            @RequestParam(value = "unitId", required = false) Long unitId,
            @RequestParam(value = "referenceMode", defaultValue = "SHADOWING_REFERENCE_RELATIVE") String referenceMode,
            @RequestParam(value = "sessionId", required = false) String sessionId,
            @RequestParam(value = "attemptId", required = false) String attemptId,
            @RequestParam(value = "caseId", required = false) String caseId,
            @RequestParam(value = "parentAttemptId", required = false) String parentAttemptId,
            @RequestParam(value = "activeTargetId", required = false) String activeTargetId) {
        Long userId = requireUserId(userDetails);
        if (sessionId != null && sessionId.matches("[0-9]+")) {
            try {
                expectedText = speakingShadowingService.referenceForAnalysis(userId, Long.valueOf(sessionId), unitId);
            } catch (NumberFormatException e) {
                throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST, "Invalid session ID");
            }
        } else if (unitId != null) {
            expectedText = speakingShadowingUnitService.visibleReference(unitId, userId);
        }
        return ResponseEntity.ok(speakingService.analyzeEcsmSpeech(
                file,
                expectedText,
                unitId,
                referenceMode,
                sessionId,
                attemptId,
                caseId,
                parentAttemptId,
                activeTargetId,
                userId
        ));
    }

    @RequirePremiumAi(value = "SPEAKING_PRONUNCIATION", requestIdParam = "attemptId")
    @PostMapping(value = "/v2/pronunciation/analyze", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<PronunciationV2ResponseDto> analyzePronunciationV2(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "expectedText", required = false) String expectedText,
            @RequestParam(value = "expected_text", required = false) String expectedTextSnake,
            @RequestParam(value = "freeTranscript", required = false) String freeTranscript,
            @RequestParam(value = "free_transcript", required = false) String freeTranscriptSnake,
            @RequestParam(value = "sessionId", required = false) String sessionId,
            @RequestParam(value = "session_id", required = false) String sessionIdSnake,
            @RequestParam(value = "attemptId", required = false) String attemptId,
            @RequestParam(value = "attempt_id", required = false) String attemptIdSnake,
            @RequestParam(value = "accent", required = false) String accent) {
        String resolvedExpectedText = (expectedText != null && !expectedText.isBlank()) ? expectedText : expectedTextSnake;
        String resolvedFreeTranscript = (freeTranscript != null && !freeTranscript.isBlank()) ? freeTranscript : freeTranscriptSnake;
        String resolvedSessionId = (sessionId != null && !sessionId.isBlank()) ? sessionId : sessionIdSnake;
        String resolvedAttemptId = (attemptId != null && !attemptId.isBlank()) ? attemptId : attemptIdSnake;
        return ResponseEntity.ok(speakingService.analyzePronunciationV2(
                file,
                resolvedExpectedText,
                resolvedFreeTranscript,
                resolvedSessionId,
                resolvedAttemptId,
                accent
        ));
    }

    @PostMapping("/sessions")
    public ResponseEntity<SpeakingSession> createSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestBody SpeakingSessionRequest request) {
        return ResponseEntity.ok(speakingService.createSession(userDetails.getId(), request));
    }

    @PutMapping("/sessions/{id}")
    public ResponseEntity<SpeakingSession> updateSession(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long id,
            @RequestBody SpeakingSessionUpdateRequest request) {
        return ResponseEntity.ok(speakingService.updateSession(userDetails.getId(), id, request));
    }

    @RequirePremiumAi(value = "SPEAKING_SHADOWING", requestIdParam = "attemptId")
    @PostMapping(value = "/shadowing/analyze", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<ShadowingAnalysisResponseDto> analyzeShadowingAttempt(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam("file") MultipartFile file,
            @RequestParam("expectedText") String expectedText,
            @RequestParam(value = "unitId", required = false) Long unitId,
            @RequestParam(value = "sessionId", required = false) String sessionId,
            @RequestParam(value = "attemptId", required = false) String attemptId,
            @RequestParam(value = "parentAttemptId", required = false) String parentAttemptId,
            @RequestParam(value = "activeTargetId", required = false) String activeTargetId) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(speakingService.analyzeShadowingAttempt(
                file, unitId, expectedText, sessionId, attemptId, parentAttemptId, activeTargetId, userId
        ));
    }

    @GetMapping("/attempts/{clientAttemptId}/audio")
    public ResponseEntity<org.springframework.core.io.Resource> getAttemptAudio(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String clientAttemptId) {
        if (userDetails == null) {
            throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.UNAUTHORIZED);
        }
        Long userId = userDetails.getId();
        // Audio storage resolves every key inside the authenticated user's directory.
        org.springframework.core.io.Resource resource = speakingAudioStorageService.loadAttemptAudioResource(userId, clientAttemptId);
        String mimeType = speakingAudioStorageService.detectAttemptAudioMime(userId, clientAttemptId);
        long contentLength = -1;
        try {
            contentLength = resource.contentLength();
        } catch (Exception ignored) {}

        String ext = switch (mimeType) {
            case "audio/wav" -> "wav";
            case "audio/ogg" -> "ogg";
            case "audio/mp4" -> "m4a";
            case "audio/mpeg" -> "mp3";
            case "audio/flac" -> "flac";
            default -> "webm";
        };
        var builder = ResponseEntity.ok()
                .header(org.springframework.http.HttpHeaders.ACCEPT_RANGES, "bytes")
                .contentType(MediaType.parseMediaType(mimeType))
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"recording." + ext + "\"");
        if (contentLength > 0) {
            builder.contentLength(contentLength);
        }
        return builder.body(resource);
    }

    @RequirePremiumAi(value = "SPEAKING_QUICK_CHECK", requestIdParam = "clientAttemptId")
    @PostMapping(value = "/quick-check/analyze", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<QuickCheckResponseDto> analyzeQuickCheck(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "clientAttemptId", required = false) String clientAttemptId,
            @RequestParam(value = "intendedText", required = false) String intendedText) {
        if (userDetails == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.UNAUTHORIZED, "User must be authenticated for Quick Check");
        }
        return ResponseEntity.ok(speakingQuickCheckService.analyzeQuickCheck(
                userDetails.getId(),
                file,
                clientAttemptId,
                intendedText
        ));
    }

    @RequirePremiumAi(value = "SPEAKING_QUICK_CHECK", reuseClientRequestId = false)
    @PostMapping("/quick-check/recheck")
    public ResponseEntity<QuickCheckResponseDto> recheckQuickCheck(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam("clientAttemptId") String clientAttemptId,
            @RequestParam("intendedText") String intendedText) {
        if (userDetails == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.UNAUTHORIZED, "User must be authenticated for Quick Check");
        }
        if (intendedText == null || intendedText.trim().isEmpty()) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.BAD_REQUEST, "intendedText is required");
        }
        if (intendedText.trim().length() > 500) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.BAD_REQUEST, "intendedText must not exceed 500 characters");
        }
        return ResponseEntity.ok(speakingQuickCheckService.recheckQuickCheck(
                userDetails.getId(),
                clientAttemptId,
                intendedText
        ));
    }

    @GetMapping("/quick-check/{clientAttemptId}")
    public ResponseEntity<QuickCheckResponseDto> getQuickCheckDetail(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String clientAttemptId) {
        if (userDetails == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.UNAUTHORIZED, "User must be authenticated for Quick Check");
        }
        return ResponseEntity.ok(speakingQuickCheckService.getQuickCheckDetail(
                userDetails.getId(),
                clientAttemptId
        ));
    }

    // A unit belongs to a listening material, and a material may be one learner's private import: the caller must be
    // able to see that material (their own, or SYSTEM content). Before 2026-10 these two took the unit id alone.
    @PostMapping("/shadowing/units/{unitId}/ipa")
    public ResponseEntity<UnitIpaDto> getOrGenerateUnitIpa(
            @AuthenticationPrincipal UserDetailsImpl userDetails, @PathVariable Long unitId) {
        return ResponseEntity.ok(speakingShadowingUnitService.getOrGenerateUnitIpa(unitId, requireUserId(userDetails)));
    }

    @PostMapping("/shadowing/units/{unitId}/translation")
    public ResponseEntity<UnitTranslationDto> getOrGenerateUnitTranslation(
            @AuthenticationPrincipal UserDetailsImpl userDetails, @PathVariable Long unitId) {
        return ResponseEntity.ok(speakingShadowingUnitService.getOrGenerateUnitTranslation(unitId, requireUserId(userDetails)));
    }

    private static Long requireUserId(UserDetailsImpl userDetails) {
        if (userDetails == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.UNAUTHORIZED, "Authentication required");
        }
        return userDetails.getId();
    }

    @GetMapping("/tts/voices")
    public ResponseEntity<List<com.englishcoach.speaking.service.SpeakingTtsService.VoiceMetaDto>> getTtsVoices() {
        return ResponseEntity.ok(speakingTtsService.getVoices());
    }

    @GetMapping("/tts/preview")
    public ResponseEntity<org.springframework.core.io.Resource> getTtsPreview(
            @RequestParam(value = "voiceId", defaultValue = "us_female") String voiceId) {
        String cleanVoiceId = com.englishcoach.speaking.service.SpeakingTtsService.sanitizeVoiceId(voiceId);
        org.springframework.core.io.Resource resource = speakingTtsService.synthesizePreview(cleanVoiceId);
        long length = -1;
        try { length = resource.contentLength(); } catch (Exception ignored) {}
        var builder = ResponseEntity.ok()
                .header(org.springframework.http.HttpHeaders.ACCEPT_RANGES, "bytes")
                .contentType(MediaType.parseMediaType("audio/wav"))
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"preview_" + cleanVoiceId + ".wav\"");
        if (length > 0) {
            builder.contentLength(length);
        }
        return builder.body(resource);
    }

    @PostMapping("/tts/synthesize")
    public ResponseEntity<org.springframework.core.io.Resource> synthesizeCustomText(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(value = "voiceId", defaultValue = "us_female") String voiceId,
            @RequestParam("text") String text) {
        org.springframework.core.io.Resource resource = speakingTtsService.synthesizeForLearner(
                userDetails != null ? userDetails.getId() : null, voiceId, text);
        long length = -1;
        try { length = resource.contentLength(); } catch (Exception ignored) {}
        var builder = ResponseEntity.ok()
                .header(org.springframework.http.HttpHeaders.ACCEPT_RANGES, "bytes")
                .contentType(MediaType.parseMediaType("audio/wav"))
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"synthesized.wav\"");
        if (length > 0) {
            builder.contentLength(length);
        }
        return builder.body(resource);
    }

    @GetMapping("/tts/audio")
    public ResponseEntity<org.springframework.core.io.Resource> getTtsAudioByRef(
            @RequestParam("ref") String ref) {
        org.springframework.core.io.Resource resource = speakingTtsService.loadAudioByRef(ref);
        long length = -1;
        try { length = resource.contentLength(); } catch (Exception ignored) {}
        var builder = ResponseEntity.ok()
                .header(org.springframework.http.HttpHeaders.ACCEPT_RANGES, "bytes")
                .contentType(MediaType.parseMediaType("audio/wav"))
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"speech.wav\"");
        if (length > 0) {
            builder.contentLength(length);
        }
        return builder.body(resource);
    }

    @GetMapping("/sessions/{sessionId}/turns/{turnId}/audio")
    public ResponseEntity<org.springframework.core.io.Resource> getTurnAudio(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId,
            @PathVariable Long turnId) {
        if (userDetails == null) {
            throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.UNAUTHORIZED);
        }
        org.springframework.core.io.Resource resource = speakingTtsService.getOrSynthesizeTurnAudio(
                userDetails.getId(),
                sessionId,
                turnId
        );
        long length = -1;
        try { length = resource.contentLength(); } catch (Exception ignored) {}
        var builder = ResponseEntity.ok()
                .header(org.springframework.http.HttpHeaders.ACCEPT_RANGES, "bytes")
                .contentType(MediaType.parseMediaType("audio/wav"))
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"turn_" + turnId + ".wav\"");
        if (length > 0) {
            builder.contentLength(length);
        }
        return builder.body(resource);
    }

    @PostMapping("/sessions/{sessionId}/turns/{turnId}/tts")
    public ResponseEntity<Map<String, Object>> generateTurnTts(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long sessionId,
            @PathVariable Long turnId) {
        if (userDetails == null) {
            throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.UNAUTHORIZED);
        }
        String audioRef = speakingTtsService.getOrSynthesizeTurnAudioRef(userDetails.getId(), sessionId, turnId);
        return ResponseEntity.ok(Map.of(
                "turnId", turnId,
                "synthesizedAudioRef", audioRef,
                "audioUrl", "/api/v1/speaking/sessions/" + sessionId + "/turns/" + turnId + "/audio"
        ));
    }
}
