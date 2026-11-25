package com.englishcoach.community.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.community.dto.CommunityFeedPageDto;
import com.englishcoach.community.dto.CommunityModerationRecordDto;
import com.englishcoach.community.dto.CommunityPostDto;
import com.englishcoach.community.dto.ModeratePostRequest;
import com.englishcoach.community.dto.OfficialPublishRequest;
import com.englishcoach.community.entity.ReportStatus;
import com.englishcoach.community.service.CommunityDailyVocabularyService;
import com.englishcoach.community.service.CommunityModerationService;
import com.englishcoach.community.service.CommunityOfficialPublisherService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.util.List;

@RestController
@RequestMapping("/api/v1/admin/community")
@RequiredArgsConstructor
@Slf4j
@PreAuthorize("hasRole('ADMIN')")
public class CommunityAdminController {

    private final CommunityModerationService moderationService;
    private final CommunityOfficialPublisherService officialPublisherService;
    private final CommunityDailyVocabularyService dailyVocabularyService;
    private final com.englishcoach.community.service.CommunityPostService postService;
    private final com.englishcoach.community.service.CommunityRestrictionService restrictionService;

    // =========================================================================
    // MODERATION QUEUES
    // =========================================================================

    @GetMapping("/posts")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getPosts(
            @RequestParam(required = false) com.englishcoach.community.entity.PostStatus status,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        if (status == com.englishcoach.community.entity.PostStatus.PENDING) {
            return ResponseEntity.ok(moderationService.getPendingQueue(page, size));
        } else if (status == com.englishcoach.community.entity.PostStatus.PUBLISHED) {
            return ResponseEntity.ok(moderationService.getApprovedQueue(page, size));
        } else if (status == com.englishcoach.community.entity.PostStatus.REJECTED) {
            return ResponseEntity.ok(moderationService.getRejectedQueue(page, size));
        } else if (status == com.englishcoach.community.entity.PostStatus.HIDDEN) {
            return ResponseEntity.ok(moderationService.getHiddenQueue(page, size));
        } else {
            return ResponseEntity.ok(moderationService.getPendingQueue(page, size));
        }
    }

    @GetMapping("/reports")
    public ResponseEntity<List<com.englishcoach.community.dto.ReportItemDto>> getReports(
            @RequestParam(required = false) ReportStatus status,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size
    ) {
        return ResponseEntity.ok(moderationService.getReports(status, page, size));
    }

    @GetMapping("/queue/pending")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getPendingQueue(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        return ResponseEntity.ok(moderationService.getPendingQueue(page, size));
    }

    @GetMapping("/queue/approved")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getApprovedQueue(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        return ResponseEntity.ok(moderationService.getApprovedQueue(page, size));
    }

    @GetMapping("/queue/rejected")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getRejectedQueue(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        return ResponseEntity.ok(moderationService.getRejectedQueue(page, size));
    }

    @GetMapping("/queue/hidden")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getHiddenQueue(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        return ResponseEntity.ok(moderationService.getHiddenQueue(page, size));
    }

    @GetMapping("/queue/reported")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getReportedQueue(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        return ResponseEntity.ok(moderationService.getReportedQueue(page, size));
    }

    // =========================================================================
    // MODERATION ACTIONS
    // =========================================================================

    @PostMapping("/posts/{id}/moderate")
    public ResponseEntity<CommunityPostDto> moderatePost(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @Valid @RequestBody ModeratePostRequest request
    ) {
        return ResponseEntity.ok(moderationService.moderatePost(principal.getId(), id, request));
    }

    @GetMapping("/posts/{id}/history")
    public ResponseEntity<List<CommunityModerationRecordDto>> getModerationHistory(@PathVariable Long id) {
        return ResponseEntity.ok(moderationService.getModerationHistory(id));
    }

    @PostMapping("/reports/{reportId}/resolve")
    public ResponseEntity<Void> resolveReport(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long reportId,
            @RequestParam ReportStatus status
    ) {
        moderationService.resolveReport(principal.getId(), reportId, status);
        return ResponseEntity.noContent().build();
    }

    // =========================================================================
    // OFFICIAL PUBLISHER
    // =========================================================================

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/official/publish")
    public ResponseEntity<CommunityPostDto> publishOfficial(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @Valid @RequestBody OfficialPublishRequest request
    ) {
        CommunityPostDto created = officialPublisherService.publishOfficialPost(principal.getId(), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @PostMapping("/posts/{id}/pin")
    public ResponseEntity<CommunityPostDto> togglePin(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @RequestParam(name = "pinned", required = false) Boolean pinned,
            @RequestParam(name = "isPinned", required = false) Boolean isPinned,
            @RequestBody(required = false) java.util.Map<String, Object> body
    ) {
        Boolean pinVal = pinned != null ? pinned : isPinned;
        if (pinVal == null && body != null) {
            if (body.get("pinned") instanceof Boolean b) pinVal = b;
            else if (body.get("isPinned") instanceof Boolean b) pinVal = b;
        }
        boolean pin = Boolean.TRUE.equals(pinVal);
        officialPublisherService.togglePin(principal.getId(), id, pin);
        return ResponseEntity.ok(postService.getPostById(principal.getId(), id, true));
    }

    @PostMapping("/posts/{id}/feature")
    public ResponseEntity<CommunityPostDto> toggleFeature(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @RequestParam(name = "featured", required = false) Boolean featured,
            @RequestParam(name = "isFeatured", required = false) Boolean isFeatured,
            @RequestBody(required = false) java.util.Map<String, Object> body
    ) {
        Boolean featVal = featured != null ? featured : isFeatured;
        if (featVal == null && body != null) {
            if (body.get("featured") instanceof Boolean b) featVal = b;
            else if (body.get("isFeatured") instanceof Boolean b) featVal = b;
        }
        boolean feat = Boolean.TRUE.equals(featVal);
        officialPublisherService.toggleFeatured(principal.getId(), id, feat);
        return ResponseEntity.ok(postService.getPostById(principal.getId(), id, true));
    }

    @PostMapping("/daily/generate")
    public ResponseEntity<Void> triggerDailyVocab(@RequestParam(required = false) String dateStr) {
        LocalDate date = (dateStr != null && !dateStr.isBlank())
                ? LocalDate.parse(dateStr)
                : LocalDate.now(CommunityDailyVocabularyService.VN_ZONE);
        dailyVocabularyService.ensureDailyVocabularyPost(date);
        return ResponseEntity.noContent().build();
    }

    // =========================================================================
    // COMMENT MODERATION LOCK (ADMIN OVERRIDE)
    // =========================================================================

    @PostMapping("/posts/{id}/comments/lock")
    public ResponseEntity<CommunityPostDto> lockComments(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @RequestBody(required = false) java.util.Map<String, String> body
    ) {
        String reason = body != null ? body.get("reason") : null;
        return ResponseEntity.ok(moderationService.toggleCommentLock(principal.getId(), id, true, reason));
    }

    @PostMapping("/posts/{id}/comments/unlock")
    public ResponseEntity<CommunityPostDto> unlockComments(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @RequestBody(required = false) java.util.Map<String, String> body
    ) {
        String reason = body != null ? body.get("reason") : null;
        return ResponseEntity.ok(moderationService.toggleCommentLock(principal.getId(), id, false, reason));
    }

    // =========================================================================
    // COMMUNITY USER RESTRICTIONS
    // =========================================================================

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/restrictions")
    public ResponseEntity<com.englishcoach.community.dto.CommunityUserRestrictionDto> createRestriction(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @Valid @RequestBody com.englishcoach.community.dto.CreateRestrictionRequest request
    ) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(restrictionService.createRestriction(principal.getId(), request));
    }

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/restrictions/{id}/revoke")
    public ResponseEntity<com.englishcoach.community.dto.CommunityUserRestrictionDto> revokeRestriction(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id
    ) {
        return ResponseEntity.ok(restrictionService.revokeRestriction(principal.getId(), id));
    }

    @GetMapping("/users/{userId}/restrictions/active")
    public ResponseEntity<com.englishcoach.community.dto.CommunityUserRestrictionDto> getActiveRestriction(@PathVariable Long userId) {
        return ResponseEntity.ok(restrictionService.getActiveRestrictionDto(userId).orElse(null));
    }

    @GetMapping("/users/{userId}/restrictions/history")
    public ResponseEntity<List<com.englishcoach.community.dto.CommunityUserRestrictionDto>> getRestrictionHistory(@PathVariable Long userId) {
        return ResponseEntity.ok(restrictionService.getRestrictionHistory(userId));
    }
}
