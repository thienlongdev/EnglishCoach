package com.englishcoach.community.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.community.dto.*;
import com.englishcoach.community.service.CommunityCommentService;
import com.englishcoach.community.service.CommunityInteractionService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/community")
@RequiredArgsConstructor
@Slf4j
public class CommunityInteractionController {

    private final CommunityInteractionService interactionService;
    private final com.englishcoach.messenger.MessengerService messenger;
    private final CommunityCommentService commentService;
    private final com.englishcoach.community.service.CommunityRestrictionService restrictionService;

    private Long getUserId(UserDetailsImpl principal) {
        return principal != null ? principal.getId() : null;
    }

    private boolean isAdmin(UserDetailsImpl principal) {
        if (principal == null || principal.getAuthorities() == null) return false;
        return principal.getAuthorities().stream().anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
    }

    // =========================================================================
    // POST INTERACTIONS (REACT, SAVE, REPORT)
    // =========================================================================

    @PostMapping("/posts/{id}/react")
    public ResponseEntity<ReactionResponse> reactToPost(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @Valid @RequestBody ReactionRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(interactionService.toggleReaction(principal.getId(), id, request.getReactionType()));
    }

    @GetMapping("/posts/{id}/reactions")
    public ResponseEntity<PostReactionSummaryDto> getPostReactions(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @RequestParam(required = false) com.englishcoach.community.entity.ReactionType type,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size
    ) {
        return ResponseEntity.ok(interactionService.getReactionSummary(id, type, getUserId(principal), page, size));
    }

    @PostMapping("/posts/{id}/save")
    public ResponseEntity<Boolean> toggleSavePost(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(interactionService.toggleSavePost(principal.getId(), id));
    }

    @DeleteMapping("/posts/{id}/save")
    public ResponseEntity<Boolean> unsavePost(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(interactionService.toggleSavePost(principal.getId(), id));
    }

    @PostMapping("/posts/{id}/report")
    public ResponseEntity<Void> reportPost(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @Valid @RequestBody ReportRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        interactionService.reportPost(principal.getId(), id, request);
        return ResponseEntity.status(HttpStatus.CREATED).build();
    }

    // =========================================================================
    // COMMENTS
    // =========================================================================

    @GetMapping("/posts/{id}/comments")
    public ResponseEntity<CommunityFeedPageDto<CommentDto>> getComments(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size
    ) {
        return ResponseEntity.ok(commentService.getComments(getUserId(principal), id, page, size));
    }

    @PostMapping("/posts/{id}/comments")
    public ResponseEntity<CommentDto> createComment(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @Valid @RequestBody CreateCommentRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(
                commentService.createComment(principal.getId(), id, request)
        );
    }

    @DeleteMapping("/comments/{commentId}")
    public ResponseEntity<Void> deleteComment(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long commentId
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        commentService.deleteComment(principal.getId(), commentId, isAdmin(principal));
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/comments/{commentId}/react")
    public ResponseEntity<CommentReactionResponseDto> toggleCommentReaction(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long commentId,
            @RequestBody(required = false) ReactionRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        com.englishcoach.community.entity.ReactionType type = (request != null && request.getReactionType() != null)
                ? request.getReactionType()
                : com.englishcoach.community.entity.ReactionType.LOVE;
        return ResponseEntity.ok(commentService.reactToComment(principal.getId(), commentId, type));
    }

    @GetMapping("/users/me/restriction")
    public ResponseEntity<CommunityUserRestrictionDto> getMyRestriction(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(restrictionService.getActiveRestrictionDto(principal.getId()).orElse(null));
    }

    @PostMapping("/comments/{commentId}/report")
    public ResponseEntity<Void> reportComment(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long commentId,
            @Valid @RequestBody ReportRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        interactionService.reportComment(principal.getId(), commentId, request);
        return ResponseEntity.status(HttpStatus.CREATED).build();
    }

    // =========================================================================
    // SOCIAL GRAPH (FOLLOW, PROFILE)
    // =========================================================================

    @PostMapping("/users/{targetUserId}/follow")
    public ResponseEntity<Boolean> followUser(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long targetUserId
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        boolean result = interactionService.followUser(principal.getId(), targetUserId);
        messenger.followChanged(principal.getId(), targetUserId);
        return ResponseEntity.ok(result);
    }

    @DeleteMapping("/users/{targetUserId}/follow")
    public ResponseEntity<Boolean> unfollowUser(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long targetUserId
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        boolean result = interactionService.unfollowUser(principal.getId(), targetUserId);
        messenger.followChanged(principal.getId(), targetUserId);
        return ResponseEntity.ok(result);
    }

    @GetMapping("/users/{targetUserId}/profile")
    public ResponseEntity<CommunityUserProfileDto> getUserProfile(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long targetUserId
    ) {
        return ResponseEntity.ok(interactionService.getUserProfile(getUserId(principal), targetUserId));
    }

    @GetMapping("/users/{targetUserId}/followers")
    public ResponseEntity<CommunityFeedPageDto<AuthorSummaryDto>> getFollowers(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long targetUserId,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size
    ) {
        return ResponseEntity.ok(interactionService.getFollowers(getUserId(principal), targetUserId, page, size));
    }

    @GetMapping("/users/{targetUserId}/following")
    public ResponseEntity<CommunityFeedPageDto<AuthorSummaryDto>> getFollowing(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long targetUserId,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size
    ) {
        return ResponseEntity.ok(interactionService.getFollowing(getUserId(principal), targetUserId, page, size));
    }
}
