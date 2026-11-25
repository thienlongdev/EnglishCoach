package com.englishcoach.community.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.community.dto.*;
import com.englishcoach.community.entity.*;
import com.englishcoach.community.repository.*;
import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.NoSuchElementException;
import java.util.Optional;

@Service
@RequiredArgsConstructor
@Slf4j
public class CommunityInteractionService {

    private final CommunityPostRepository postRepository;
    private final CommunityPostReactionRepository reactionRepository;
    private final CommunitySavedPostRepository savedPostRepository;
    private final CommunityFollowRepository followRepository;
    private final CommunityReportRepository reportRepository;
    private final CommunityCommentRepository commentRepository;
    private final UserRepository userRepository;
    private final NotificationService notificationService;
    private final CommunityAuthorEnrichmentService authorEnrichmentService;
    private final CommunityRestrictionService restrictionService;

    private com.englishcoach.messenger.MessengerRepository messengerRepository;
    private com.englishcoach.messenger.MessengerService messengerService;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setMessengerRepository(com.englishcoach.messenger.MessengerRepository messengerRepository) {
        this.messengerRepository = messengerRepository;
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setMessengerService(@org.springframework.context.annotation.Lazy com.englishcoach.messenger.MessengerService messengerService) {
        this.messengerService = messengerService;
    }

    // =========================================================================
    // POST REACTIONS
    // =========================================================================

    @Transactional
    public ReactionResponse toggleReaction(Long userId, Long postId, ReactionType reactionType) {
        if (userId == null) {
            throw new IllegalArgumentException("Vui lòng đăng nhập để bày tỏ cảm xúc");
        }
        restrictionService.assertCanReact(userId);
        if (reactionType == null) {
            throw new IllegalArgumentException("Loại cảm xúc không hợp lệ");
        }

        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        if (post.getStatus() != PostStatus.PUBLISHED) {
            throw new IllegalStateException("Không thể tương tác với bài viết chưa xuất bản");
        }

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy người dùng"));

        Optional<CommunityPostReaction> existingOpt = reactionRepository.findByPostIdAndUserId(postId, userId);

        ReactionType canonicalRequested = reactionType.canonical();
        ReactionType activeReaction;
        if (existingOpt.isPresent()) {
            CommunityPostReaction existing = existingOpt.get();
            if (existing.getReactionType().canonical() == canonicalRequested) {
                // Same reaction clicked again -> remove reaction (toggle off)
                reactionRepository.delete(existing);
                activeReaction = null;
            } else {
                // Different reaction clicked -> switch reaction
                existing.setReactionType(canonicalRequested);
                reactionRepository.save(existing);
                activeReaction = canonicalRequested;
            }
        } else {
            // First time reacting
            CommunityPostReaction newReaction = CommunityPostReaction.builder()
                    .post(post)
                    .user(user)
                    .reactionType(canonicalRequested)
                    .build();
            reactionRepository.save(newReaction);
            activeReaction = canonicalRequested;

            // Send notification to author if not reacting to own post
            if (!post.getAuthor().getId().equals(userId)) {
                try {
                    String reactorName = user.getName() != null ? user.getName() : "Một người dùng";
                    notificationService.create(new CreateNotificationCommand(
                            post.getAuthor().getId(),
                            NotificationCategory.COMMUNITY,
                            NotificationType.COMMUNITY_INTERACTION,
                            "Tương tác mới trên bài viết của bạn",
                            reactorName + " đã bày tỏ cảm xúc về bài viết của bạn.",
                            "/community?postId=" + postId,
                            "community_react_" + postId + "_" + userId
                    ));
                } catch (Exception e) {
                    log.warn("Could not dispatch reaction notification: {}", e.getMessage());
                }
            }
        }

        postRepository.refreshLikeCount(postId);

        // Fetch fresh likeCount
        int freshCount = (int) reactionRepository.countByPostId(postId);

        return ReactionResponse.builder()
                .postId(postId)
                .myReaction(activeReaction)
                .likeCount(freshCount)
                .build();
    }

    @Transactional(readOnly = true)
    public PostReactionSummaryDto getReactionSummary(Long postId, ReactionType filterType, Long currentUserId, int page, int size) {
        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        if (post.getStatus() != PostStatus.PUBLISHED) {
            boolean isAuthor = currentUserId != null && post.getAuthor() != null && post.getAuthor().getId().equals(currentUserId);
            if (post.getStatus() == PostStatus.DELETED || !isAuthor) {
                throw new NoSuchElementException("Bài viết không khả dụng");
            }
        }

        // 1. Grouped counts by canonical reaction type
        java.util.List<Object[]> grouped = reactionRepository.countGroupedByReactionType(postId);
        java.util.Map<String, Integer> countsByType = new java.util.LinkedHashMap<>();
        int totalCount = 0;
        for (Object[] row : grouped) {
            ReactionType rt = ((ReactionType) row[0]).canonical();
            int cnt = ((Number) row[1]).intValue();
            countsByType.merge(rt.name(), cnt, Integer::sum);
            totalCount += cnt;
        }

        // 2. Fetch paginated reactors with user fetch joined
        PageRequest pageRequest = PageRequest.of(Math.max(0, page), Math.max(1, Math.min(size, 50)));
        Page<CommunityPostReaction> reactionPage;
        if (filterType != null) {
            reactionPage = reactionRepository.findByPostIdAndReactionTypeWithUser(postId, filterType.canonical(), pageRequest);
        } else {
            reactionPage = reactionRepository.findByPostIdWithUser(postId, pageRequest);
        }

        java.util.List<PostReactorDto> reactors = reactionPage.getContent().stream().map(r -> {
            AuthorSummaryDto authorDto = authorEnrichmentService.enrichAuthor(r.getUser(), AuthorType.USER, currentUserId);
            return PostReactorDto.builder()
                    .user(authorDto)
                    .reactionType(r.getReactionType().canonical())
                    .createdAt(r.getCreatedAt())
                    .build();
        }).toList();

        return PostReactionSummaryDto.builder()
                .totalCount(totalCount)
                .countsByType(countsByType)
                .reactors(reactors)
                .build();
    }

    // =========================================================================
    // SAVED POSTS
    // =========================================================================

    @Transactional
    public boolean toggleSavePost(Long userId, Long postId) {
        if (userId == null) {
            throw new IllegalArgumentException("Vui lòng đăng nhập để lưu bài viết");
        }

        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        if (post.getStatus() != PostStatus.PUBLISHED) {
            throw new IllegalStateException("Không thể lưu bài viết chưa xuất bản");
        }

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy người dùng"));

        Optional<CommunitySavedPost> savedOpt = savedPostRepository.findByUserIdAndPostId(userId, postId);

        boolean isSaved;
        if (savedOpt.isPresent()) {
            savedPostRepository.delete(savedOpt.get());
            isSaved = false;
        } else {
            CommunitySavedPost saved = CommunitySavedPost.builder()
                    .user(user)
                    .post(post)
                    .build();
            savedPostRepository.save(saved);
            isSaved = true;
        }

        postRepository.refreshSaveCount(postId);
        return isSaved;
    }

    // =========================================================================
    // FOLLOW GRAPH
    // =========================================================================

    @Transactional
    public boolean followUser(Long followerId, Long followingId) {
        return followUser(followerId, followingId, true);
    }

    /** Echo Messenger tells the person in its own words (a friend request is more than a new follower); the relation is this same row. */
    @Transactional
    public boolean followUser(Long followerId, Long followingId, boolean notify) {
        if (followerId == null) {
            throw new IllegalArgumentException("Vui lòng đăng nhập để theo dõi");
        }
        if (followerId.equals(followingId)) {
            throw new IllegalArgumentException("Bạn không thể tự theo dõi chính mình");
        }
        restrictionService.assertCanReact(followerId);
        if (messengerRepository != null && followingId != null && messengerRepository.blockedEitherWay(followerId, followingId)) {
            throw new org.springframework.security.access.AccessDeniedException("Không thể theo dõi người dùng này");
        }
        if (messengerService != null && followingId != null
                && !followRepository.existsByFollowerIdAndFollowingId(followingId, followerId)
                && messengerService.isDeclinedCooldownActive(followerId, followingId)) {
            throw new org.springframework.security.access.AccessDeniedException("Bạn tạm thời chưa thể theo dõi lại người dùng này");
        }

        if (followRepository.existsByFollowerIdAndFollowingId(followerId, followingId)) {
            return true; // Already following
        }

        User follower = userRepository.findById(followerId)
                .orElseThrow(() -> new NoSuchElementException("Người theo dõi không tồn tại"));
        User following = userRepository.findById(followingId)
                .orElseThrow(() -> new NoSuchElementException("Người được theo dõi không tồn tại"));

        CommunityFollow follow = CommunityFollow.builder()
                .follower(follower)
                .following(following)
                .build();
        followRepository.save(follow);
        if (!notify) {
            return true;
        }

        try {
            String followerName = follower.getName() != null ? follower.getName() : "Một học viên";
            notificationService.create(new CreateNotificationCommand(
                    followingId,
                    NotificationCategory.COMMUNITY,
                    NotificationType.COMMUNITY_INTERACTION,
                    "Người theo dõi mới",
                    followerName + " đã bắt đầu theo dõi bạn trên EnglishCoach.",
                    "/community?userId=" + followerId,
                    "community_follow_" + followerId + "_" + followingId
            ));
        } catch (Exception e) {
            log.warn("Could not dispatch follow notification: {}", e.getMessage());
        }

        return true;
    }

    @Transactional
    public boolean unfollowUser(Long followerId, Long followingId) {
        if (followerId == null || followingId == null) {
            return false;
        }
        Optional<CommunityFollow> followOpt = followRepository.findByFollowerIdAndFollowingId(followerId, followingId);
        if (followOpt.isPresent()) {
            followRepository.delete(followOpt.get());
            return true;
        }
        return false;
    }

    @Transactional(readOnly = true)
    public CommunityUserProfileDto getUserProfile(Long currentUserId, Long targetUserId) {
        User targetUser = userRepository.findById(targetUserId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy người dùng"));

        AuthorSummaryDto author = authorEnrichmentService.enrichAuthor(targetUser, AuthorType.USER, currentUserId);
        long followers = followRepository.countByFollowingId(targetUserId);
        long following = followRepository.countByFollowerId(targetUserId);

        boolean isFollowing = currentUserId != null &&
                !currentUserId.equals(targetUserId) &&
                followRepository.existsByFollowerIdAndFollowingId(currentUserId, targetUserId);

        return CommunityUserProfileDto.builder()
                .id(targetUser.getId())
                .name(author.getName())
                .avatarUrl(author.getAvatarUrl())
                .frame(author.getFrame())
                .isPremium(author.isPremium())
                .streakDays(author.getStreakDays() != null ? author.getStreakDays() : 0)
                .cefrLevel(author.getCefrLevel())
                .followerCount(followers)
                .followingCount(following)
                .isFollowing(isFollowing)
                .build();
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<AuthorSummaryDto> getFollowers(Long currentUserId, Long targetUserId, int page, int size) {
        Page<CommunityFollow> followPage = followRepository.findFollowers(targetUserId, PageRequest.of(Math.max(0, page), Math.max(1, Math.min(size, 50))));
        var items = followPage.getContent().stream()
                .map(f -> authorEnrichmentService.enrichAuthor(f.getFollower(), AuthorType.USER, currentUserId))
                .toList();
        return CommunityFeedPageDto.<AuthorSummaryDto>builder()
                .items(items)
                .page(followPage.getNumber())
                .size(followPage.getSize())
                .totalElements(followPage.getTotalElements())
                .totalPages(followPage.getTotalPages())
                .hasMore(followPage.hasNext())
                .build();
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<AuthorSummaryDto> getFollowing(Long currentUserId, Long targetUserId, int page, int size) {
        Page<CommunityFollow> followPage = followRepository.findFollowing(targetUserId, PageRequest.of(Math.max(0, page), Math.max(1, Math.min(size, 50))));
        var items = followPage.getContent().stream()
                .map(f -> authorEnrichmentService.enrichAuthor(f.getFollowing(), AuthorType.USER, currentUserId))
                .toList();
        return CommunityFeedPageDto.<AuthorSummaryDto>builder()
                .items(items)
                .page(followPage.getNumber())
                .size(followPage.getSize())
                .totalElements(followPage.getTotalElements())
                .totalPages(followPage.getTotalPages())
                .hasMore(followPage.hasNext())
                .build();
    }

    // =========================================================================
    // POST REPORTS
    // =========================================================================

    @Transactional
    public void reportPost(Long userId, Long postId, ReportRequest request) {
        if (userId == null) {
            throw new IllegalArgumentException("Vui lòng đăng nhập để gửi báo cáo");
        }
        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        User reporter = userRepository.findById(userId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy người dùng"));

        CommunityReport report = CommunityReport.builder()
                .reporter(reporter)
                .post(post)
                .reason(request.getReason())
                .details(request.getDetails())
                .status(ReportStatus.PENDING)
                .build();

        reportRepository.save(report);
        log.info("Post {} reported by user {} for reason: {}", postId, userId, request.getReason());
    }

    @Transactional
    public void reportComment(Long userId, Long commentId, ReportRequest request) {
        if (userId == null) {
            throw new IllegalArgumentException("Vui lòng đăng nhập để gửi báo cáo");
        }
        CommunityComment comment = commentRepository.findById(commentId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bình luận"));

        User reporter = userRepository.findById(userId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy người dùng"));

        String commentSnippet = comment.getContent();
        if (commentSnippet != null && commentSnippet.length() > 80) {
            commentSnippet = commentSnippet.substring(0, 80) + "...";
        }

        String details = "[Báo cáo bình luận #" + commentId + "]: " +
                (request.getDetails() != null ? request.getDetails() : "") +
                " | Nội dung: \"" + (commentSnippet != null ? commentSnippet : "") + "\"";

        CommunityReport report = CommunityReport.builder()
                .reporter(reporter)
                .post(comment.getPost())
                .reason(request.getReason())
                .details(details)
                .status(ReportStatus.PENDING)
                .build();

        reportRepository.save(report);
        log.info("Comment {} (post {}) reported by user {} for reason: {}", commentId, comment.getPost().getId(), userId, request.getReason());
    }
}
