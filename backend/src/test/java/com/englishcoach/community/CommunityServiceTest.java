package com.englishcoach.community;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.avatarframe.service.AvatarFrameService;
import com.englishcoach.community.dto.*;
import com.englishcoach.community.entity.*;
import com.englishcoach.community.repository.*;
import com.englishcoach.community.service.*;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import com.englishcoach.dictionary.repository.DictionaryRepository;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.proficiency.ProficiencyLevelQueryService;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.service.UnifiedProgressService;
import com.englishcoach.user.repository.UserProfileRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;

import java.time.Instant;
import java.time.LocalDate;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class CommunityServiceTest {

    @Mock private CommunityPostRepository postRepository;
    @Mock private CommunityPostMediaRepository mediaRepository;
    @Mock private CommunityPostReactionRepository reactionRepository;
    @Mock private CommunityCommentRepository commentRepository;
    @Mock private CommunityCommentReactionRepository commentReactionRepository;
    @Mock private com.englishcoach.community.repository.CommunityCommentMediaRepository commentMediaRepository;
    @Mock private CommunityFollowRepository followRepository;
    @Mock private CommunitySavedPostRepository savedPostRepository;
    @Mock private CommunityReportRepository reportRepository;
    @Mock private CommunityModerationRecordRepository moderationRecordRepository;
    @Mock private UserRepository userRepository;
    @Mock private UserProfileRepository userProfileRepository;
    @Mock private AvatarFrameService avatarFrameService;
    @Mock private PremiumEntitlementService premiumEntitlementService;
    @Mock private UnifiedProgressService unifiedProgressService;
    @Mock private ProficiencyLevelQueryService proficiencyLevelQueryService;
    @Mock private ListeningMaterialRepository listeningMaterialRepository;
    @Mock private NotificationService notificationService;
    @Mock private DictionaryRepository dictionaryRepository;
    @Mock private CommunityUserRestrictionRepository restrictionRepository;

    private CommunityAuthorEnrichmentService authorEnrichmentService;
    private CommunityLearningValidationService learningValidationService;
    private CommunityRestrictionService restrictionService;
    private CommunityPostService postService;
    private CommunityInteractionService interactionService;
    private CommunityCommentService commentService;
    private CommunityModerationService moderationService;
    private CommunityOfficialPublisherService officialPublisherService;
    private CommunityDailyVocabularyService dailyVocabularyService;

    private User regularUser;
    private User adminUser;

    @BeforeEach
    void setUp() {
        ObjectMapper objectMapper = new ObjectMapper();
        authorEnrichmentService = new CommunityAuthorEnrichmentService(
                userProfileRepository,
                avatarFrameService,
                premiumEntitlementService,
                unifiedProgressService,
                proficiencyLevelQueryService,
                followRepository
        );

        learningValidationService = new CommunityLearningValidationService(
                listeningMaterialRepository,
                null,
                null,
                objectMapper
        );

        restrictionService = new CommunityRestrictionService(
                restrictionRepository,
                userRepository
        );

        postService = new CommunityPostService(
                postRepository,
                mediaRepository,
                reactionRepository,
                savedPostRepository,
                moderationRecordRepository,
                userRepository,
                authorEnrichmentService,
                learningValidationService,
                restrictionService
        );

        interactionService = new CommunityInteractionService(
                postRepository,
                reactionRepository,
                savedPostRepository,
                followRepository,
                reportRepository,
                commentRepository,
                userRepository,
                notificationService,
                authorEnrichmentService,
                restrictionService
        );

        commentService = new CommunityCommentService(
                commentRepository,
                commentReactionRepository,
                commentMediaRepository,
                postRepository,
                userRepository,
                authorEnrichmentService,
                notificationService,
                restrictionService
        );
        commentService.setPostMediaRepository(mediaRepository);

        moderationService = new CommunityModerationService(
                postRepository,
                mediaRepository,
                reportRepository,
                moderationRecordRepository,
                userRepository,
                authorEnrichmentService,
                learningValidationService,
                notificationService
        );

        officialPublisherService = new CommunityOfficialPublisherService(
                postRepository,
                mediaRepository,
                userRepository,
                learningValidationService,
                postService
        );

        dailyVocabularyService = new CommunityDailyVocabularyService(
                postRepository,
                dictionaryRepository,
                userRepository
        );

        regularUser = User.builder()
                .id(100L)
                .name("Nguyen Van A")
                .email("user@test.com")
                .role(Role.ROLE_USER)
                .build();

        adminUser = User.builder()
                .id(1L)
                .name("Admin System")
                .email("admin@englishcoach.io.vn")
                .role(Role.ROLE_ADMIN)
                .build();
    }

    @Test
    @DisplayName("User post starts as PENDING and has AuthorType.USER")
    void testUserPostStartsPending() {
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));
        when(postRepository.save(any(CommunityPost.class))).thenAnswer(inv -> {
            CommunityPost p = inv.getArgument(0);
            p.setId(500L);
            p.setCreatedAt(Instant.now());
            return p;
        });

        CreatePostRequest request = CreatePostRequest.builder()
                .content("Hôm nay mình vừa học xong Unit 5.")
                .postType(PostType.OFFICIAL) // Attemp to forge official type
                .build();

        CommunityPostDto result = postService.createPost(100L, request);

        assertThat(result.getStatus()).isEqualTo(PostStatus.PENDING);
        // Regular user CANNOT forge OFFICIAL postType
        assertThat(result.getPostType()).isNotEqualTo(PostType.OFFICIAL);
        assertThat(result.getAuthor().getAuthorType()).isEqualTo(AuthorType.USER);
    }

    @Test
    @DisplayName("Editing a post cannot attach another learner's staged or published media (security closure, cross-user case)")
    void testEditCannotStealAnotherLearnersMedia() {
        User victim = User.builder().id(200L).name("B").email("b@test.com").role(Role.ROLE_USER).build();
        CommunityPost victimPost = CommunityPost.builder().id(900L).author(victim).authorType(AuthorType.USER)
                .status(PostStatus.PUBLISHED).content("B's post").build();
        CommunityPost attackerPost = CommunityPost.builder().id(901L).author(regularUser).authorType(AuthorType.USER)
                .status(PostStatus.PENDING).content("A's post").build();
        CommunityPostMedia victimStaged = CommunityPostMedia.builder().id(70L).userId(200L).storageKey("k1.png")
                .mimeType("image/png").build();
        CommunityPostMedia victimPublished = CommunityPostMedia.builder().id(71L).userId(200L).storageKey("k2.png")
                .mimeType("image/png").post(victimPost).build();
        when(postRepository.findById(901L)).thenReturn(Optional.of(attackerPost));

        for (CommunityPostMedia target : List.of(victimStaged, victimPublished)) {
            when(mediaRepository.findAllById(List.of(target.getId()))).thenReturn(List.of(target));
            UpdatePostRequest edit = UpdatePostRequest.builder().content("A's post").mediaIds(List.of(target.getId())).build();
            assertThatThrownBy(() -> postService.updatePost(100L, 901L, edit))
                    .isInstanceOf(org.springframework.security.access.AccessDeniedException.class);
        }
        // nothing was re-bound or deleted
        assertThat(victimStaged.getPost()).isNull();
        assertThat(victimPublished.getPost()).isSameAs(victimPost);
        verify(mediaRepository, never()).save(any(CommunityPostMedia.class));
        verify(mediaRepository, never()).delete(any(CommunityPostMedia.class));

        // the same refusal on creation, also for a media row without an owner
        CommunityPostMedia ownerless = CommunityPostMedia.builder().id(72L).storageKey("k3.png").mimeType("image/png").build();
        when(mediaRepository.findAllById(List.of(72L))).thenReturn(List.of(ownerless));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));
        when(postRepository.save(any(CommunityPost.class))).thenAnswer(inv -> { CommunityPost p = inv.getArgument(0); p.setId(902L); p.setCreatedAt(Instant.now()); return p; });
        CreatePostRequest create = CreatePostRequest.builder().content("new").mediaIds(List.of(72L)).build();
        assertThatThrownBy(() -> postService.createPost(100L, create))
                .isInstanceOf(org.springframework.security.access.AccessDeniedException.class);
        assertThat(ownerless.getPost()).isNull();
    }

    @Test
    @DisplayName("Admin can approve pending post, transitioning it to PUBLISHED")
    void testAdminApprovePost() {
        CommunityPost post = CommunityPost.builder()
                .id(501L)
                .author(regularUser)
                .authorType(AuthorType.USER)
                .status(PostStatus.PENDING)
                .content("Cần tìm bạn luyện nói cùng!")
                .build();

        when(userRepository.findById(1L)).thenReturn(Optional.of(adminUser));
        when(postRepository.findById(501L)).thenReturn(Optional.of(post));
        when(postRepository.save(any(CommunityPost.class))).thenAnswer(inv -> inv.getArgument(0));

        ModeratePostRequest request = ModeratePostRequest.builder()
                .action(ModerationAction.APPROVE)
                .build();

        CommunityPostDto result = moderationService.moderatePost(1L, 501L, request);

        assertThat(result.getStatus()).isEqualTo(PostStatus.PUBLISHED);
        assertThat(post.getPublishedAt()).isNotNull();
        verify(moderationRecordRepository).save(any(CommunityModerationRecord.class));
        verify(notificationService).create(any());
    }

    @Test
    @DisplayName("Admin can reject pending post with reason and notification")
    void testAdminRejectPost() {
        CommunityPost post = CommunityPost.builder()
                .id(502L)
                .author(regularUser)
                .authorType(AuthorType.USER)
                .status(PostStatus.PENDING)
                .content("Spam quảng cáo website lạ")
                .build();

        when(userRepository.findById(1L)).thenReturn(Optional.of(adminUser));
        when(postRepository.findById(502L)).thenReturn(Optional.of(post));
        when(postRepository.save(any(CommunityPost.class))).thenAnswer(inv -> inv.getArgument(0));

        ModeratePostRequest request = ModeratePostRequest.builder()
                .action(ModerationAction.REJECT)
                .reason("Spam")
                .note("Quảng cáo không được phép")
                .build();

        CommunityPostDto result = moderationService.moderatePost(1L, 502L, request);

        assertThat(result.getStatus()).isEqualTo(PostStatus.REJECTED);
        verify(moderationRecordRepository).save(any(CommunityModerationRecord.class));
        verify(notificationService).create(any());
    }

    @Test
    @DisplayName("Official publisher creates post with EnglishCoach public identity and internal admin audit")
    void testOfficialPublisherIdentity() {
        when(userRepository.findById(1L)).thenReturn(Optional.of(adminUser));
        when(postRepository.save(any(CommunityPost.class))).thenAnswer(inv -> {
            CommunityPost p = inv.getArgument(0);
            p.setId(600L);
            p.setCreatedAt(Instant.now());
            return p;
        });
        when(postRepository.findById(600L)).thenAnswer(inv -> {
            CommunityPost p = CommunityPost.builder()
                    .id(600L)
                    .author(adminUser)
                    .authorType(AuthorType.OFFICIAL)
                    .createdByAdminId(1L)
                    .status(PostStatus.PUBLISHED)
                    .content("Thông báo từ EnglishCoach")
                    .publishedAt(Instant.now())
                    .build();
            return Optional.of(p);
        });

        OfficialPublishRequest request = OfficialPublishRequest.builder()
                .content("Thông báo từ EnglishCoach")
                .postType(PostType.OFFICIAL)
                .isPinned(true)
                .build();

        CommunityPostDto result = officialPublisherService.publishOfficialPost(1L, request);

        assertThat(result.getAuthor().getName()).isEqualTo("EnglishCoach");
        assertThat(result.getAuthor().isOfficial()).isTrue();
        assertThat(result.getAuthor().getAvatarUrl()).isEqualTo("/assets/Whale.svg");
    }

    @Test
    @DisplayName("Reactions toggle atomically and refresh counters")
    void testReactionToggle() {
        CommunityPost post = CommunityPost.builder()
                .id(700L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .likeCount(0)
                .build();

        when(postRepository.findById(700L)).thenReturn(Optional.of(post));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));
        when(reactionRepository.findByPostIdAndUserId(700L, 100L)).thenReturn(Optional.empty());
        when(reactionRepository.countByPostId(700L)).thenReturn(1L);

        ReactionResponse resp = interactionService.toggleReaction(100L, 700L, ReactionType.FIRE);

        assertThat(resp.getMyReaction()).isEqualTo(ReactionType.FIRE);
        assertThat(resp.getLikeCount()).isEqualTo(1);
        verify(postRepository).refreshLikeCount(700L);
    }

    @Test
    @DisplayName("Follow graph prevents self-follow and rejects duplicate follow gracefully")
    void testFollowGraph() {
        assertThatThrownBy(() -> interactionService.followUser(100L, 100L))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("chính mình");

        when(followRepository.existsByFollowerIdAndFollowingId(100L, 1L)).thenReturn(false);
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));
        when(userRepository.findById(1L)).thenReturn(Optional.of(adminUser));

        boolean followed = interactionService.followUser(100L, 1L);
        assertThat(followed).isTrue();
        verify(followRepository).save(any(CommunityFollow.class));
    }

    @Test
    @DisplayName("User can report a post to enter admin moderation queue")
    void testReportPost() {
        CommunityPost post = CommunityPost.builder()
                .id(800L)
                .author(adminUser)
                .status(PostStatus.PUBLISHED)
                .build();

        when(postRepository.findById(800L)).thenReturn(Optional.of(post));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));

        ReportRequest req = ReportRequest.builder()
                .reason(ReportReason.INAPPROPRIATE)
                .details("Nội dung không phù hợp chuẩn mực")
                .build();

        interactionService.reportPost(100L, 800L, req);

        verify(reportRepository).save(argThat(r ->
                r.getReason() == ReportReason.INAPPROPRIATE &&
                r.getStatus() == ReportStatus.PENDING &&
                r.getReporter().getId().equals(100L)
        ));
    }

    @Test
    @DisplayName("Daily vocabulary generation is idempotent, restart-safe and deterministic")
    void testDailyVocabularyIdempotency() {
        LocalDate date = LocalDate.of(2026, 10, 1);
        CommunityPost existing = CommunityPost.builder()
                .id(900L)
                .seriesType(CommunityDailyVocabularyService.SERIES_TYPE)
                .scheduledDate(date)
                .status(PostStatus.PUBLISHED)
                .build();

        when(postRepository.findBySeriesTypeAndScheduledDate(CommunityDailyVocabularyService.SERIES_TYPE, date))
                .thenReturn(Optional.of(existing));

        // When already generated, must NOT query dictionary or insert duplicate
        CommunityPost result = dailyVocabularyService.ensureDailyVocabularyPost(date);

        assertThat(result.getId()).isEqualTo(900L);
        verify(dictionaryRepository, never()).countByGeneralTranslationViIsNotNull();
        verify(postRepository, never()).save(any());
    }

    @Test
    @DisplayName("Sharing private listening material of another user is rejected")
    void testPrivateLearningContentSharingRejected() {
        ListeningMaterial privateMat = ListeningMaterial.builder()
                .id(99L)
                .ownerUserId(200L) // Belongs to user 200
                .isSystem(false)
                .title("Private Audio")
                .build();

        when(listeningMaterialRepository.findById(99L)).thenReturn(Optional.of(privateMat));

        // User 100 tries to share user 200's private material
        assertThatThrownBy(() -> learningValidationService.validateAndBuildEmbed(
                SharedEntityType.LISTENING_MATERIAL,
                "99",
                100L,
                false
        )).isInstanceOf(IllegalArgumentException.class)
          .hasMessageContaining("Bạn không có quyền");
    }

    @Test
    @DisplayName("User can report a comment, linking to the parent post with snippet")
    void testReportComment() {
        CommunityPost post = CommunityPost.builder()
                .id(600L)
                .author(adminUser)
                .status(PostStatus.PUBLISHED)
                .build();

        CommunityComment comment = CommunityComment.builder()
                .id(750L)
                .post(post)
                .user(adminUser)
                .content("Bình luận vi phạm tiêu chuẩn")
                .status("PUBLISHED")
                .build();

        when(commentRepository.findById(750L)).thenReturn(Optional.of(comment));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));

        ReportRequest req = ReportRequest.builder()
                .reason(ReportReason.HARASSMENT)
                .details("Bình luận công kích cá nhân")
                .build();

        interactionService.reportComment(100L, 750L, req);

        verify(reportRepository).save(argThat(r ->
                r.getReason() == ReportReason.HARASSMENT &&
                r.getStatus() == ReportStatus.PENDING &&
                r.getPost().getId().equals(600L) &&
                r.getReporter().getId().equals(100L) &&
                r.getDetails().contains("Báo cáo bình luận #750")
        ));
    }

    @Test
    @DisplayName("Admin soft-deletes a post, setting status to DELETED and saving audit record")
    void testAdminSoftDeletePost() {
        CommunityPost post = CommunityPost.builder()
                .id(503L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .content("Nội dung cần xóa")
                .build();

        when(userRepository.findById(1L)).thenReturn(Optional.of(adminUser));
        when(postRepository.findById(503L)).thenReturn(Optional.of(post));
        when(postRepository.save(any(CommunityPost.class))).thenAnswer(inv -> inv.getArgument(0));

        ModeratePostRequest request = ModeratePostRequest.builder()
                .action(ModerationAction.DELETE)
                .reason("Vi phạm nghiêm trọng")
                .note("Xóa mềm bảo lưu bằng chứng kiểm duyệt")
                .build();

        CommunityPostDto result = moderationService.moderatePost(1L, 503L, request);

        assertThat(result.getStatus()).isEqualTo(PostStatus.DELETED);
        verify(moderationRecordRepository).save(argThat(rec ->
                rec.getAction() == ModerationAction.DELETE &&
                rec.getNewStatus().equals("DELETED") &&
                rec.getPost().getId().equals(503L) &&
                rec.getAdmin().getId().equals(1L)
        ));
    }

    @Test
    @DisplayName("Author and admin can delete comments; other users are rejected")
    void testCommentDeletePermissions() {
        CommunityPost post = CommunityPost.builder()
                .id(600L)
                .status(PostStatus.PUBLISHED)
                .build();

        CommunityComment comment = CommunityComment.builder()
                .id(751L)
                .post(post)
                .user(regularUser) // Owner is user 100
                .content("Bình luận của user")
                .status("PUBLISHED")
                .build();

        when(commentRepository.findById(751L)).thenReturn(Optional.of(comment));

        // Non-owner, non-admin (user 200) tries to delete -> forbidden
        assertThatThrownBy(() -> commentService.deleteComment(200L, 751L, false))
                .isInstanceOf(org.springframework.security.access.AccessDeniedException.class);

        // Owner (user 100) deletes own comment -> status set to DELETED
        commentService.deleteComment(100L, 751L, false);
        assertThat(comment.getStatus()).isEqualTo("DELETED");

        // Admin (user 1) deletes comment -> status set to DELETED
        comment.setStatus("PUBLISHED");
        commentService.deleteComment(1L, 751L, true);
        assertThat(comment.getStatus()).isEqualTo("DELETED");
    }

    @Test
    @DisplayName("AuthorSummaryDto and CommunityPostDto aliases provide frontend parity")
    void testAuthorSummaryAndPostDtoAliases() {
        AuthorSummaryDto author = AuthorSummaryDto.builder()
                .id(100L)
                .name("Nguyễn Văn A")
                .authorType(AuthorType.USER)
                .avatarUrl("/avatar.png")
                .frame(new com.englishcoach.avatarframe.dto.AvatarFrameDto(
                        10L, "cyberpunk_neon", null, "Cyberpunk Neon", "RARE", null, "CSS", null, null, null, null, null
                ))
                .isOfficial(false)
                .isPremium(true)
                .isFollowing(true)
                .streakDays(15)
                .cefrLevel("B2")
                .build();

        assertThat(author.getUserId()).isEqualTo(100L);
        assertThat(author.getDisplayName()).isEqualTo("Nguyễn Văn A");
        assertThat(author.getEquippedFrameId()).isEqualTo("cyberpunk_neon");
        assertThat(author.getOfficial()).isFalse();
        assertThat(author.getPremium()).isTrue();
        assertThat(author.getFollowedByMe()).isTrue();

        CommunityPostDto post = CommunityPostDto.builder()
                .id(999L)
                .author(author)
                .status(PostStatus.PUBLISHED)
                .postType(PostType.GENERAL)
                .content("Test content")
                .isPinned(true)
                .isFeatured(true)
                .isSaved(true)
                .likeCount(42)
                .commentCount(5)
                .build();

        assertThat(post.isSavedByMe()).isTrue();
        assertThat(post.isPinnedAlias()).isTrue();
        assertThat(post.isFeaturedAlias()).isTrue();
        assertThat(post.getReactionCountAlias()).isEqualTo(42);
    }

    @Test
    @DisplayName("Video upload validates magic bytes and uploader identity")
    void testVideoUploadValidation() {
        CommunityMediaStorageService storageService = new CommunityMediaStorageService(
                System.getProperty("java.io.tmpdir") + "/community_test_media",
                mediaRepository
        );

        byte[] validMp4Bytes = new byte[] { 0, 0, 0, 20, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0 };
        org.springframework.mock.web.MockMultipartFile validMp4 = new org.springframework.mock.web.MockMultipartFile(
                "file", "lesson.mp4", "video/mp4", validMp4Bytes
        );

        when(mediaRepository.save(any(CommunityPostMedia.class))).thenAnswer(inv -> {
            CommunityPostMedia m = inv.getArgument(0);
            m.setId(101L);
            return m;
        });

        CommunityPostMedia savedMedia = storageService.uploadMedia(100L, validMp4);

        assertThat(savedMedia.getUserId()).isEqualTo(100L);
        assertThat(savedMedia.getMimeType()).isEqualTo("video/mp4");
        assertThat(savedMedia.getStorageKey()).endsWith(".mp4");

        // Invalid fake video bytes (e.g. text/exe pretending to be mp4)
        byte[] fakeBytes = "echo malicious payload".getBytes();
        org.springframework.mock.web.MockMultipartFile fakeMp4 = new org.springframework.mock.web.MockMultipartFile(
                "file", "exploit.mp4", "video/mp4", fakeBytes
        );

        assertThatThrownBy(() -> storageService.uploadMedia(100L, fakeMp4))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("không khớp định dạng MP4");
    }

    @Test
    @DisplayName("Reaction summary aggregates grouped counts and lists enriched reactors")
    void testReactionSummary() {
        CommunityPost post = CommunityPost.builder()
                .id(50L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .content("Test post")
                .build();
        when(postRepository.findById(50L)).thenReturn(Optional.of(post));

        List<Object[]> grouped = new ArrayList<>();
        grouped.add(new Object[] { ReactionType.LIKE, 3L });
        grouped.add(new Object[] { ReactionType.FIRE, 2L });
        when(reactionRepository.countGroupedByReactionType(50L)).thenReturn(grouped);

        User reactor1 = User.builder().id(201L).name("Linh").build();
        CommunityPostReaction r1 = CommunityPostReaction.builder()
                .id(1L)
                .post(post)
                .user(reactor1)
                .reactionType(ReactionType.LIKE)
                .createdAt(Instant.now())
                .build();

        PageImpl<CommunityPostReaction> page = new PageImpl<>(List.of(r1));
        when(reactionRepository.findByPostIdWithUser(eq(50L), any(PageRequest.class))).thenReturn(page);

        PostReactionSummaryDto summary = interactionService.getReactionSummary(50L, null, regularUser.getId(), 0, 20);

        assertThat(summary.getTotalCount()).isEqualTo(5);
        assertThat(summary.getCountsByType()).containsEntry("LOVE", 3).containsEntry("FIRE", 2);
        assertThat(summary.getReactors()).hasSize(1);
        assertThat(summary.getReactors().get(0).getUser().getName()).isEqualTo("Linh");
        assertThat(summary.getReactors().get(0).getReactionType()).isEqualTo(ReactionType.LOVE);
    }

    @Test
    @DisplayName("Create post with text and attached media executes safely without collection dereference")
    void testCreatePostWithMediaSafeCollectionMutation() {
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));

        CommunityPost savedPost = CommunityPost.builder()
                .id(999L)
                .author(regularUser)
                .content("Bài viết có ảnh đính kèm")
                .status(PostStatus.PENDING)
                .postType(PostType.GENERAL)
                .build();
        when(postRepository.save(any(CommunityPost.class))).thenReturn(savedPost);

        CommunityPostMedia media1 = CommunityPostMedia.builder()
                .id(10L)
                .userId(100L)
                .storageKey("sample-uuid-1.jpg")
                .fileName("photo.jpg")
                .fileSize(1024L)
                .mimeType("image/jpeg")
                .build();
        when(mediaRepository.findAllById(List.of(10L))).thenReturn(List.of(media1));
        when(mediaRepository.save(any(CommunityPostMedia.class))).thenReturn(media1);

        CreatePostRequest req = CreatePostRequest.builder()
                .content("Bài viết có ảnh đính kèm")
                .postType(PostType.GENERAL)
                .mediaIds(List.of(10L))
                .build();

        CommunityPostDto result = postService.createPost(100L, req);

        assertThat(result).isNotNull();
        assertThat(result.getId()).isEqualTo(999L);
        assertThat(result.getContent()).isEqualTo("Bài viết có ảnh đính kèm");
        assertThat(result.getMedia()).hasSize(1);
        assertThat(result.getMedia().get(0).getId()).isEqualTo(10L);
        verify(mediaRepository).save(media1);
    }

    @Test
    @DisplayName("Create post rejects media belonging to another user")
    void testCreatePostRejectMediaBelongingToOtherUser() {
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));

        CommunityPost savedPost = CommunityPost.builder()
                .id(999L)
                .author(regularUser)
                .content("Hack attempt")
                .status(PostStatus.PENDING)
                .build();
        when(postRepository.save(any(CommunityPost.class))).thenReturn(savedPost);

        CommunityPostMedia otherUserMedia = CommunityPostMedia.builder()
                .id(20L)
                .userId(9999L) // Different user!
                .storageKey("victim.jpg")
                .fileName("victim.jpg")
                .fileSize(1024L)
                .mimeType("image/jpeg")
                .build();
        when(mediaRepository.findAllById(List.of(20L))).thenReturn(List.of(otherUserMedia));

        CreatePostRequest req = CreatePostRequest.builder()
                .content("Hack attempt")
                .mediaIds(List.of(20L))
                .build();

        assertThatThrownBy(() -> postService.createPost(100L, req))
                .isInstanceOf(org.springframework.security.access.AccessDeniedException.class)
                .hasMessageContaining("Không thể sử dụng tệp đính kèm của người dùng khác");
    }

    @Test
    @DisplayName("Create post rejects more than 2 video attachments and more than 10 images")
    void testCreatePostRejectExcessVideosAndImages() {
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));

        CommunityPost savedPost = CommunityPost.builder()
                .id(999L)
                .author(regularUser)
                .content("Three videos test")
                .build();
        when(postRepository.save(any(CommunityPost.class))).thenReturn(savedPost);

        CommunityPostMedia v1 = CommunityPostMedia.builder().id(1L).userId(100L).storageKey("v1.mp4").fileName("v1.mp4").fileSize(100L).mimeType("video/mp4").build();
        CommunityPostMedia v2 = CommunityPostMedia.builder().id(2L).userId(100L).storageKey("v2.mp4").fileName("v2.mp4").fileSize(100L).mimeType("video/mp4").build();
        CommunityPostMedia v3 = CommunityPostMedia.builder().id(3L).userId(100L).storageKey("v3.mp4").fileName("v3.mp4").fileSize(100L).mimeType("video/mp4").build();
        when(mediaRepository.findAllById(List.of(1L, 2L, 3L))).thenReturn(List.of(v1, v2, v3));

        CreatePostRequest reqVideos = CreatePostRequest.builder()
                .content("Three videos test")
                .mediaIds(List.of(1L, 2L, 3L))
                .build();

        assertThatThrownBy(() -> postService.createPost(100L, reqVideos))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Mỗi bài viết chỉ được đính kèm tối đa 2 video");

        // Test 11 images rejection
        List<CommunityPostMedia> elevenImages = new ArrayList<>();
        List<Long> imageIds = new ArrayList<>();
        for (long i = 1; i <= 11; i++) {
            imageIds.add(i);
            elevenImages.add(CommunityPostMedia.builder().id(i).userId(100L).storageKey("img" + i + ".jpg").fileName("img" + i + ".jpg").fileSize(100L).mimeType("image/jpeg").build());
        }
        when(mediaRepository.findAllById(imageIds)).thenReturn(elevenImages);

        CreatePostRequest reqImages = CreatePostRequest.builder()
                .content("Eleven images test")
                .mediaIds(imageIds)
                .build();

        assertThatThrownBy(() -> postService.createPost(100L, reqImages))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Mỗi bài viết chỉ được đính kèm tối đa 10 hình ảnh");
    }

    @Test
    @DisplayName("Toggle reaction supports expanded reactions and switching types")
    void testToggleReactionExpandedTypes() {
        CommunityPost post = CommunityPost.builder()
                .id(1000L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .build();
        when(postRepository.findById(1000L)).thenReturn(Optional.of(post));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));
        when(reactionRepository.countByPostId(1000L)).thenReturn(1L);

        // 1. React with HAHA
        ReactionResponse res1 = interactionService.toggleReaction(100L, 1000L, ReactionType.HAHA);
        assertThat(res1.getMyReaction()).isEqualTo(ReactionType.HAHA);

        // 2. Switch to SUPPORT
        CommunityPostReaction existingHaha = CommunityPostReaction.builder()
                .id(1L)
                .post(post)
                .user(regularUser)
                .reactionType(ReactionType.HAHA)
                .build();
        when(reactionRepository.findByPostIdAndUserId(1000L, 100L)).thenReturn(Optional.of(existingHaha));

        ReactionResponse res2 = interactionService.toggleReaction(100L, 1000L, ReactionType.SUPPORT);
        assertThat(res2.getMyReaction()).isEqualTo(ReactionType.SUPPORT);
        assertThat(existingHaha.getReactionType()).isEqualTo(ReactionType.SUPPORT);
    }

    @Test
    @DisplayName("Feed query routes to postType and hashtag query methods when provided")
    void testFeedFilteringByPostTypeAndHashtag() {
        when(postRepository.findPublicFeedByPostType(eq(PostType.QUESTION), any(PageRequest.class)))
                .thenReturn(new PageImpl<>(Collections.emptyList()));
        String exactPattern = "#ielts($|[^a-zA-Z0-9_\u00C0-\u024F\u1EA0-\u1EF9])";
        when(postRepository.findPublicFeedByHashtag(eq(exactPattern), any(PageRequest.class)))
                .thenReturn(new PageImpl<>(Collections.emptyList()));
        when(postRepository.findPublicFeedByPostTypeAndHashtag(eq(PostType.LEARNING), eq(exactPattern), any(PageRequest.class)))
                .thenReturn(new PageImpl<>(Collections.emptyList()));

        postService.getPublicFeed(1L, 0, 10, PostType.QUESTION, null);
        verify(postRepository).findPublicFeedByPostType(eq(PostType.QUESTION), any(PageRequest.class));

        postService.getPublicFeed(1L, 0, 10, null, "ielts");
        verify(postRepository).findPublicFeedByHashtag(eq(exactPattern), any(PageRequest.class));

        postService.getPublicFeed(1L, 0, 10, PostType.LEARNING, "#ielts");
        verify(postRepository).findPublicFeedByPostTypeAndHashtag(eq(PostType.LEARNING), eq(exactPattern), any(PageRequest.class));
    }

    @Test
    @DisplayName("Trending service scores and ranks real published hashtags dynamically")
    void testTrendingServiceCalculation() {
        CommunityTrendingService trendingService = new CommunityTrendingService(postRepository);

        CommunityPost p1 = CommunityPost.builder()
                .id(1L)
                .author(regularUser)
                .content("Học từ vựng #TuVungHangNgay và #EnglishCoach")
                .likeCount(10)
                .commentCount(4)
                .status(PostStatus.PUBLISHED)
                .createdAt(Instant.now().minusSeconds(3600))
                .build();

        CommunityPost p2 = CommunityPost.builder()
                .id(2L)
                .author(adminUser)
                .content("Luyện đề #IELTS hôm nay cùng #TuVungHangNgay")
                .likeCount(5)
                .commentCount(2)
                .status(PostStatus.PUBLISHED)
                .createdAt(Instant.now().minusSeconds(1800))
                .build();

        when(postRepository.findRecentPublishedPostsForTrending(any(Instant.class)))
                .thenReturn(List.of(p1, p2));

        List<TrendingTopicDto> topics = trendingService.getTrendingTopics();

        assertThat(topics).isNotEmpty();
        assertThat(topics.get(0).getTag()).isEqualTo("TuVungHangNgay");
        assertThat(topics.get(0).getPostCount()).isEqualTo(2);
        assertThat(topics.get(0).getReactionCount()).isEqualTo(15);
        assertThat(topics.get(0).getCommentCount()).isEqualTo(6);
        assertThat(topics.get(0).getLabel()).isEqualTo("Hôm nay");
    }

    @Test
    @DisplayName("Official publisher mutates mediaList in-place without replacing collection reference")
    void testOfficialPublisherPersistentBagOrphanRemovalSafety() {
        when(userRepository.findById(1L)).thenReturn(Optional.of(adminUser));

        CommunityPost postWithManagedList = CommunityPost.builder()
                .id(901L)
                .author(adminUser)
                .authorType(AuthorType.OFFICIAL)
                .status(PostStatus.PUBLISHED)
                .postType(PostType.OFFICIAL)
                .content("Official announcement")
                .build();
        // Simulate Hibernate PersistentBag
        List<CommunityPostMedia> managedList = postWithManagedList.getMediaList();
        when(postRepository.save(any(CommunityPost.class))).thenReturn(postWithManagedList);
        when(postRepository.findById(901L)).thenReturn(Optional.of(postWithManagedList));

        CommunityPostMedia m1 = CommunityPostMedia.builder().id(11L).storageKey("img1.png").fileName("img1.png").fileSize(100L).mimeType("image/png").build();
        CommunityPostMedia m2 = CommunityPostMedia.builder().id(12L).storageKey("vid1.mp4").fileName("vid1.mp4").fileSize(200L).mimeType("video/mp4").build();
        when(mediaRepository.findAllById(List.of(11L, 12L))).thenReturn(List.of(m1, m2));

        OfficialPublishRequest req = OfficialPublishRequest.builder()
                .content("Official announcement")
                .postType(PostType.OFFICIAL)
                .mediaIds(List.of(11L, 12L))
                .build();

        CommunityPostDto dto = officialPublisherService.publishOfficialPost(1L, req);
        assertThat(dto).isNotNull();
        // Verify post.getMediaList() reference was preserved
        assertThat(postWithManagedList.getMediaList()).isSameAs(managedList);
        assertThat(postWithManagedList.getMediaList()).hasSize(2);
    }

    @Test
    @DisplayName("Comment thread creates hierarchical tree and preserves exact parent relationship")
    void testCommentThreadHierarchy() {
        CommunityPost post = CommunityPost.builder()
                .id(902L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .build();

        // Create root comment A
        CommunityComment commentA = CommunityComment.builder()
                .id(1L)
                .post(post)
                .user(regularUser)
                .content("Root comment A")
                .createdAt(Instant.now())
                .build();

        // Create reply B to A
        CommunityComment commentB = CommunityComment.builder()
                .id(2L)
                .post(post)
                .user(regularUser)
                .parentComment(commentA)
                .content("Reply B to A")
                .createdAt(Instant.now())
                .build();

        // Create reply C to B (deep nesting)
        CommunityComment commentC = CommunityComment.builder()
                .id(3L)
                .post(post)
                .user(regularUser)
                .parentComment(commentB)
                .content("Reply C to B")
                .createdAt(Instant.now())
                .build();

        when(postRepository.findById(902L)).thenReturn(Optional.of(post));
        when(commentRepository.findAllPublishedForPost(902L))
                .thenReturn(List.of(commentA, commentB, commentC));

        CommunityFeedPageDto<CommentDto> tree = commentService.getComments(100L, 902L, 0, 20);
        assertThat(tree.getItems()).hasSize(1);
        CommentDto rootA = tree.getItems().get(0);
        assertThat(rootA.getId()).isEqualTo(1L);
        assertThat(rootA.getReplies()).hasSize(1);

        CommentDto childB = rootA.getReplies().get(0);
        assertThat(childB.getId()).isEqualTo(2L);
        assertThat(childB.getParentId()).isEqualTo(1L);
        assertThat(childB.getReplies()).hasSize(1);

        CommentDto childC = childB.getReplies().get(0);
        assertThat(childC.getId()).isEqualTo(3L);
        assertThat(childC.getParentId()).isEqualTo(2L);
    }

    @Test
    @DisplayName("Comment locking blocks comments by owner and admin override")
    void testCommentLockingEnforcement() {
        CommunityPost post = CommunityPost.builder()
                .id(903L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .commentsDisabledByOwner(true)
                .build();
        when(postRepository.findById(903L)).thenReturn(Optional.of(post));

        CreateCommentRequest req = CreateCommentRequest.builder().content("New comment").build();

        // 1. Owner disabled
        assertThatThrownBy(() -> commentService.createComment(100L, 903L, req))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Bình luận đã bị tắt cho bài viết này");

        // 2. Admin locked override
        post.setCommentsDisabledByOwner(false);
        post.setCommentsLockedByAdmin(true);

        assertThatThrownBy(() -> commentService.createComment(100L, 903L, req))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Bình luận đã bị khóa bởi quản trị viên");
    }

    @Test
    @DisplayName("Community user restrictions enforce posting, commenting, and reaction permissions")
    void testCommunityRestrictionsEnforcement() {
        Instant now = Instant.now();
        CommunityUserRestriction readOnly = CommunityUserRestriction.builder()
                .id(1L)
                .targetUser(regularUser)
                .restrictionType(CommunityRestrictionType.READ_ONLY)
                .createdAt(now)
                .expiresAt(now.plusSeconds(3600))
                .build();

        when(restrictionRepository.findLatestActiveRestriction(eq(100L), any(Instant.class)))
                .thenReturn(Optional.of(readOnly));

        // READ_ONLY cannot post
        assertThatThrownBy(() -> restrictionService.assertCanPost(100L))
                .isInstanceOf(org.springframework.security.access.AccessDeniedException.class)
                .hasMessageContaining("chỉ có thể xem");

        // READ_ONLY cannot comment
        assertThatThrownBy(() -> restrictionService.assertCanComment(100L))
                .isInstanceOf(org.springframework.security.access.AccessDeniedException.class);

        // READ_ONLY can still react
        restrictionService.assertCanReact(100L); // Does not throw

        // SUSPEND_COMMUNITY blocks everything including react
        CommunityUserRestriction suspended = CommunityUserRestriction.builder()
                .id(2L)
                .targetUser(regularUser)
                .restrictionType(CommunityRestrictionType.SUSPEND_COMMUNITY)
                .createdAt(now)
                .expiresAt(now.plusSeconds(3600))
                .build();
        when(restrictionRepository.findLatestActiveRestriction(eq(100L), any(Instant.class)))
                .thenReturn(Optional.of(suspended));

        assertThatThrownBy(() -> restrictionService.assertCanReact(100L))
                .isInstanceOf(org.springframework.security.access.AccessDeniedException.class)
                .hasMessageContaining("đình chỉ");
    }

    @Test
    @DisplayName("Create comment with image media succeeds and maps mediaUrl")
    void testCreateCommentWithImageMediaSuccess() {
        CommunityPost post = CommunityPost.builder()
                .id(950L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .build();
        when(postRepository.findById(950L)).thenReturn(Optional.of(post));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));
        when(mediaRepository.findByStorageKey("test.png")).thenReturn(Optional.of(
                CommunityPostMedia.builder().storageKey("test.png").userId(100L).mimeType("image/png").fileName("test.png").fileSize(128L).build()));

        CreateCommentRequest req = CreateCommentRequest.builder()
                .content("Check this image!")
                .mediaUrl("/api/v1/community/media/test.png")
                .mediaType("image/png")
                .build();

        when(commentRepository.save(any(CommunityComment.class))).thenAnswer(inv -> {
            CommunityComment c = inv.getArgument(0);
            c.setId(1001L);
            c.setCreatedAt(Instant.now());
            return c;
        });

        CommentDto dto = commentService.createComment(100L, 950L, req);

        assertThat(dto).isNotNull();
        assertThat(dto.getContent()).isEqualTo("Check this image!");
        assertThat(dto.getMediaUrl()).isEqualTo("/api/v1/community/media/test.png");
        assertThat(dto.getMediaType()).isEqualTo("image/png");
    }

    @Test
    @DisplayName("Create comment with media only (empty content) succeeds")
    void testCreateCommentWithMediaOnlySuccess() {
        CommunityPost post = CommunityPost.builder()
                .id(951L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .build();
        when(postRepository.findById(951L)).thenReturn(Optional.of(post));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));
        when(mediaRepository.findByStorageKey("video.mp4")).thenReturn(Optional.of(
                CommunityPostMedia.builder().storageKey("video.mp4").userId(100L).mimeType("video/mp4").fileName("video.mp4").fileSize(512L).build()));

        CreateCommentRequest req = CreateCommentRequest.builder()
                .mediaUrl("/api/v1/community/media/video.mp4")
                .mediaType("video/mp4")
                .build();

        when(commentRepository.save(any(CommunityComment.class))).thenAnswer(inv -> {
            CommunityComment c = inv.getArgument(0);
            c.setId(1002L);
            c.setCreatedAt(Instant.now());
            return c;
        });

        CommentDto dto = commentService.createComment(100L, 951L, req);

        assertThat(dto).isNotNull();
        assertThat(dto.getContent()).isNull();
        assertThat(dto.getMediaUrl()).isEqualTo("/api/v1/community/media/video.mp4");
        assertThat(dto.getMediaType()).isEqualTo("video/mp4");
    }

    @Test
    @DisplayName("Create comment with both empty content and empty media throws IllegalArgumentException")
    void testCreateCommentEmptyContentAndMediaThrows() {
        CommunityPost post = CommunityPost.builder()
                .id(952L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .build();
        when(postRepository.findById(952L)).thenReturn(Optional.of(post));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));

        CreateCommentRequest req = CreateCommentRequest.builder()
                .content("   ")
                .mediaUrl(null)
                .build();

        assertThatThrownBy(() -> commentService.createComment(100L, 952L, req))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Nội dung hoặc file đính kèm không được để trống");
    }

    @Test
    @DisplayName("Create comment with 5 images and 1 video succeeds")
    void testCreateComment5Images1VideoSucceeds() {
        CommunityPost post = CommunityPost.builder()
                .id(953L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .build();
        when(postRepository.findById(953L)).thenReturn(Optional.of(post));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));

        when(commentRepository.save(any(CommunityComment.class))).thenAnswer(inv -> {
            CommunityComment c = inv.getArgument(0);
            c.setId(888L);
            return c;
        });

        when(commentMediaRepository.save(any(com.englishcoach.community.entity.CommunityCommentMedia.class))).thenAnswer(inv -> {
            com.englishcoach.community.entity.CommunityCommentMedia m = inv.getArgument(0);
            m.setId(1000L + m.getDisplayOrder());
            return m;
        });

        for (int idx = 1; idx <= 5; idx++) {
            String key = "img" + idx + ".png";
            when(mediaRepository.findByStorageKey(key)).thenReturn(Optional.of(
                    CommunityPostMedia.builder().storageKey(key).userId(100L).mimeType("image/png").fileName(key).fileSize(128L).build()));
        }
        when(mediaRepository.findByStorageKey("vid1.mp4")).thenReturn(Optional.of(
                CommunityPostMedia.builder().storageKey("vid1.mp4").userId(100L).mimeType("video/mp4").fileName("vid1.mp4").fileSize(512L).build()));

        List<CreateCommentRequest.CommentMediaItemRequest> mediaItems = List.of(
                new CreateCommentRequest.CommentMediaItemRequest("/api/v1/community/media/img1.png", "image/png"),
                new CreateCommentRequest.CommentMediaItemRequest("/api/v1/community/media/img2.png", "image/png"),
                new CreateCommentRequest.CommentMediaItemRequest("/api/v1/community/media/img3.png", "image/png"),
                new CreateCommentRequest.CommentMediaItemRequest("/api/v1/community/media/img4.png", "image/png"),
                new CreateCommentRequest.CommentMediaItemRequest("/api/v1/community/media/img5.png", "image/png"),
                new CreateCommentRequest.CommentMediaItemRequest("/api/v1/community/media/vid1.mp4", "video/mp4")
        );

        CreateCommentRequest req = CreateCommentRequest.builder()
                .content("Bình luận đầy đủ 5 ảnh 1 video")
                .media(mediaItems)
                .build();

        CommentDto dto = commentService.createComment(100L, 953L, req);

        assertThat(dto).isNotNull();
        assertThat(dto.getContent()).isEqualTo("Bình luận đầy đủ 5 ảnh 1 video");
        assertThat(dto.getMedia()).hasSize(6);
        assertThat(dto.getMedia().get(0).getMediaUrl()).isEqualTo("/api/v1/community/media/img1.png");
        assertThat(dto.getMedia().get(5).getMediaUrl()).isEqualTo("/api/v1/community/media/vid1.mp4");
        assertThat(dto.getMedia().get(5).getMediaType()).isEqualTo("video/mp4");
        verify(commentMediaRepository, times(6)).save(any(com.englishcoach.community.entity.CommunityCommentMedia.class));
    }

    @Test
    @DisplayName("Create comment with 6 images throws 400 IllegalArgumentException")
    void testCreateComment6ImagesThrowsBadRequest() {
        CommunityPost post = CommunityPost.builder()
                .id(954L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .build();
        when(postRepository.findById(954L)).thenReturn(Optional.of(post));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));

        List<CreateCommentRequest.CommentMediaItemRequest> mediaItems = List.of(
                new CreateCommentRequest.CommentMediaItemRequest("https://img1.png", "image/png"),
                new CreateCommentRequest.CommentMediaItemRequest("https://img2.png", "image/png"),
                new CreateCommentRequest.CommentMediaItemRequest("https://img3.png", "image/png"),
                new CreateCommentRequest.CommentMediaItemRequest("https://img4.png", "image/png"),
                new CreateCommentRequest.CommentMediaItemRequest("https://img5.png", "image/png"),
                new CreateCommentRequest.CommentMediaItemRequest("https://img6.png", "image/png")
        );

        CreateCommentRequest req = CreateCommentRequest.builder()
                .content("Bình luận 6 ảnh vượt giới hạn")
                .media(mediaItems)
                .build();

        assertThatThrownBy(() -> commentService.createComment(100L, 954L, req))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Bình luận tối đa 5 hình ảnh");
    }

    @Test
    @DisplayName("Create comment with 2 videos throws 400 IllegalArgumentException")
    void testCreateComment2VideosThrowsBadRequest() {
        CommunityPost post = CommunityPost.builder()
                .id(955L)
                .author(regularUser)
                .status(PostStatus.PUBLISHED)
                .build();
        when(postRepository.findById(955L)).thenReturn(Optional.of(post));
        when(userRepository.findById(100L)).thenReturn(Optional.of(regularUser));

        List<CreateCommentRequest.CommentMediaItemRequest> mediaItems = List.of(
                new CreateCommentRequest.CommentMediaItemRequest("https://vid1.mp4", "video/mp4"),
                new CreateCommentRequest.CommentMediaItemRequest("https://vid2.mp4", "video/mp4")
        );

        CreateCommentRequest req = CreateCommentRequest.builder()
                .content("Bình luận 2 video vượt giới hạn")
                .media(mediaItems)
                .build();

        assertThatThrownBy(() -> commentService.createComment(100L, 955L, req))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Bình luận tối đa 1 video");
    }
}
