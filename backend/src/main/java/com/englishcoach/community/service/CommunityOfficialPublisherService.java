package com.englishcoach.community.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.community.dto.CommunityPostDto;
import com.englishcoach.community.dto.OfficialPublishRequest;
import com.englishcoach.community.dto.SharedLearningEmbedDto;
import com.englishcoach.community.entity.AuthorType;
import com.englishcoach.community.entity.CommunityPost;
import com.englishcoach.community.entity.CommunityPostMedia;
import com.englishcoach.community.entity.PostStatus;
import com.englishcoach.community.repository.CommunityPostMediaRepository;
import com.englishcoach.community.repository.CommunityPostRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.NoSuchElementException;

@Service
@RequiredArgsConstructor
@Slf4j
public class CommunityOfficialPublisherService {

    private final CommunityPostRepository postRepository;
    private final CommunityPostMediaRepository mediaRepository;
    private final UserRepository userRepository;
    private final CommunityLearningValidationService learningValidationService;
    private final CommunityPostService postService;

    @Transactional
    public CommunityPostDto publishOfficialPost(Long adminId, OfficialPublishRequest request) {
        User admin = userRepository.findById(adminId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy quản trị viên"));

        // Validate shared learning embed
        SharedLearningEmbedDto embed = null;
        String serializedEmbed = null;
        if (request.getSharedEntityType() != null && request.getSharedEntityId() != null) {
            embed = learningValidationService.validateAndBuildEmbed(
                    request.getSharedEntityType(),
                    request.getSharedEntityId(),
                    adminId,
                    true // Admin can share any system content
            );
            serializedEmbed = learningValidationService.serializeEmbed(embed);
        }

        Instant now = Instant.now();
        PostStatus status = PostStatus.PUBLISHED;
        Instant publishedAt = now;
        Instant scheduledFor = null;

        if (request.getScheduledFor() != null && request.getScheduledFor().isAfter(now)) {
            status = PostStatus.SCHEDULED;
            publishedAt = null;
            scheduledFor = request.getScheduledFor();
        }

        CommunityPost post = CommunityPost.builder()
                .author(admin)
                .authorType(AuthorType.OFFICIAL) // Verified official identity
                .createdByAdminId(adminId)
                .updatedByAdminId(adminId)
                .status(status)
                .postType(request.getPostType())
                .content(request.getContent().trim())
                .isPinned(request.isPinned())
                .isFeatured(request.isFeatured())
                .seriesType(request.getSeriesType())
                .scheduledFor(scheduledFor)
                .publishedAt(publishedAt)
                .likeCount(0)
                .commentCount(0)
                .saveCount(0)
                .sharedEntityType(request.getSharedEntityType())
                .sharedEntityId(request.getSharedEntityId())
                .sharedEntityPayload(serializedEmbed)
                .build();

        post = postRepository.save(post);

        List<CommunityPostMedia> mediaList = new java.util.ArrayList<>();
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
                java.util.Map<String, CommunityPostMedia> keyMap = fromUrls.stream()
                        .collect(java.util.stream.Collectors.toMap(CommunityPostMedia::getStorageKey, m -> m, (a, b) -> a));
                for (String key : storageKeys) {
                    CommunityPostMedia m = keyMap.get(key);
                    if (m != null && mediaList.stream().noneMatch(existing -> existing.getId().equals(m.getId()))) {
                        mediaList.add(m);
                    }
                }
            }
        }
        long videoCount = mediaList.stream()
                .filter(m -> m.getMimeType() != null && m.getMimeType().toLowerCase().startsWith("video/"))
                .count();
        long imageCount = mediaList.size() - videoCount;

        if (imageCount > 10) {
            throw new IllegalArgumentException("Mỗi bài viết chỉ được đính kèm tối đa 10 ảnh");
        }
        if (videoCount > 2) {
            throw new IllegalArgumentException("Mỗi bài viết chỉ được đính kèm tối đa 2 video");
        }

        post.getMediaList().clear();
        int order = 0;
        for (CommunityPostMedia m : mediaList) {
            m.setPost(post);
            m.setDisplayOrder(order++);
            mediaRepository.save(m);
            post.getMediaList().add(m);
        }

        log.info("Official EnglishCoach post created by admin {} with status {}", adminId, status);
        return postService.getPostById(adminId, post.getId(), true);
    }

    @Transactional
    public void togglePin(Long adminId, Long postId, boolean isPinned) {
        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        post.setPinned(isPinned);
        post.setUpdatedByAdminId(adminId);
        postRepository.save(post);
        log.info("Post {} pinned status set to {} by admin {}", postId, isPinned, adminId);
    }

    @Transactional
    public void toggleFeatured(Long adminId, Long postId, boolean isFeatured) {
        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        post.setFeatured(isFeatured);
        post.setUpdatedByAdminId(adminId);
        postRepository.save(post);
        log.info("Post {} featured status set to {} by admin {}", postId, isFeatured, adminId);
    }
}
