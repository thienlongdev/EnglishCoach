package com.englishcoach.community;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.avatarframe.service.AvatarFrameService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.community.controller.CommunityFeedController;
import com.englishcoach.community.dto.CommentDto;
import com.englishcoach.community.dto.CommunityFeedPageDto;
import com.englishcoach.community.dto.CommunityPostDto;
import com.englishcoach.community.dto.CreateCommentRequest;
import com.englishcoach.community.dto.UpdatePostRequest;
import com.englishcoach.community.entity.AuthorType;
import com.englishcoach.community.entity.CommunityComment;
import com.englishcoach.community.entity.CommunityCommentMedia;
import com.englishcoach.community.entity.CommunityPost;
import com.englishcoach.community.entity.CommunityPostMedia;
import com.englishcoach.community.entity.CommunityRestrictionType;
import com.englishcoach.community.entity.CommunityUserRestriction;
import com.englishcoach.community.entity.PostStatus;
import com.englishcoach.community.entity.PostType;
import com.englishcoach.community.entity.ReactionType;
import com.englishcoach.community.repository.*;
import com.englishcoach.community.service.*;
import com.englishcoach.echolife.EchoLifeGameService;
import com.englishcoach.echolife.EchoLifeWorkshop;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.messenger.*;
import com.englishcoach.messenger.MessengerDtos.MembersRequest;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.proficiency.ProficiencyLevelQueryService;
import com.englishcoach.progress.service.UnifiedProgressService;
import com.englishcoach.user.repository.UserProfileRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.Collections;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * Security regression suite covering Workstream 3B Community, Messenger, and Echo Life GraalJS findings:
 * EC-SEC-2026-026, EC-SEC-2026-027, SOC-04, SOC-05, SOC-06, SOC-07, SOC-09, SOC-11, EC-SEC-2026-021, WS-09.
 */
class SocialAndEchoLifeSecurityRegressionTest {

    private CommunityPostRepository postRepository;
    private CommunityPostMediaRepository mediaRepository;
    private CommunityPostReactionRepository reactionRepository;
    private CommunityCommentRepository commentRepository;
    private CommunityCommentReactionRepository commentReactionRepository;
    private CommunityCommentMediaRepository commentMediaRepository;
    private CommunityFollowRepository followRepository;
    private CommunitySavedPostRepository savedPostRepository;
    private CommunityReportRepository reportRepository;
    private CommunityModerationRecordRepository moderationRecordRepository;
    private CommunityUserRestrictionRepository restrictionRepository;
    private UserRepository userRepository;
    private NotificationService notificationService;

    private CommunityRestrictionService restrictionService;
    private CommunityPostService postService;
    private CommunityInteractionService interactionService;
    private CommunityCommentService commentService;

    private User authorUser;
    private User otherUser;

    @BeforeEach
    void setUp() {
        postRepository = mock(CommunityPostRepository.class);
        mediaRepository = mock(CommunityPostMediaRepository.class);
        reactionRepository = mock(CommunityPostReactionRepository.class);
        commentRepository = mock(CommunityCommentRepository.class);
        commentReactionRepository = mock(CommunityCommentReactionRepository.class);
        commentMediaRepository = mock(CommunityCommentMediaRepository.class);
        followRepository = mock(CommunityFollowRepository.class);
        savedPostRepository = mock(CommunitySavedPostRepository.class);
        reportRepository = mock(CommunityReportRepository.class);
        moderationRecordRepository = mock(CommunityModerationRecordRepository.class);
        restrictionRepository = mock(CommunityUserRestrictionRepository.class);
        userRepository = mock(UserRepository.class);
        notificationService = mock(NotificationService.class);

        CommunityAuthorEnrichmentService authorEnrichmentService = new CommunityAuthorEnrichmentService(
                mock(UserProfileRepository.class),
                mock(AvatarFrameService.class),
                mock(PremiumEntitlementService.class),
                mock(UnifiedProgressService.class),
                mock(ProficiencyLevelQueryService.class),
                followRepository
        );
        CommunityLearningValidationService learningValidationService = new CommunityLearningValidationService(
                mock(ListeningMaterialRepository.class),
                null,
                null,
                new ObjectMapper()
        );
        restrictionService = new CommunityRestrictionService(restrictionRepository, userRepository);
        postService = new CommunityPostService(
                postRepository, mediaRepository, reactionRepository, savedPostRepository,
                moderationRecordRepository, userRepository, authorEnrichmentService,
                learningValidationService, restrictionService
        );
        interactionService = new CommunityInteractionService(
                postRepository, reactionRepository, savedPostRepository, followRepository,
                reportRepository, commentRepository, userRepository, notificationService,
                authorEnrichmentService, restrictionService
        );
        commentService = new CommunityCommentService(
                commentRepository, commentReactionRepository, commentMediaRepository,
                postRepository, userRepository, authorEnrichmentService,
                notificationService, restrictionService
        );
        commentService.setPostMediaRepository(mediaRepository);

        authorUser = User.builder().id(100L).name("Author").email("author@example.test").role(Role.ROLE_USER).build();
        otherUser = User.builder().id(200L).name("Other").email("other@example.test").role(Role.ROLE_USER).build();
    }

    @Test
    @DisplayName("EC-SEC-2026-026: Comment rejects external mediaUrl and other users' uploads, accepts caller's relative media")
    void commentMediaUrlStrictlyValidated() {
        CommunityPost post = CommunityPost.builder().id(10L).author(authorUser).status(PostStatus.PUBLISHED).build();
        when(postRepository.findById(10L)).thenReturn(Optional.of(post));
        when(userRepository.findById(100L)).thenReturn(Optional.of(authorUser));

        // 1. External URL rejected with 400 IllegalArgumentException
        CreateCommentRequest externalReq = CreateCommentRequest.builder()
                .content("Look!")
                .mediaUrl("https://evil.example/tracker.png")
                .mediaType("image/png")
                .build();
        assertThatThrownBy(() -> commentService.createComment(100L, 10L, externalReq))
                .isInstanceOf(IllegalArgumentException.class);

        // 2. Relative URL belonging to another user rejected
        CommunityPostMedia othersUpload = CommunityPostMedia.builder()
                .id(5L).userId(200L).storageKey("other-user-file.png").mimeType("image/png").build();
        when(mediaRepository.findByStorageKey("other-user-file.png")).thenReturn(Optional.of(othersUpload));
        CreateCommentRequest stolenReq = CreateCommentRequest.builder()
                .content("Stolen")
                .mediaUrl("/api/v1/community/media/other-user-file.png")
                .build();
        assertThatThrownBy(() -> commentService.createComment(100L, 10L, stolenReq))
                .isInstanceOf(IllegalArgumentException.class);

        // 3. Relative URL uploaded by caller succeeds
        CommunityPostMedia ownUpload = CommunityPostMedia.builder()
                .id(6L).userId(100L).storageKey("own-file.png").mimeType("image/png").build();
        when(mediaRepository.findByStorageKey("own-file.png")).thenReturn(Optional.of(ownUpload));
        when(commentRepository.save(any(CommunityComment.class))).thenAnswer(inv -> {
            CommunityComment c = inv.getArgument(0);
            c.setId(501L);
            c.setCreatedAt(Instant.now());
            return c;
        });
        when(commentMediaRepository.save(any(CommunityCommentMedia.class))).thenAnswer(inv -> inv.getArgument(0));

        CreateCommentRequest validReq = CreateCommentRequest.builder()
                .content("Own media")
                .mediaUrl("/api/v1/community/media/own-file.png")
                .build();
        CommentDto created = commentService.createComment(100L, 10L, validReq);
        assertThat(created.getMediaUrl()).isEqualTo("/api/v1/community/media/own-file.png");
    }

    @Test
    @DisplayName("EC-SEC-2026-027: Comments/reactions/saves on HIDDEN or DELETED posts are rejected for anonymous and other users")
    void hiddenAndDeletedPostsProtectCommentsReactionsAndSaves() {
        CommunityPost hiddenPost = CommunityPost.builder().id(20L).author(authorUser).status(PostStatus.HIDDEN).build();
        CommunityPost deletedPost = CommunityPost.builder().id(21L).author(authorUser).status(PostStatus.DELETED).build();
        when(postRepository.findById(20L)).thenReturn(Optional.of(hiddenPost));
        when(postRepository.findById(21L)).thenReturn(Optional.of(deletedPost));
        when(userRepository.findById(200L)).thenReturn(Optional.of(otherUser));

        // Anonymous cannot read comments on HIDDEN or DELETED posts
        assertThatThrownBy(() -> commentService.getComments(null, 20L, 0, 20))
                .isInstanceOf(NoSuchElementException.class);
        assertThatThrownBy(() -> commentService.getComments(null, 21L, 0, 20))
                .isInstanceOf(NoSuchElementException.class);

        // Another user cannot read comments on HIDDEN or DELETED posts
        assertThatThrownBy(() -> commentService.getComments(200L, 20L, 0, 20))
                .isInstanceOf(NoSuchElementException.class);
        assertThatThrownBy(() -> commentService.getComments(200L, 21L, 0, 20))
                .isInstanceOf(NoSuchElementException.class);

        // Reacting to a comment on a HIDDEN post is rejected
        CommunityComment commentOnHidden = CommunityComment.builder()
                .id(300L).post(hiddenPost).user(authorUser).status("PUBLISHED").content("hi").build();
        when(commentRepository.findById(300L)).thenReturn(Optional.of(commentOnHidden));
        assertThatThrownBy(() -> commentService.reactToComment(200L, 300L, ReactionType.LOVE))
                .isInstanceOf(IllegalStateException.class);

        // Saving a HIDDEN or DELETED post is rejected
        assertThatThrownBy(() -> interactionService.toggleSavePost(200L, 20L))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> interactionService.toggleSavePost(200L, 21L))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    @DisplayName("SOC-04: Suspended user is blocked from updatePost and media edit returns PUBLISHED post to PENDING")
    void updatePostEnforcesRestrictionAndModerationOnMediaChange() {
        CommunityPost publishedPost = CommunityPost.builder()
                .id(30L).author(authorUser).authorType(AuthorType.USER)
                .status(PostStatus.PUBLISHED).postType(PostType.GENERAL)
                .content("Original text").publishedAt(Instant.now()).build();
        when(postRepository.findById(30L)).thenReturn(Optional.of(publishedPost));

        // 1. Suspended user cannot edit post
        CommunityUserRestriction suspended = CommunityUserRestriction.builder()
                .id(1L).targetUser(authorUser)
                .restrictionType(CommunityRestrictionType.SUSPEND_COMMUNITY)
                .createdAt(Instant.now()).expiresAt(Instant.now().plusSeconds(3600)).build();
        when(restrictionRepository.findLatestActiveRestriction(eq(100L), any(Instant.class)))
                .thenReturn(Optional.of(suspended));

        UpdatePostRequest editReq = UpdatePostRequest.builder().content("Edited text").build();
        assertThatThrownBy(() -> postService.updatePost(100L, 30L, editReq))
                .isInstanceOf(AccessDeniedException.class);

        // 2. Unrestricted author changing ONLY media attachments on PUBLISHED post returns it to PENDING
        when(restrictionRepository.findLatestActiveRestriction(eq(100L), any(Instant.class)))
                .thenReturn(Optional.empty());
        CommunityPostMedia newMedia = CommunityPostMedia.builder()
                .id(88L).userId(100L).storageKey("new-pic.png").mimeType("image/png").build();
        when(mediaRepository.findByPostIdOrderByDisplayOrderAsc(30L)).thenReturn(Collections.emptyList());
        when(mediaRepository.findAllById(List.of(88L))).thenReturn(List.of(newMedia));
        when(postRepository.save(any(CommunityPost.class))).thenAnswer(inv -> inv.getArgument(0));
        when(mediaRepository.findByPostIdInOrderByDisplayOrderAsc(List.of(30L))).thenReturn(List.of(newMedia));

        UpdatePostRequest mediaOnlyEdit = UpdatePostRequest.builder()
                .content("Original text")
                .mediaIds(List.of(88L))
                .build();
        CommunityPostDto updated = postService.updatePost(100L, 30L, mediaOnlyEdit);
        assertThat(updated.getStatus()).isEqualTo(PostStatus.PENDING);
        assertThat(publishedPost.getPublishedAt()).isNull();
    }

    @Test
    @DisplayName("SOC-05 & SOC-09: Blocked users cannot follow; CommunityFeedController clamps pagination to 1..50 and page >= 0")
    void followRespectsMessengerBlockAndFeedClampsPagination() {
        MessengerRepository messengerRepo = mock(MessengerRepository.class);
        interactionService.setMessengerRepository(messengerRepo);
        when(messengerRepo.blockedEitherWay(100L, 200L)).thenReturn(true);

        assertThatThrownBy(() -> interactionService.followUser(100L, 200L))
                .isInstanceOf(AccessDeniedException.class);

        CommunityPostService mockPostSvc = mock(CommunityPostService.class);
        CommunityFeedPageDto<CommunityPostDto> emptyPage = CommunityFeedPageDto.<CommunityPostDto>builder()
                .items(Collections.emptyList()).page(0).size(50).build();
        when(mockPostSvc.getPublicFeed(any(), eq(0), eq(50), any(), any())).thenReturn(emptyPage);
        when(mockPostSvc.getPublicFeed(any(), eq(0), eq(1), any(), any())).thenReturn(emptyPage);

        CommunityFeedController controller = new CommunityFeedController(
                mockPostSvc, interactionService, mock(CommunityTrendingService.class));
        UserDetailsImpl principal = new UserDetailsImpl(100L, "author@example.test", "x", List.of());

        controller.getDiscoverFeed(principal, -5, 500, null, null);
        verify(mockPostSvc).getPublicFeed(100L, 0, 50, null, null);

        controller.getDiscoverFeed(principal, -1, 0, null, null);
        verify(mockPostSvc).getPublicFeed(100L, 0, 1, null, null);
    }

    @Test
    @DisplayName("SOC-11 & SOC-06 & SOC-07: Ordinary group MEMBER blocked from addMembers; blocked invite rejected; restricted typing suppressed")
    void messengerGroupRoleBlockInviteAndRestrictHardening() {
        MessengerRepository repo = mock(MessengerRepository.class);
        MessengerRooms roomsRepo = mock(MessengerRooms.class);
        MessengerFiles files = mock(MessengerFiles.class);
        MessengerPush push = mock(MessengerPush.class);
        ArenaInvites arena = mock(ArenaInvites.class);
        TransactionTemplate tx = mock(TransactionTemplate.class);
        MessengerLoad load = new MessengerLoad(null);

        MessengerService messengerService = new MessengerService(
                repo, roomsRepo, files, push, arena, notificationService, interactionService, tx, load);
        MessengerRoomService roomService = new MessengerRoomService(
                messengerService, repo, roomsRepo, files, push, tx, load);

        // SOC-11: Ordinary MEMBER rejected with 403 NOT_ALLOWED on addMembers
        UUID groupId = UUID.randomUUID();
        MessengerRooms.GroupSide memberSide = new MessengerRooms.GroupSide(
                groupId, 52L, "MEMBER", 0L, 0L, "Study", "pearl", false, 0,
                null, false, false, false, 3, 1L, "Learner 52", "u52@x.test", false
        );
        when(repo.side(52L, groupId)).thenReturn(Optional.empty());
        when(roomsRepo.member(52L, groupId)).thenReturn(Optional.of(memberSide));

        assertThatThrownBy(() -> roomService.addMembers(52L, groupId, new MembersRequest(List.of(55L))))
                .isInstanceOf(MessengerException.class)
                .hasMessage("NOT_ALLOWED")
                .satisfies(ex -> assertThat(ReflectionTestUtils.getField(ex, "status")).isEqualTo(403));

        // SOC-06: Invite accept rejected when pair is blocked
        UUID inviteId = UUID.randomUUID();
        UUID convId = UUID.randomUUID();
        MessengerRepository.InviteRow inviteRow = new MessengerRepository.InviteRow(
                inviteId, convId, 10L, 20L, "FREE", "PENDING", null, Instant.now().plusSeconds(120), null);
        when(repo.inviteFor(20L, inviteId)).thenReturn(Optional.of(inviteRow));
        when(repo.blockedEitherWay(10L, 20L)).thenReturn(true);

        assertThatThrownBy(() -> messengerService.accept(20L, inviteId))
                .isInstanceOf(MessengerException.class)
                .hasMessage("UNAVAILABLE")
                .satisfies(ex -> assertThat(ReflectionTestUtils.getField(ex, "status")).isEqualTo(403));
        verify(repo).respond(inviteId, "CANCELLED", null);
        verifyNoInteractions(arena);

        // SOC-07: Typing indicator suppressed when recipient restricts sender
        UUID restrictedConv = UUID.randomUUID();
        MessengerRepository.Side restrictedSide = new MessengerRepository.Side(
                restrictedConv, 30L, 31L, "u31@x.test", "Learner 31", false, true,
                true, false, false, false, false, 0L,
                "ACCEPTED", null, "EVERYONE", "u31", "u30@x.test", "Learner 30",
                false, null, false, true, "pearl", 5L
        );
        when(repo.side(30L, restrictedConv)).thenReturn(Optional.of(restrictedSide));
        messengerService.typing(30L, restrictedConv);
        verify(push, never()).send(eq("u31@x.test"), any());
    }

    @Test
    @DisplayName("EC-SEC-2026-021 & WS-09: Malformed save.done=1 does not throw TypeError or poison EchoLifeWorkshop pool, and attendedEvent is non-transactional")
    void malformedSaveDoneDoesNotThrowOrPoisonEchoLifeWorkshopPool() throws Exception {
        // Verify attendedEvent does not hold a DB transaction across GraalJS execution
        assertThat(EchoLifeGameService.class
                .getMethod("attendedEvent", long.class, String.class)
                .isAnnotationPresent(Transactional.class)).isFalse();

        ObjectMapper mapper = new ObjectMapper();
        // Warm up once with a valid shape so pool is initialized
        ObjectNode warmupSave = mapper.createObjectNode()
                .put("version", 4).put("owner", "u1").put("clock", 600).put("day", 1);
        warmupSave.putArray("done");
        warmupSave.putObject("worldV3").putArray("eventsAttended");
        ObjectNode warmupInput = mapper.createObjectNode().put("eventId", "evt_connection_festival");
        warmupInput.set("save", warmupSave);
        EchoLifeWorkshop.attendedEvent(mapper, warmupInput);

        long recyclesBefore = EchoLifeWorkshop.stats().recycles();

        // Now pass malformed save.done = 1 (primitive integer instead of array) directly to rules.js
        ObjectNode poisonedSave = mapper.createObjectNode()
                .put("version", 4).put("owner", "u1").put("clock", 600).put("day", 1)
                .put("done", 1);
        poisonedSave.putObject("worldV3").putArray("eventsAttended").add("evt_connection_festival@day1");
        ObjectNode poisonedInput = mapper.createObjectNode().put("eventId", "evt_connection_festival");
        poisonedInput.set("save", poisonedSave);

        JsonNode result = EchoLifeWorkshop.attendedEvent(mapper, poisonedInput);
        assertThat(result.isNull()).isTrue();
        assertThat(EchoLifeWorkshop.stats().recycles())
                .as("Malformed save.done must not throw TypeError or force context recycle / pool poisoning")
                .isEqualTo(recyclesBefore);
    }
}
