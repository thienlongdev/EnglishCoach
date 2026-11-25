package com.englishcoach.community.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.community.dto.*;
import com.englishcoach.community.entity.*;
import com.englishcoach.community.repository.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Slf4j
public class CommunityPostService {

    private final CommunityPostRepository postRepository;
    private final CommunityPostMediaRepository mediaRepository;
    private final CommunityPostReactionRepository reactionRepository;
    private final CommunitySavedPostRepository savedPostRepository;
    private final CommunityModerationRecordRepository moderationRecordRepository;
    private final UserRepository userRepository;
    private final CommunityAuthorEnrichmentService authorEnrichmentService;
    private final CommunityLearningValidationService learningValidationService;
    private final CommunityRestrictionService restrictionService;

    private static final int MAX_PAGE_SIZE = 50;

    private static int clampPage(int page) {
        return Math.max(0, page);
    }

    private static int clampSize(int size) {
        return Math.max(1, Math.min(size, MAX_PAGE_SIZE));
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getPublicFeed(Long currentUserId, int page, int size) {
        return getPublicFeed(currentUserId, page, size, null, null);
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getPublicFeed(
            Long currentUserId,
            int page,
            int size,
            PostType postType,
            String hashtag
    ) {
        int safePage = clampPage(page);
        int safeSize = clampSize(size);
        Page<CommunityPost> postPage;
        String pattern = hashtagPattern(hashtag);

        if (postType != null && pattern != null) {
            postPage = postRepository.findPublicFeedByPostTypeAndHashtag(postType, pattern, PageRequest.of(safePage, safeSize));
        } else if (postType != null) {
            postPage = postRepository.findPublicFeedByPostType(postType, PageRequest.of(safePage, safeSize));
        } else if (pattern != null) {
            postPage = postRepository.findPublicFeedByHashtag(pattern, PageRequest.of(safePage, safeSize));
        } else {
            postPage = postRepository.findPublicFeed(PageRequest.of(safePage, safeSize));
        }

        List<CommunityPostDto> dtos = mapPostsToDtos(postPage.getContent(), currentUserId);
        return toFeedPage(postPage, dtos);
    }

    // Same hashtag alphabet as Community's link renderer and trending extractor.
    // Validate before interpolation: '_' is literal and wildcards cannot broaden a query.
    static String hashtagPattern(String hashtag) {
        if (hashtag == null || hashtag.isBlank()) return null;
        String tag = hashtag.trim().replaceFirst("^#", "");
        String alphabet = "a-zA-Z0-9_\u00C0-\u024F\u1EA0-\u1EF9";
        if (!tag.matches("[" + alphabet + "]+")) {
            throw new IllegalArgumentException("Hashtag không hợp lệ");
        }
        return "#" + tag.toLowerCase(Locale.ROOT) + "($|[^" + alphabet + "])";
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getFollowingFeed(Long currentUserId, int page, int size) {
        int safePage = clampPage(page);
        int safeSize = clampSize(size);
        if (currentUserId == null) {
            return CommunityFeedPageDto.<CommunityPostDto>builder()
                    .items(Collections.emptyList())
                    .page(safePage)
                    .size(safeSize)
                    .totalElements(0)
                    .totalPages(0)
                    .hasMore(false)
                    .build();
        }
        Page<CommunityPost> postPage = postRepository.findFollowingFeed(currentUserId, PageRequest.of(safePage, safeSize));
        List<CommunityPostDto> dtos = mapPostsToDtos(postPage.getContent(), currentUserId);
        return toFeedPage(postPage, dtos);
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getMyPosts(Long currentUserId, int page, int size) {
        if (currentUserId == null) {
            throw new IllegalArgumentException("Vui lòng đăng nhập để xem bài viết của bạn");
        }
        Page<CommunityPost> postPage = postRepository.findAuthorPostsForAuthor(currentUserId, PageRequest.of(clampPage(page), clampSize(size)));
        List<CommunityPostDto> dtos = mapPostsToDtos(postPage.getContent(), currentUserId);
        return toFeedPage(postPage, dtos);
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getUserPosts(Long currentUserId, Long targetUserId, int page, int size) {
        if (targetUserId == null) {
            throw new IllegalArgumentException("Mã người dùng không hợp lệ");
        }
        int safePage = clampPage(page);
        int safeSize = clampSize(size);
        if (targetUserId.equals(currentUserId)) {
            return getMyPosts(currentUserId, safePage, safeSize);
        }
        Page<CommunityPost> postPage = postRepository.findAuthorPostsPublic(targetUserId, PageRequest.of(safePage, safeSize));
        List<CommunityPostDto> dtos = mapPostsToDtos(postPage.getContent(), currentUserId);
        return toFeedPage(postPage, dtos);
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getSavedPosts(Long currentUserId, int page, int size) {
        if (currentUserId == null) {
            throw new IllegalArgumentException("Vui lòng đăng nhập để xem bài viết đã lưu");
        }
        Page<CommunityPost> postPage = postRepository.findSavedPosts(currentUserId, PageRequest.of(clampPage(page), clampSize(size)));
        List<CommunityPostDto> dtos = mapPostsToDtos(postPage.getContent(), currentUserId);
        return toFeedPage(postPage, dtos);
    }

    @Transactional(readOnly = true)
    public CommunityPostDto getPostById(Long currentUserId, Long postId, boolean isAdmin) {
        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        if (post.getStatus() != PostStatus.PUBLISHED) {
            boolean isAuthor = currentUserId != null && post.getAuthor().getId().equals(currentUserId);
            if (!isAuthor && !isAdmin) {
                throw new NoSuchElementException("Bài viết không khả dụng hoặc đang chờ duyệt");
            }
        }

        List<CommunityPostDto> dtos = mapPostsToDtos(Collections.singletonList(post), currentUserId);
        return dtos.get(0);
    }

    @Transactional
    public CommunityPostDto createPost(Long userId, CreatePostRequest request) {
        restrictionService.assertCanPost(userId);

        User author = userRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("Người dùng không tồn tại"));

        // Validate shared learning embed
        SharedLearningEmbedDto embed = null;
        String serializedEmbed = null;
        if (request.getSharedEntityType() != null && request.getSharedEntityId() != null) {
            embed = learningValidationService.validateAndBuildEmbed(
                    request.getSharedEntityType(),
                    request.getSharedEntityId(),
                    userId,
                    false
            );
            serializedEmbed = learningValidationService.serializeEmbed(embed);
        }

        PostType pType = request.getPostType() != null && request.getPostType() != PostType.OFFICIAL
                ? request.getPostType()
                : PostType.GENERAL;

        CommunityPost post = CommunityPost.builder()
                .author(author)
                .authorType(AuthorType.USER)
                .status(PostStatus.PENDING) // Always PENDING for regular users
                .postType(pType)
                .content(request.getContent().trim())
                .isPinned(false)
                .isFeatured(false)
                .likeCount(0)
                .commentCount(0)
                .saveCount(0)
                .sharedEntityType(request.getSharedEntityType())
                .sharedEntityId(request.getSharedEntityId())
                .sharedEntityPayload(serializedEmbed)
                .build();

        post = postRepository.save(post);

        // Attach media if provided (via mediaIds or mediaUrls)
        List<CommunityPostMedia> mediaList = new ArrayList<>();
        if (request.getMediaIds() != null && !request.getMediaIds().isEmpty()) {
            mediaList.addAll(mediaRepository.findAllById(request.getMediaIds()));
        }
        if (request.getMediaUrls() != null && !request.getMediaUrls().isEmpty()) {
            List<String> storageKeys = request.getMediaUrls().stream()
                    .map(url -> url.contains("/") ? url.substring(url.lastIndexOf('/') + 1) : url)
                    .filter(k -> !k.isBlank())
                    .toList();
            if (!storageKeys.isEmpty()) {
                List<CommunityPostMedia> fromUrls = mediaRepository.findByStorageKeyIn(storageKeys);
                Map<String, CommunityPostMedia> keyMap = fromUrls.stream()
                        .collect(Collectors.toMap(CommunityPostMedia::getStorageKey, m -> m, (a, b) -> a));
                for (String key : storageKeys) {
                    CommunityPostMedia m = keyMap.get(key);
                    if (m != null && mediaList.stream().noneMatch(existing -> existing.getId().equals(m.getId()))) {
                        mediaList.add(m);
                    }
                }
            }
        }
        if (!mediaList.isEmpty()) {
            long videoCount = mediaList.stream()
                    .filter(m -> m.getMimeType() != null && m.getMimeType().toLowerCase().startsWith("video/"))
                    .count();
            long imageCount = mediaList.size() - videoCount;
            if (imageCount > 10) {
                throw new IllegalArgumentException("Mỗi bài viết chỉ được đính kèm tối đa 10 hình ảnh");
            }
            if (videoCount > 2) {
                throw new IllegalArgumentException("Mỗi bài viết chỉ được đính kèm tối đa 2 video");
            }

            int order = 0;
            for (CommunityPostMedia m : mediaList) {
                // Validate ownership: staged media must belong to the current author
                if (m.getUserId() == null || !m.getUserId().equals(userId)) {
                    throw new org.springframework.security.access.AccessDeniedException("Không thể sử dụng tệp đính kèm của người dùng khác");
                }
                // Validate that media is not already bound to another post
                if (m.getPost() != null && !m.getPost().getId().equals(post.getId())) {
                    throw new IllegalArgumentException("Tệp đính kèm đã được liên kết với bài viết khác");
                }
                m.setPost(post);
                m.setDisplayOrder(order++);
                mediaRepository.save(m);
                post.getMediaList().add(m);
            }
        }

        return mapSinglePostToDto(post, embed, currentReaction(post.getId(), userId), false, authorEnrichmentService.enrichAuthor(author, AuthorType.USER, userId));
    }

    @Transactional
    public CommunityPostDto updatePost(Long userId, Long postId, UpdatePostRequest request) {
        restrictionService.assertCanPost(userId);

        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        if (!post.getAuthor().getId().equals(userId)) {
            throw new org.springframework.security.access.AccessDeniedException("Bạn không có quyền chỉnh sửa bài viết này");
        }

        if (post.getStatus() == PostStatus.DELETED || post.getStatus() == PostStatus.HIDDEN) {
            throw new IllegalStateException("Không thể chỉnh sửa bài viết đã xóa hoặc bị ẩn");
        }

        String oldContent = post.getContent();
        String newContent = request.getContent().trim();
        boolean contentChanged = !Objects.equals(oldContent, newContent);
        boolean mediaChanged = false;
        post.setContent(newContent);

        // Update media attachments if specified
        if (request.getMediaIds() != null || request.getMediaUrls() != null) {
            List<CommunityPostMedia> currentMedia = mediaRepository.findByPostIdOrderByDisplayOrderAsc(postId);
            List<CommunityPostMedia> newMedia = new ArrayList<>();
            if (request.getMediaIds() != null && !request.getMediaIds().isEmpty()) {
                newMedia.addAll(mediaRepository.findAllById(request.getMediaIds()));
            }
            if (request.getMediaUrls() != null && !request.getMediaUrls().isEmpty()) {
                List<String> storageKeys = request.getMediaUrls().stream()
                    .filter(Objects::nonNull)
                    .map(String::trim)
                    .map(url -> url.contains("/") ? url.substring(url.lastIndexOf('/') + 1) : url)
                    .filter(k -> !k.isBlank() && !k.contains(".."))
                    .toList();
                if (!storageKeys.isEmpty()) {
                    List<CommunityPostMedia> fromUrls = mediaRepository.findByStorageKeyIn(storageKeys);
                    Map<String, CommunityPostMedia> keyMap = fromUrls.stream()
                            .collect(Collectors.toMap(CommunityPostMedia::getStorageKey, m -> m, (a, b) -> a));
                    for (String key : storageKeys) {
                        CommunityPostMedia m = keyMap.get(key);
                        if (m != null && newMedia.stream().noneMatch(existing -> existing.getId().equals(m.getId()))) {
                            newMedia.add(m);
                        }
                    }
                }
            }
            long videoCount = newMedia.stream()
                    .filter(m -> m.getMimeType() != null && m.getMimeType().toLowerCase().startsWith("video/"))
                    .count();
            long imageCount = newMedia.size() - videoCount;
            if (imageCount > 10) {
                throw new IllegalArgumentException("Mỗi bài viết chỉ được đính kèm tối đa 10 hình ảnh");
            }
            if (videoCount > 2) {
                throw new IllegalArgumentException("Mỗi bài viết chỉ được đính kèm tối đa 2 video");
            }

            // Same rules as creation: validate ownership & post binding BEFORE modifying or deleting existing media.
            for (CommunityPostMedia m : newMedia) {
                if (m.getUserId() == null || !m.getUserId().equals(userId)) {
                    throw new org.springframework.security.access.AccessDeniedException("Không thể sử dụng tệp đính kèm của người dùng khác");
                }
                if (m.getPost() != null && !m.getPost().getId().equals(post.getId())) {
                    throw new IllegalArgumentException("Tệp đính kèm đã được liên kết với bài viết khác");
                }
            }

            List<Long> currentIds = currentMedia.stream().map(CommunityPostMedia::getId).toList();
            List<Long> newIds = newMedia.stream().map(CommunityPostMedia::getId).toList();
            mediaChanged = !currentIds.equals(newIds);

            Set<Long> keepIds = new HashSet<>(newIds);
            for (CommunityPostMedia m : currentMedia) {
                if (!keepIds.contains(m.getId())) {
                    mediaRepository.delete(m);
                }
            }
            int order = 0;
            for (CommunityPostMedia m : newMedia) {
                m.setPost(post);
                m.setDisplayOrder(order++);
                mediaRepository.save(m);
            }
            post.getMediaList().clear();
            post.getMediaList().addAll(newMedia);
        }

        // If published or rejected post is edited (text OR media attachments) -> return to PENDING for moderation
        if ((contentChanged || mediaChanged)
                && (post.getStatus() == PostStatus.PUBLISHED || post.getStatus() == PostStatus.REJECTED)) {
            post.setStatus(PostStatus.PENDING);
            post.setPublishedAt(null);
            log.info("Post {} edited (contentChanged={}, mediaChanged={}) by author {}, returned to PENDING for moderation",
                    postId, contentChanged, mediaChanged, userId);
        }

        post = postRepository.save(post);
        List<CommunityPostDto> dtos = mapPostsToDtos(Collections.singletonList(post), userId);
        return dtos.get(0);
    }

    @Transactional
    public void deletePost(Long userId, Long postId, boolean isAdmin) {
        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        if (!post.getAuthor().getId().equals(userId) && !isAdmin) {
            throw new org.springframework.security.access.AccessDeniedException("Bạn không có quyền xóa bài viết này");
        }

        post.setStatus(PostStatus.DELETED);
        postRepository.save(post);
        log.info("Post {} marked as DELETED by user {} (isAdmin={})", postId, userId, isAdmin);
    }

    @Transactional
    public CommunityPostDto toggleComments(Long userId, Long postId, boolean disabled) {
        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        if (!post.getAuthor().getId().equals(userId)) {
            throw new org.springframework.security.access.AccessDeniedException("Bạn không có quyền thay đổi cài đặt bình luận cho bài viết này");
        }

        post.setCommentsDisabledByOwner(disabled);
        post = postRepository.save(post);
        log.info("Post {} comments disabled by owner {} set to {}", postId, userId, disabled);
        List<CommunityPostDto> dtos = mapPostsToDtos(Collections.singletonList(post), userId);
        return dtos.get(0);
    }

    // =========================================================================
    // HELPER MAPPINGS (BATCHED & PERFORMANCE SAFE)
    // =========================================================================

    private List<CommunityPostDto> mapPostsToDtos(List<CommunityPost> posts, Long currentUserId) {
        if (posts.isEmpty()) {
            return Collections.emptyList();
        }

        List<Long> postIds = posts.stream().map(CommunityPost::getId).toList();

        // Batch load media
        List<CommunityPostMedia> allMedia = mediaRepository.findByPostIdInOrderByDisplayOrderAsc(postIds);
        Map<Long, List<CommunityPostMedia>> mediaMap = allMedia.stream()
                .collect(Collectors.groupingBy(m -> m.getPost().getId()));

        // Batch load user reactions
        Map<Long, ReactionType> reactionMap = new HashMap<>();
        if (currentUserId != null) {
            List<CommunityPostReaction> reactions = reactionRepository.findByPostIdInAndUserId(postIds, currentUserId);
            for (CommunityPostReaction r : reactions) {
                reactionMap.put(r.getPost().getId(), r.getReactionType().canonical());
            }
        }

        // Batch load top distinct reactions (up to 3 per post)
        Map<Long, List<ReactionType>> topReactionsMap = new HashMap<>();
        List<Object[]> topRows = reactionRepository.findTopReactionsByPostIds(postIds);
        for (Object[] row : topRows) {
            Long pId = (Long) row[0];
            ReactionType rt = ((ReactionType) row[1]).canonical();
            List<ReactionType> list = topReactionsMap.computeIfAbsent(pId, k -> new ArrayList<>());
            if (!list.contains(rt) && list.size() < 3) {
                list.add(rt);
            }
        }

        // Batch load saved status
        Set<Long> savedPostIds = new HashSet<>();
        if (currentUserId != null) {
            List<CommunitySavedPost> savedList = savedPostRepository.findByUserIdAndPostIdIn(currentUserId, postIds);
            for (CommunitySavedPost s : savedList) {
                savedPostIds.add(s.getPost().getId());
            }
        }

        // Batch load rejection reasons for rejected posts (eliminate N+1)
        List<Long> rejectedPostIds = posts.stream()
                .filter(p -> p.getStatus() == PostStatus.REJECTED)
                .map(CommunityPost::getId)
                .toList();
        Map<Long, String> rejectionReasons = new HashMap<>();
        if (!rejectedPostIds.isEmpty()) {
            List<CommunityModerationRecord> records = moderationRecordRepository.findByPostIdInOrderByCreatedAtDesc(rejectedPostIds);
            for (CommunityModerationRecord rec : records) {
                if (rec.getPost() != null && !rejectionReasons.containsKey(rec.getPost().getId())) {
                    rejectionReasons.put(rec.getPost().getId(), rec.getReason() != null ? rec.getReason() : rec.getNote());
                }
            }
        }

        // Batch enrich all non-OFFICIAL post authors in constant query count (eliminates 5N feed queries)
        Map<Long, User> authorsById = new LinkedHashMap<>();
        for (CommunityPost post : posts) {
            if (post.getAuthorType() != AuthorType.OFFICIAL && post.getAuthor() != null && post.getAuthor().getId() != null) {
                authorsById.putIfAbsent(post.getAuthor().getId(), post.getAuthor());
            }
        }
        Map<Long, AuthorSummaryDto> enrichedAuthors = authorsById.isEmpty()
                ? Map.of()
                : authorEnrichmentService.enrichAuthorsBatch(authorsById, currentUserId);

        // Map DTOs
        List<CommunityPostDto> result = new ArrayList<>(posts.size());
        for (CommunityPost post : posts) {
            AuthorSummaryDto authorDto;
            if (post.getAuthorType() == AuthorType.OFFICIAL) {
                authorDto = authorEnrichmentService.officialAuthorSummary();
            } else if (post.getAuthor() == null || post.getAuthor().getId() == null) {
                authorDto = authorEnrichmentService.fallbackAuthorSummary();
            } else {
                authorDto = enrichedAuthors.getOrDefault(post.getAuthor().getId(), authorEnrichmentService.fallbackAuthorSummary());
            }

            List<CommunityPostMediaDto> mediaDtos = mediaMap.getOrDefault(post.getId(), Collections.emptyList())
                    .stream()
                    .map(m -> CommunityPostMediaDto.builder()
                            .id(m.getId())
                            .url("/api/v1/community/media/" + m.getStorageKey())
                            .fileName(m.getFileName())
                            .fileSize(m.getFileSize())
                            .mimeType(m.getMimeType())
                            .type(m.getMimeType() != null && m.getMimeType().toLowerCase().startsWith("video/") ? "VIDEO" : "IMAGE")
                            .order(m.getDisplayOrder())
                            .width(m.getWidth())
                            .height(m.getHeight())
                            .build())
                    .toList();

            SharedLearningEmbedDto embed = learningValidationService.deserializeEmbed(post.getSharedEntityPayload());

            String moderationReason = rejectionReasons.get(post.getId());

            CommunityPostDto dto = CommunityPostDto.builder()
                    .id(post.getId())
                    .author(authorDto)
                    .status(post.getStatus())
                    .postType(post.getPostType())
                    .content(post.getContent())
                    .isPinned(post.isPinned())
                    .isFeatured(post.isFeatured())
                    .seriesType(post.getSeriesType())
                    .publishedAt(post.getPublishedAt())
                    .createdAt(post.getCreatedAt())
                    .likeCount(post.getLikeCount())
                    .commentCount(post.getCommentCount())
                    .saveCount(post.getSaveCount())
                    .myReaction(reactionMap.get(post.getId()))
                    .topReactions(topReactionsMap.getOrDefault(post.getId(), Collections.emptyList()))
                    .isSaved(savedPostIds.contains(post.getId()))
                    .commentsDisabled(post.isCommentsDisabled())
                    .commentsDisabledByOwner(post.isCommentsDisabledByOwner())
                    .commentsLockedByAdmin(post.isCommentsLockedByAdmin())
                    .media(mediaDtos)
                    .learningEmbed(embed)
                    .moderationReason(moderationReason)
                    .build();

            result.add(dto);
        }

        return result;
    }

    private CommunityPostDto mapSinglePostToDto(
            CommunityPost post,
            SharedLearningEmbedDto embed,
            ReactionType myReaction,
            boolean isSaved,
            AuthorSummaryDto authorDto
    ) {
        List<CommunityPostMediaDto> mediaDtos = post.getMediaList().stream()
                .map(m -> CommunityPostMediaDto.builder()
                        .id(m.getId())
                        .url("/api/v1/community/media/" + m.getStorageKey())
                        .fileName(m.getFileName())
                        .fileSize(m.getFileSize())
                        .mimeType(m.getMimeType())
                        .type(m.getMimeType() != null && m.getMimeType().toLowerCase().startsWith("video/") ? "VIDEO" : "IMAGE")
                        .order(m.getDisplayOrder())
                        .width(m.getWidth())
                        .height(m.getHeight())
                        .build())
                .toList();

        List<ReactionType> topReactions = new ArrayList<>();
        if (post.getId() != null) {
            List<Object[]> topRows = reactionRepository.findTopReactionsByPostId(post.getId());
            for (Object[] row : topRows) {
                ReactionType rt = ((ReactionType) row[0]).canonical();
                if (!topReactions.contains(rt) && topReactions.size() < 3) {
                    topReactions.add(rt);
                }
            }
        }

        return CommunityPostDto.builder()
                .id(post.getId())
                .author(authorDto)
                .status(post.getStatus())
                .postType(post.getPostType())
                .content(post.getContent())
                .isPinned(post.isPinned())
                .isFeatured(post.isFeatured())
                .seriesType(post.getSeriesType())
                .publishedAt(post.getPublishedAt())
                .createdAt(post.getCreatedAt())
                .likeCount(post.getLikeCount())
                .commentCount(post.getCommentCount())
                .saveCount(post.getSaveCount())
                .myReaction(myReaction != null ? myReaction.canonical() : null)
                .topReactions(topReactions)
                .isSaved(isSaved)
                .commentsDisabled(post.isCommentsDisabled())
                .commentsDisabledByOwner(post.isCommentsDisabledByOwner())
                .commentsLockedByAdmin(post.isCommentsLockedByAdmin())
                .media(mediaDtos)
                .learningEmbed(embed)
                .build();
    }

    private ReactionType currentReaction(Long postId, Long userId) {
        if (postId == null || userId == null) return null;
        return reactionRepository.findByPostIdAndUserId(postId, userId)
                .map(CommunityPostReaction::getReactionType)
                .orElse(null);
    }

    private <T> CommunityFeedPageDto<T> toFeedPage(Page<?> page, List<T> items) {
        return CommunityFeedPageDto.<T>builder()
                .items(items)
                .page(page.getNumber())
                .size(page.getSize())
                .totalElements(page.getTotalElements())
                .totalPages(page.getTotalPages())
                .hasMore(page.hasNext())
                .build();
    }
}
