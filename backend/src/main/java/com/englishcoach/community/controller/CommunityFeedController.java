package com.englishcoach.community.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.community.dto.CommunityFeedPageDto;
import com.englishcoach.community.dto.CommunityPostDto;
import com.englishcoach.community.dto.CommunityUserProfileDto;
import com.englishcoach.community.service.CommunityInteractionService;
import com.englishcoach.community.service.CommunityPostService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/community/feed")
@RequiredArgsConstructor
@Slf4j
public class CommunityFeedController {

    private final CommunityPostService postService;
    private final CommunityInteractionService interactionService;
    private final com.englishcoach.community.service.CommunityTrendingService trendingService;

    private Long getUserId(UserDetailsImpl principal) {
        return principal != null ? principal.getId() : null;
    }

    private boolean isAdmin(UserDetailsImpl principal) {
        if (principal == null || principal.getAuthorities() == null) return false;
        return principal.getAuthorities().stream().anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
    }

    private static final int MIN_PAGE_SIZE = 1;
    private static final int MAX_PAGE_SIZE = 50;

    private static int clampPage(int page) {
        return Math.max(0, page);
    }

    private static int clampSize(int size) {
        return Math.max(MIN_PAGE_SIZE, Math.min(size, MAX_PAGE_SIZE));
    }

    /**
     * Public Discover feed (Dành cho bạn).
     * Accessible by guests and authenticated users. Supports postType and hashtag filtering.
     */
    @GetMapping({"", "/", "/discover"})
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getDiscoverFeed(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size,
            @RequestParam(required = false) com.englishcoach.community.entity.PostType postType,
            @RequestParam(required = false) String hashtag
    ) {
        return ResponseEntity.ok(postService.getPublicFeed(getUserId(principal), clampPage(page), clampSize(size), postType, hashtag));
    }

    /**
     * Dynamic trending topics derived from real published posts.
     */
    @GetMapping("/trending")
    public ResponseEntity<java.util.List<com.englishcoach.community.dto.TrendingTopicDto>> getTrendingTopics() {
        return ResponseEntity.ok(trendingService.getTrendingTopics());
    }

    /**
     * Following feed (Đang theo dõi).
     * Requires authentication.
     */
    @GetMapping("/following")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getFollowingFeed(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        if (principal == null) {
            return ResponseEntity.status(401).build();
        }
        return ResponseEntity.ok(postService.getFollowingFeed(principal.getId(), clampPage(page), clampSize(size)));
    }

    /**
     * Author's own posts (/me).
     */
    @GetMapping("/me")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getMyPosts(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        if (principal == null) {
            return ResponseEntity.status(401).build();
        }
        return ResponseEntity.ok(postService.getMyPosts(principal.getId(), clampPage(page), clampSize(size)));
    }

    /**
     * Saved posts feed (Bài viết đã lưu - riêng tư).
     */
    @GetMapping("/saved")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getSavedFeed(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        if (principal == null) {
            return ResponseEntity.status(401).build();
        }
        return ResponseEntity.ok(postService.getSavedPosts(principal.getId(), clampPage(page), clampSize(size)));
    }

    /**
     * Posts by target user.
     */
    @GetMapping("/user/{userId}")
    public ResponseEntity<CommunityFeedPageDto<CommunityPostDto>> getUserFeed(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long userId,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "15") int size
    ) {
        return ResponseEntity.ok(postService.getUserPosts(getUserId(principal), userId, clampPage(page), clampSize(size)));
    }

    /**
     * User profile summary.
     */
    @GetMapping("/profile/{userId}")
    public ResponseEntity<CommunityUserProfileDto> getUserProfile(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long userId
    ) {
        return ResponseEntity.ok(interactionService.getUserProfile(getUserId(principal), userId));
    }

    /**
     * Single post detail.
     */
    @GetMapping("/posts/{id}")
    public ResponseEntity<CommunityPostDto> getPost(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long id
    ) {
        return ResponseEntity.ok(postService.getPostById(getUserId(principal), id, isAdmin(principal)));
    }
}
