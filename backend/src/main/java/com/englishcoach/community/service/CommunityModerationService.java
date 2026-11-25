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

import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Slf4j
public class CommunityModerationService {

    private final CommunityPostRepository postRepository;
    private final CommunityPostMediaRepository mediaRepository;
    private final CommunityReportRepository reportRepository;
    private final CommunityModerationRecordRepository moderationRecordRepository;
    private final UserRepository userRepository;
    private final CommunityAuthorEnrichmentService authorEnrichmentService;
    private final CommunityLearningValidationService learningValidationService;
    private final NotificationService notificationService;

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getPendingQueue(int page, int size) {
        Page<CommunityPost> postPage = postRepository.findByStatusWithAuthor(PostStatus.PENDING, PageRequest.of(page, size));
        return toAdminFeedPage(postPage);
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getApprovedQueue(int page, int size) {
        Page<CommunityPost> postPage = postRepository.findByStatusWithAuthor(PostStatus.PUBLISHED, PageRequest.of(page, size));
        return toAdminFeedPage(postPage);
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getRejectedQueue(int page, int size) {
        Page<CommunityPost> postPage = postRepository.findByStatusWithAuthor(PostStatus.REJECTED, PageRequest.of(page, size));
        return toAdminFeedPage(postPage);
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getHiddenQueue(int page, int size) {
        Page<CommunityPost> postPage = postRepository.findByStatusWithAuthor(PostStatus.HIDDEN, PageRequest.of(page, size));
        return toAdminFeedPage(postPage);
    }

    @Transactional(readOnly = true)
    public CommunityFeedPageDto<CommunityPostDto> getReportedQueue(int page, int size) {
        Page<CommunityPost> postPage = postRepository.findReportedPosts(PageRequest.of(page, size));
        return toAdminFeedPage(postPage);
    }

    @Transactional(readOnly = true)
    public List<ReportItemDto> getReports(ReportStatus status, int page, int size) {
        ReportStatus filterStatus = status != null ? status : ReportStatus.PENDING;
        Page<CommunityReport> reports = reportRepository.findByStatusOrderByCreatedAtDesc(filterStatus, PageRequest.of(page, size));
        return reports.getContent().stream()
                .map(r -> ReportItemDto.builder()
                        .id(r.getId())
                        .postId(r.getPost().getId())
                        .reporterId(r.getReporter().getId())
                        .reason(r.getReason())
                        .details(r.getDetails())
                        .status(r.getStatus())
                        .createdAt(r.getCreatedAt())
                        .build())
                .collect(Collectors.toList());
    }

    @Transactional
    public CommunityPostDto moderatePost(Long adminId, Long postId, ModeratePostRequest request) {
        User admin = userRepository.findById(adminId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy quản trị viên"));

        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        PostStatus oldStatus = post.getStatus();
        PostStatus newStatus;

        switch (request.getAction()) {
            case APPROVE:
                newStatus = PostStatus.PUBLISHED;
                post.setPublishedAt(Instant.now());
                break;
            case REJECT:
                newStatus = PostStatus.REJECTED;
                break;
            case HIDE:
                newStatus = PostStatus.HIDDEN;
                break;
            case DELETE:
                newStatus = PostStatus.DELETED;
                break;
            case RESTORE:
                newStatus = PostStatus.PUBLISHED;
                if (post.getPublishedAt() == null) {
                    post.setPublishedAt(Instant.now());
                }
                break;
            default:
                throw new IllegalArgumentException("Hành động duyệt không hợp lệ");
        }

        post.setStatus(newStatus);
        post.setUpdatedByAdminId(adminId);
        post = postRepository.save(post);

        // Record moderation audit
        CommunityModerationRecord record = CommunityModerationRecord.builder()
                .post(post)
                .admin(admin)
                .previousStatus(oldStatus.name())
                .newStatus(newStatus.name())
                .action(request.getAction())
                .reason(request.getReason())
                .note(request.getNote())
                .build();
        moderationRecordRepository.save(record);

        // Notify author
        if (request.getAction() == ModerationAction.APPROVE) {
            try {
                notificationService.create(new CreateNotificationCommand(
                        post.getAuthor().getId(),
                        NotificationCategory.COMMUNITY,
                        NotificationType.COMMUNITY_POST_APPROVED,
                        "Bài viết của bạn đã được duyệt!",
                        "Bài viết của bạn đã được quản trị viên duyệt và hiển thị trên bảng tin Cộng đồng.",
                        "/community?postId=" + post.getId(),
                        "mod_approve_" + post.getId()
                ));
            } catch (Exception e) {
                log.warn("Could not dispatch approval notification: {}", e.getMessage());
            }
        } else if (request.getAction() == ModerationAction.REJECT) {
            try {
                String reasonDetail = (request.getReason() != null ? request.getReason() : "Nội dung chưa phù hợp tiêu chuẩn cộng đồng");
                if (request.getNote() != null && !request.getNote().isBlank()) {
                    reasonDetail += " (" + request.getNote().trim() + ")";
                }
                notificationService.create(new CreateNotificationCommand(
                        post.getAuthor().getId(),
                        NotificationCategory.COMMUNITY,
                        NotificationType.COMMUNITY_POST_REJECTED,
                        "Bài viết chưa được duyệt",
                        "Lý do: " + reasonDetail,
                        "/community?tab=my_posts",
                        "mod_reject_" + post.getId()
                ));
            } catch (Exception e) {
                log.warn("Could not dispatch rejection notification: {}", e.getMessage());
            }
        }

        log.info("Post {} moderated by admin {}: {} -> {}", postId, adminId, oldStatus, newStatus);

        List<CommunityPostDto> dtos = mapAdminPostsToDtos(Collections.singletonList(post));
        return dtos.get(0);
    }

    @Transactional(readOnly = true)
    public List<CommunityModerationRecordDto> getModerationHistory(Long postId) {
        return moderationRecordRepository.findByPostIdOrderByCreatedAtDesc(postId).stream()
                .map(CommunityModerationRecordDto::fromEntity)
                .toList();
    }

    @Transactional
    public void resolveReport(Long adminId, Long reportId, ReportStatus resolution) {
        CommunityReport report = reportRepository.findById(reportId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy báo cáo"));

        report.setStatus(resolution);
        report.setResolvedByAdminId(adminId);
        report.setResolvedAt(Instant.now());
        reportRepository.save(report);
        log.info("Report {} resolved by admin {} as {}", reportId, adminId, resolution);
    }

    @Transactional
    public CommunityPostDto toggleCommentLock(Long adminId, Long postId, boolean locked, String reason) {
        User admin = userRepository.findById(adminId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy quản trị viên"));

        CommunityPost post = postRepository.findById(postId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bài viết"));

        post.setCommentsLockedByAdmin(locked);
        post.setUpdatedByAdminId(adminId);
        post = postRepository.save(post);

        CommunityModerationRecord record = CommunityModerationRecord.builder()
                .post(post)
                .admin(admin)
                .previousStatus(post.getStatus().name())
                .newStatus(post.getStatus().name())
                .action(locked ? ModerationAction.LOCK_COMMENTS : ModerationAction.UNLOCK_COMMENTS)
                .reason(reason != null && !reason.isBlank() ? reason : (locked ? "Khóa bình luận bởi quản trị viên" : "Mở khóa bình luận bởi quản trị viên"))
                .build();
        moderationRecordRepository.save(record);

        log.info("Post {} comments lock set to {} by admin {}", postId, locked, adminId);
        List<CommunityPostDto> dtos = mapAdminPostsToDtos(Collections.singletonList(post));
        return dtos.get(0);
    }

    // =========================================================================
    // ADMIN MAPPINGS
    // =========================================================================

    private CommunityFeedPageDto<CommunityPostDto> toAdminFeedPage(Page<CommunityPost> postPage) {
        List<CommunityPostDto> dtos = mapAdminPostsToDtos(postPage.getContent());
        return CommunityFeedPageDto.<CommunityPostDto>builder()
                .items(dtos)
                .page(postPage.getNumber())
                .size(postPage.getSize())
                .totalElements(postPage.getTotalElements())
                .totalPages(postPage.getTotalPages())
                .hasMore(postPage.hasNext())
                .build();
    }

    private List<CommunityPostDto> mapAdminPostsToDtos(List<CommunityPost> posts) {
        if (posts.isEmpty()) {
            return Collections.emptyList();
        }

        List<Long> postIds = posts.stream().map(CommunityPost::getId).toList();

        List<CommunityPostMedia> allMedia = mediaRepository.findByPostIdInOrderByDisplayOrderAsc(postIds);
        Map<Long, List<CommunityPostMedia>> mediaMap = allMedia.stream()
                .collect(Collectors.groupingBy(m -> m.getPost().getId()));

        List<Object[]> reportCountRows = reportRepository.countPendingReportsPerPost();
        Map<Long, Long> pendingReportsMap = new HashMap<>();
        for (Object[] row : reportCountRows) {
            pendingReportsMap.put((Long) row[0], (Long) row[1]);
        }

        List<CommunityModerationRecord> allRecords = moderationRecordRepository.findByPostIdInOrderByCreatedAtDesc(postIds);
        Map<Long, String> moderationReasonMap = new HashMap<>();
        for (CommunityModerationRecord rec : allRecords) {
            if (rec.getPost() != null && !moderationReasonMap.containsKey(rec.getPost().getId())) {
                moderationReasonMap.put(rec.getPost().getId(), rec.getReason() != null ? rec.getReason() : rec.getNote());
            }
        }

        List<CommunityPostDto> result = new ArrayList<>();
        for (CommunityPost post : posts) {
            AuthorSummaryDto authorDto = authorEnrichmentService.enrichAuthor(
                    post.getAuthor(),
                    post.getAuthorType(),
                    null
            );

            List<CommunityPostMediaDto> mediaDtos = mediaMap.getOrDefault(post.getId(), Collections.emptyList())
                    .stream()
                    .map(m -> CommunityPostMediaDto.builder()
                            .id(m.getId())
                            .url("/api/v1/community/media/" + m.getStorageKey())
                            .fileName(m.getFileName())
                            .fileSize(m.getFileSize())
                            .mimeType(m.getMimeType())
                            .width(m.getWidth())
                            .height(m.getHeight())
                            .build())
                    .toList();

            SharedLearningEmbedDto embed = learningValidationService.deserializeEmbed(post.getSharedEntityPayload());

            String moderationReason = moderationReasonMap.get(post.getId());

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
                    .myReaction(null)
                    .isSaved(false)
                    .commentsDisabled(post.isCommentsDisabled())
                    .commentsDisabledByOwner(post.isCommentsDisabledByOwner())
                    .commentsLockedByAdmin(post.isCommentsLockedByAdmin())
                    .media(mediaDtos)
                    .learningEmbed(embed)
                    .moderationReason(moderationReason)
                    .reportCount(pendingReportsMap.getOrDefault(post.getId(), 0L))
                    .build();

            result.add(dto);
        }

        return result;
    }
}
