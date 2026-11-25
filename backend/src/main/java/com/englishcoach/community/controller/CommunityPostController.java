package com.englishcoach.community.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.community.dto.CommunityFeedPageDto;
import com.englishcoach.community.dto.CommunityPostDto;
import com.englishcoach.community.dto.CreatePostRequest;
import com.englishcoach.community.dto.UpdatePostRequest;
import com.englishcoach.community.service.CommunityPostService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/community/posts")
@RequiredArgsConstructor
@Slf4j
public class CommunityPostController {

    private final CommunityPostService postService;

    private Long getUserId(UserDetailsImpl principal) {
        return principal != null ? principal.getId() : null;
    }

    private boolean isAdmin(UserDetailsImpl principal) {
        if (principal == null || principal.getAuthorities() == null) return false;
        return principal.getAuthorities().stream().anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
    }

    /**
     * Single post detail: GET /api/v1/community/posts/{id}
     */
    @GetMapping("/{id}")
    public ResponseEntity<CommunityPostDto> getPost(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id
    ) {
        return ResponseEntity.ok(postService.getPostById(getUserId(principal), id, isAdmin(principal)));
    }

    /**
     * Author's own posts (includes PENDING, PUBLISHED, REJECTED).
     */
    @GetMapping("/my")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getMyPosts(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(postService.getMyPosts(principal.getId(), page, size));
    }

    /**
     * Public posts by target user.
     */
    @GetMapping("/user/{userId}")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getUserPosts(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long userId,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        Long currentUserId = principal != null ? principal.getId() : null;
        return ResponseEntity.ok(postService.getUserPosts(currentUserId, userId, page, size));
    }

    /**
     * Create user post -> initial state is strictly PENDING.
     */
    @PostMapping
    public ResponseEntity<CommunityPostDto> createPost(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @Valid @RequestBody CreatePostRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        CommunityPostDto created = postService.createPost(principal.getId(), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    /**
     * Update post -> if content changed, returns to PENDING for moderation.
     */
    @PutMapping("/{id}")
    public ResponseEntity<CommunityPostDto> updatePost(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @Valid @RequestBody UpdatePostRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        CommunityPostDto updated = postService.updatePost(principal.getId(), id, request);
        return ResponseEntity.ok(updated);
    }

    /**
     * Soft delete post.
     */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deletePost(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        postService.deletePost(principal.getId(), id, isAdmin(principal));
        return ResponseEntity.noContent().build();
    }

    /**
     * Post owner toggles comments disabled / enabled.
     */
    @PostMapping("/{id}/comments/toggle")
    public ResponseEntity<CommunityPostDto> toggleComments(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id,
            @RequestBody(required = false) java.util.Map<String, Boolean> body
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        boolean disabled = body != null && Boolean.TRUE.equals(body.get("disabled"));
        CommunityPostDto updated = postService.toggleComments(principal.getId(), id, disabled);
        return ResponseEntity.ok(updated);
    }
}
