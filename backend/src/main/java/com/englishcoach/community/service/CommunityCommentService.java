package com.englishcoach.community.service;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.community.dto.*;
import com.englishcoach.community.entity.*;
import com.englishcoach.community.repository.CommunityCommentMediaRepository;
import com.englishcoach.community.repository.CommunityCommentReactionRepository;
import com.englishcoach.community.repository.CommunityCommentRepository;
import com.englishcoach.community.repository.CommunityPostMediaRepository;
import com.englishcoach.community.repository.CommunityPostRepository;
import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;
import java.util.regex.Pattern;

@Service
@RequiredArgsConstructor
@Slf4j
public class CommunityCommentService {

    private static final String ALLOWED_MEDIA_URL_PREFIX = "/api/v1/community/media/";
    private static final Pattern SAFE_STORAGE_KEY = Pattern.compile("^[A-Za-z0-9._-]{1,128}$");

    private final CommunityCommentRepository commentRepository;
    private final CommunityCommentReactionRepository commentReactionRepository;
    private final CommunityCommentMediaRepository commentMediaRepository;
    private final CommunityPostRepository postRepository;
    private final UserRepository userRepository;
    private final CommunityAuthorEnrichmentService authorEnrichmentService;
    private final NotificationService notificationService;
    private final CommunityRestrictionService restrictionService;

    private CommunityPostMediaRepository postMediaRepository;
    private com.englishcoach.auth.policy.AdminIdentityService adminIdentityService;

    @Autowired(required = false)
    public void setPostMediaRepository(CommunityPostMediaRepository postMediaRepository) {
        this.postMediaRepository = postMediaRepository;
    }

    @Autowired(required = false)
    public void setAdminIdentityService(com.englishcoach.auth.policy.AdminIdentityService adminIdentityService) {
        this.adminIdentityService = adminIdentityService;
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommentDto> getComments(Long currentUserId, Long postId, int page, int size) {
        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        assertPostVisibleForReading(post, currentUserId);

        List<CommunityComment> allComments = commentRepository.findAllPublishedForPost(postId);

        if (allComments.isEmpty()) {
            return CommunityFeedPageDto.<CommentDto>builder()
                    .items(Collections.emptyList())
                    .page(page)
                    .size(size)
                    .totalElements(0)
                    .totalPages(0)
                    .hasMore(false)
                    .build();
        }

        List<Long> allCommentIds = allComments.stream().map(CommunityComment::getId).toList();

        // Batch load current user reactions
        Map<Long, ReactionType> userReactionMap = new HashMap<>();
        if (currentUserId != null && !allCommentIds.isEmpty()) {
            List<CommunityCommentReaction> userReactions = commentReactionRepository.findByCommentIdInAndUserId(allCommentIds, currentUserId);
            for (CommunityCommentReaction cr : userReactions) {
                try {
                    ReactionType rt = ReactionType.valueOf(cr.getReactionType()).canonical();
                    userReactionMap.put(cr.getComment().getId(), rt);
                } catch (Exception ignored) {
                    userReactionMap.put(cr.getComment().getId(), ReactionType.LOVE);
                }
            }
        }

        // Batch load all reactions with users to build counts and previews
        Map<Long, Map<String, Integer>> reactionCountsMap = new HashMap<>();
        Map<Long, List<CommentReactorPreviewDto>> topReactorsMap = new HashMap<>();

        if (!allCommentIds.isEmpty()) {
            List<CommunityCommentReaction> allReactions = commentReactionRepository.findByCommentIdInWithUser(allCommentIds);
            for (CommunityCommentReaction cr : allReactions) {
                Long cId = cr.getComment().getId();
                ReactionType rt;
                try {
                    rt = ReactionType.valueOf(cr.getReactionType()).canonical();
                } catch (Exception e) {
                    rt = ReactionType.LOVE;
                }

                reactionCountsMap.computeIfAbsent(cId, k -> new LinkedHashMap<>())
                        .merge(rt.name(), 1, Integer::sum);

                List<CommentReactorPreviewDto> previews = topReactorsMap.computeIfAbsent(cId, k -> new ArrayList<>());
                if (previews.size() < 5) {
                    String name = cr.getUser().getName() != null ? cr.getUser().getName() : "Một học viên";
                    previews.add(new CommentReactorPreviewDto(name, rt));
                }
            }
        }

        // Batch load all media attachments
        Map<Long, List<CommunityCommentMediaDto>> commentMediaMap = new HashMap<>();
        if (!allCommentIds.isEmpty()) {
            List<CommunityCommentMedia> allMedia = commentMediaRepository.findByCommentIdInOrderByDisplayOrderAsc(allCommentIds);
            for (CommunityCommentMedia m : allMedia) {
                commentMediaMap.computeIfAbsent(m.getComment().getId(), k -> new ArrayList<>())
                        .add(new CommunityCommentMediaDto(m.getId(), m.getMediaUrl(), m.getMediaType(), m.getDisplayOrder()));
            }
        }

        // Build flat DTOs
        Map<Long, CommentDto> dtoMap = new LinkedHashMap<>();
        for (CommunityComment c : allComments) {
            AuthorSummaryDto author = authorEnrichmentService.enrichAuthor(c.getUser(), AuthorType.USER, currentUserId);
            ReactionType myReaction = userReactionMap.get(c.getId());
            String replyToAuthor = (c.getParentComment() != null && c.getParentComment().getUser() != null)
                    ? c.getParentComment().getUser().getName()
                    : null;

            List<CommunityCommentMediaDto> mediaList = commentMediaMap.getOrDefault(c.getId(), Collections.emptyList());
            String effectiveMediaUrl = c.getMediaUrl();
            String effectiveMediaType = c.getMediaType();
            if ((effectiveMediaUrl == null || effectiveMediaUrl.isBlank()) && !mediaList.isEmpty()) {
                effectiveMediaUrl = mediaList.get(0).getMediaUrl();
                effectiveMediaType = mediaList.get(0).getMediaType();
            }

            CommentDto dto = CommentDto.builder()
                    .id(c.getId())
                    .postId(postId)
                    .author(author)
                    .parentCommentId(c.getParentComment() != null ? c.getParentComment().getId() : null)
                    .replyToAuthorName(replyToAuthor)
                    .content(c.getContent())
                    .mediaUrl(effectiveMediaUrl)
                    .mediaType(effectiveMediaType)
                    .media(mediaList)
                    .status(c.getStatus())
                    .likeCount(c.getLikeCount())
                    .replyCount(c.getReplyCount())
                    .isLiked(myReaction != null)
                    .myReaction(myReaction)
                    .reactionCounts(reactionCountsMap.getOrDefault(c.getId(), Collections.emptyMap()))
                    .topReactors(topReactorsMap.getOrDefault(c.getId(), Collections.emptyList()))
                    .createdAt(c.getCreatedAt())
                    .replies(new ArrayList<>())
                    .build();

            dtoMap.put(c.getId(), dto);
        }

        // Assemble recursive thread tree
        List<CommentDto> rootDtos = new ArrayList<>();
        for (CommentDto dto : dtoMap.values()) {
            if (dto.getParentCommentId() != null && dtoMap.containsKey(dto.getParentCommentId())) {
                dtoMap.get(dto.getParentCommentId()).getReplies().add(dto);
            } else {
                rootDtos.add(dto);
            }
        }

        return CommunityFeedPageDto.<CommentDto>builder()
                .items(rootDtos)
                .page(0)
                .size(rootDtos.size())
                .totalElements(rootDtos.size())
                .totalPages(1)
                .hasMore(false)
                .build();
    }

    @Transactional
    public CommentDto createComment(Long userId, Long postId, CreateCommentRequest request) {
        if (userId == null) {
            throw new IllegalArgumentException("Vui lòng đăng nhập để bình luận");
        }

        // 1. Enforce user restriction check
        restrictionService.assertCanComment(userId);

        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        if (post.getStatus() != PostStatus.PUBLISHED) {
            throw new IllegalStateException("Không thể bình luận trên bài viết chưa xuất bản");
        }

        // 2. Enforce comment lock check
        if (post.isCommentsLockedByAdmin()) {
            throw new IllegalStateException("Bình luận đã bị khóa bởi quản trị viên");
        }
        if (post.isCommentsDisabledByOwner()) {
            throw new IllegalStateException("Bình luận đã bị tắt cho bài viết này");
        }

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy người dùng"));

        CommunityComment parent = null;
        if (request.getParentCommentId() != null) {
            parent = commentRepository.findById(request.getParentCommentId())
                    .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bình luận gốc"));

            if (!parent.getPost().getId().equals(postId)) {
                throw new IllegalArgumentException("Bình luận cha không thuộc bài viết này");
            }
            // Real hierarchy: parent is the authoritative direct target of reply
        }

        // Aggregate and normalize media items
        List<CreateCommentRequest.CommentMediaItemRequest> requestedMedia = new ArrayList<>();
        if (request.getMedia() != null && !request.getMedia().isEmpty()) {
            for (CreateCommentRequest.CommentMediaItemRequest item : request.getMedia()) {
                if (item != null && item.getMediaUrl() != null && !item.getMediaUrl().isBlank()) {
                    requestedMedia.add(new CreateCommentRequest.CommentMediaItemRequest(
                            item.getMediaUrl().trim(),
                            item.getMediaType() != null ? item.getMediaType().trim() : null
                    ));
                }
            }
        } else if (request.getMediaUrls() != null && !request.getMediaUrls().isEmpty()) {
            for (String u : request.getMediaUrls()) {
                if (u != null && !u.isBlank()) {
                    requestedMedia.add(new CreateCommentRequest.CommentMediaItemRequest(u.trim(), null));
                }
            }
        } else if (request.getMediaUrl() != null && !request.getMediaUrl().isBlank()) {
            requestedMedia.add(new CreateCommentRequest.CommentMediaItemRequest(
                    request.getMediaUrl().trim(),
                    request.getMediaType() != null ? request.getMediaType().trim() : null
            ));
        }

        // Validate media counts: max 5 images, max 1 video
        int imageCount = 0;
        int videoCount = 0;
        for (CreateCommentRequest.CommentMediaItemRequest item : requestedMedia) {
            boolean isVideo = isVideoMedia(item.getMediaType(), item.getMediaUrl());
            if (isVideo) {
                videoCount++;
            } else {
                imageCount++;
            }
        }

        if (imageCount > 5) {
            throw new IllegalArgumentException("Bình luận tối đa 5 hình ảnh");
        }
        if (videoCount > 1) {
            throw new IllegalArgumentException("Bình luận tối đa 1 video");
        }

        // Validate comment media URLs: only relative /api/v1/community/media/{storageKey} uploaded by userId
        requestedMedia = validateAndNormalizeCommentMedia(userId, requestedMedia);

        String trimmedContent = request.getContent() != null ? request.getContent().trim() : null;
        if ((trimmedContent == null || trimmedContent.isEmpty()) && requestedMedia.isEmpty()) {
            throw new IllegalArgumentException("Nội dung hoặc file đính kèm không được để trống");
        }

        String primaryMediaUrl = requestedMedia.isEmpty() ? null : requestedMedia.get(0).getMediaUrl();
        String primaryMediaType = requestedMedia.isEmpty() ? null : (
                requestedMedia.get(0).getMediaType() != null && !requestedMedia.get(0).getMediaType().isBlank()
                        ? requestedMedia.get(0).getMediaType()
                        : (isVideoMedia(null, primaryMediaUrl) ? "video/mp4" : "image/jpeg")
        );

        CommunityComment comment = CommunityComment.builder()
                .post(post)
                .user(user)
                .parentComment(parent)
                .content(trimmedContent)
                .mediaUrl(primaryMediaUrl)
                .mediaType(primaryMediaType)
                .status("PUBLISHED")
                .likeCount(0)
                .replyCount(0)
                .build();

        comment = commentRepository.save(comment);

        // Save media attachments to community_comment_media
        List<CommunityCommentMediaDto> savedMediaDtos = new ArrayList<>();
        int order = 0;
        for (CreateCommentRequest.CommentMediaItemRequest item : requestedMedia) {
            String mUrl = item.getMediaUrl();
            String mType = item.getMediaType();
            if (mType == null || mType.isBlank()) {
                mType = isVideoMedia(null, mUrl) ? "video/mp4" : "image/jpeg";
            }
            CommunityCommentMedia cm = CommunityCommentMedia.builder()
                    .comment(comment)
                    .mediaUrl(mUrl)
                    .mediaType(mType)
                    .displayOrder(order++)
                    .build();
            CommunityCommentMedia saved = commentMediaRepository.save(cm);
            if (saved == null) {
                saved = cm;
            }
            savedMediaDtos.add(new CommunityCommentMediaDto(saved.getId(), saved.getMediaUrl(), saved.getMediaType(), saved.getDisplayOrder()));
        }

        if (parent != null) {
            parent.setReplyCount(parent.getReplyCount() + 1);
            commentRepository.save(parent);
        }

        postRepository.refreshCommentCount(postId);

        AuthorSummaryDto authorDto = authorEnrichmentService.enrichAuthor(user, AuthorType.USER, userId);

        // Notifications
        try {
            String commenterName = user.getName() != null ? user.getName() : "Một học viên";
            String previewText = comment.getContent() != null && !comment.getContent().isBlank()
                    ? comment.getContent()
                    : (!savedMediaDtos.isEmpty() ? "[File đính kèm]" : "");

            if (parent != null && !parent.getUser().getId().equals(userId)) {
                notificationService.create(new CreateNotificationCommand(
                        parent.getUser().getId(),
                        NotificationCategory.COMMUNITY,
                        NotificationType.COMMUNITY_INTERACTION,
                        "Phản hồi mới cho bình luận của bạn",
                        commenterName + " đã trả lời bình luận của bạn: \"" + truncate(previewText, 60) + "\"",
                        "/community?postId=" + postId,
                        "community_reply_" + comment.getId()
                ));
            } else if (!post.getAuthor().getId().equals(userId)) {
                notificationService.create(new CreateNotificationCommand(
                        post.getAuthor().getId(),
                        NotificationCategory.COMMUNITY,
                        NotificationType.COMMUNITY_INTERACTION,
                        "Bình luận mới trên bài viết của bạn",
                        commenterName + " đã bình luận: \"" + truncate(previewText, 60) + "\"",
                        "/community?postId=" + postId,
                        "community_comment_" + comment.getId()
                ));
            }
        } catch (Exception e) {
            log.warn("Could not dispatch comment notification: {}", e.getMessage());
        }

        String replyToAuthor = parent != null && parent.getUser() != null ? parent.getUser().getName() : null;

        return CommentDto.builder()
                .id(comment.getId())
                .postId(postId)
                .author(authorDto)
                .parentCommentId(parent != null ? parent.getId() : null)
                .replyToAuthorName(replyToAuthor)
                .content(comment.getContent())
                .mediaUrl(comment.getMediaUrl())
                .mediaType(comment.getMediaType())
                .media(savedMediaDtos)
                .status(comment.getStatus())
                .likeCount(0)
                .replyCount(0)
                .isLiked(false)
                .myReaction(null)
                .reactionCounts(Collections.emptyMap())
                .topReactors(Collections.emptyList())
                .createdAt(comment.getCreatedAt())
                .replies(Collections.emptyList())
                .build();
    }

    @Transactional
    public void deleteComment(Long userId, Long commentId, boolean isAdmin) {
        CommunityComment comment = commentRepository.findById(commentId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bình luận"));

        if (!comment.getUser().getId().equals(userId) && !isAdmin) {
            throw new org.springframework.security.access.AccessDeniedException("Bạn không có quyền xóa bình luận này");
        }

        comment.setStatus("DELETED");
        commentRepository.save(comment);

        if (comment.getParentComment() != null) {
            CommunityComment p = comment.getParentComment();
            p.setReplyCount(Math.max(0, p.getReplyCount() - 1));
            commentRepository.save(p);
        }

        postRepository.refreshCommentCount(comment.getPost().getId());
    }

    @Transactional
    public CommentReactionResponseDto reactToComment(Long userId, Long commentId, ReactionType reactionType) {
        if (userId == null) {
            throw new IllegalArgumentException("Vui lòng đăng nhập để bày tỏ cảm xúc");
        }
        if (reactionType == null) {
            throw new IllegalArgumentException("Loại cảm xúc không hợp lệ");
        }

        // Enforce restriction check
        restrictionService.assertCanReact(userId);

        CommunityComment comment = commentRepository.findById(commentId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bình luận"));

        if (!"PUBLISHED".equals(comment.getStatus())) {
            throw new IllegalStateException("Không thể tương tác với bình luận không khả dụng");
        }
        if (comment.getPost() == null || comment.getPost().getStatus() != PostStatus.PUBLISHED) {
            throw new IllegalStateException("Không thể tương tác với bình luận trên bài viết chưa xuất bản");
        }

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy người dùng"));

        ReactionType canonicalRequested = reactionType.canonical();
        Optional<CommunityCommentReaction> existingOpt = commentReactionRepository.findByCommentIdAndUserId(commentId, userId);
        ReactionType activeReaction;

        if (existingOpt.isPresent()) {
            CommunityCommentReaction existing = existingOpt.get();
            ReactionType currentType;
            try {
                currentType = ReactionType.valueOf(existing.getReactionType()).canonical();
            } catch (Exception e) {
                currentType = ReactionType.LOVE;
            }

            if (currentType == canonicalRequested) {
                // Clicked same reaction -> toggle off / remove
                commentReactionRepository.delete(existing);
                activeReaction = null;
            } else {
                // Switched reaction
                existing.setReactionType(canonicalRequested.name());
                commentReactionRepository.save(existing);
                activeReaction = canonicalRequested;
            }
        } else {
            // First time reaction
            CommunityCommentReaction newReaction = CommunityCommentReaction.builder()
                    .comment(comment)
                    .user(user)
                    .reactionType(canonicalRequested.name())
                    .build();
            commentReactionRepository.save(newReaction);
            activeReaction = canonicalRequested;
        }

        int freshCount = (int) commentReactionRepository.countByCommentId(commentId);
        comment.setLikeCount(freshCount);
        commentRepository.save(comment);

        // Grouped reaction counts
        List<Object[]> grouped = commentReactionRepository.countGroupedByReactionType(commentId);
        Map<String, Integer> countsByType = new LinkedHashMap<>();
        for (Object[] row : grouped) {
            String rawType = (String) row[0];
            ReactionType rt;
            try {
                rt = ReactionType.valueOf(rawType).canonical();
            } catch (Exception e) {
                rt = ReactionType.LOVE;
            }
            int cnt = ((Number) row[1]).intValue();
            countsByType.merge(rt.name(), cnt, Integer::sum);
        }

        // Top reactors preview
        List<CommunityCommentReaction> topReactions = commentReactionRepository.findTopReactorsByCommentId(
                commentId, PageRequest.of(0, 5)
        );
        List<CommentReactorPreviewDto> topReactors = topReactions.stream().map(r -> {
            ReactionType rt;
            try {
                rt = ReactionType.valueOf(r.getReactionType()).canonical();
            } catch (Exception e) {
                rt = ReactionType.LOVE;
            }
            return CommentReactorPreviewDto.builder()
                    .displayName(r.getUser().getName() != null ? r.getUser().getName() : "Một học viên")
                    .reactionType(rt)
                    .build();
        }).toList();

        return CommentReactionResponseDto.builder()
                .commentId(commentId)
                .myReaction(activeReaction)
                .likeCount(freshCount)
                .countsByType(countsByType)
                .topReactors(topReactors)
                .build();
    }

    @Transactional
    public boolean toggleCommentReaction(Long userId, Long commentId) {
        CommentReactionResponseDto res = reactToComment(userId, commentId, ReactionType.LOVE);
        return res.getMyReaction() != null;
    }

    private void assertPostVisibleForReading(CommunityPost post, Long currentUserId) {
        if (post.getStatus() == PostStatus.PUBLISHED) {
            return;
        }
        if (currentUserId == null) {
            throw new NoSuchElementException("Bài viết không khả dụng");
        }
        boolean isAuthor = post.getAuthor() != null && currentUserId.equals(post.getAuthor().getId());
        boolean isOfficialAdmin;
        if (adminIdentityService != null) {
            isOfficialAdmin = adminIdentityService.isOfficialAdmin(currentUserId);
        } else {
            var session = com.englishcoach.common.security.AuthSessionContext.current();
            boolean withheld = session != null && currentUserId.equals(session.userId()) && session.adminAuthorityWithheld();
            isOfficialAdmin = !withheld && userRepository.findById(currentUserId)
                    .map(u -> com.englishcoach.auth.policy.OfficialAdminPolicy.isOfficialAdmin(u.getEmail(), u.getRole()))
                    .orElse(false);
        }
        if (post.getStatus() == PostStatus.DELETED) {
            if (!isOfficialAdmin) {
                throw new NoSuchElementException("Bài viết không khả dụng");
            }
            return;
        }
        if (!isAuthor && !isOfficialAdmin) {
            throw new NoSuchElementException("Bài viết không khả dụng");
        }
    }

    private List<CreateCommentRequest.CommentMediaItemRequest> validateAndNormalizeCommentMedia(
            Long userId,
            List<CreateCommentRequest.CommentMediaItemRequest> requestedMedia
    ) {
        if (requestedMedia.isEmpty()) {
            return requestedMedia;
        }
        if (postMediaRepository == null) {
            throw new IllegalArgumentException("Không thể xác thực tệp đính kèm");
        }
        List<CreateCommentRequest.CommentMediaItemRequest> validated = new ArrayList<>(requestedMedia.size());
        for (CreateCommentRequest.CommentMediaItemRequest item : requestedMedia) {
            String rawUrl = item.getMediaUrl();
            if (rawUrl == null || !rawUrl.startsWith(ALLOWED_MEDIA_URL_PREFIX)) {
                throw new IllegalArgumentException("Đường dẫn tệp đính kèm không hợp lệ");
            }
            String storageKey = rawUrl.substring(ALLOWED_MEDIA_URL_PREFIX.length());
            if (!SAFE_STORAGE_KEY.matcher(storageKey).matches() || storageKey.contains("..")) {
                throw new IllegalArgumentException("Đường dẫn tệp đính kèm không hợp lệ");
            }
            CommunityPostMedia media = postMediaRepository.findByStorageKey(storageKey)
                    .orElseThrow(() -> new IllegalArgumentException("Tệp đính kèm không tồn tại"));
            if (media.getUserId() == null || !media.getUserId().equals(userId)) {
                throw new IllegalArgumentException("Không thể sử dụng tệp đính kèm của người dùng khác");
            }
            String canonicalUrl = ALLOWED_MEDIA_URL_PREFIX + storageKey;
            String verifiedMime = (media.getMimeType() != null && !media.getMimeType().isBlank())
                    ? media.getMimeType()
                    : item.getMediaType();
            validated.add(new CreateCommentRequest.CommentMediaItemRequest(canonicalUrl, verifiedMime));
        }
        return validated;
    }

    private String truncate(String text, int max) {
        if (text == null) return "";
        return text.length() <= max ? text : text.substring(0, max) + "...";
    }

    private boolean isVideoMedia(String mimeType, String urlOrFilename) {
        if (mimeType != null && mimeType.toLowerCase().startsWith("video/")) {
            return true;
        }
        if (urlOrFilename != null) {
            String lower = urlOrFilename.toLowerCase();
            return lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mov");
        }
        return false;
    }
}
