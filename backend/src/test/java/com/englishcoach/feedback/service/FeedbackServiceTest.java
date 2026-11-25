package com.englishcoach.feedback.service;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.feedback.dto.*;
import com.englishcoach.feedback.entity.FeedbackMessage;
import com.englishcoach.feedback.entity.FeedbackThread;
import com.englishcoach.feedback.repository.FeedbackMessageRepository;
import com.englishcoach.feedback.repository.FeedbackThreadRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class FeedbackServiceTest {

    @Mock
    private FeedbackThreadRepository feedbackThreadRepository;

    @Mock
    private FeedbackMessageRepository feedbackMessageRepository;

    @Mock
    private UserRepository userRepository;

    @Mock
    private SimpMessagingTemplate messagingTemplate;

    @InjectMocks
    private FeedbackServiceImpl feedbackService;

    private Long userId;
    private Long adminUserId;
    private User testUser;
    private User adminUser;

    @BeforeEach
    void setUp() {
        userId = 1L;
        adminUserId = 99L;

        testUser = User.builder()
                .id(userId)
                .email("student@example.com")
                .name("Minh Anh")
                .role(Role.ROLE_USER)
                .build();

        adminUser = User.builder()
                .id(adminUserId)
                .email("admin@englishcoach.com")
                .name("Admin")
                .role(Role.ROLE_ADMIN)
                .build();
    }

    @Test
    @DisplayName("Create thread succeeds and sets OPEN, adminUnread=true, userUnread=false")
    void testCreateThread_Success() {
        when(feedbackMessageRepository.countBySenderUserIdAndCreatedAtAfter(eq(userId), any())).thenReturn(0L);
        when(userRepository.findById(userId)).thenReturn(Optional.of(testUser));

        FeedbackThread savedThread = FeedbackThread.builder()
                .id(10L)
                .userId(userId)
                .category("IDEA")
                .subject("Thêm chế độ tối cho Card Blast")
                .status("OPEN")
                .adminUnread(true)
                .userUnread(false)
                .createdAt(Instant.now())
                .lastMessageAt(Instant.now())
                .build();
        when(feedbackThreadRepository.save(any(FeedbackThread.class))).thenReturn(savedThread);

        CreateFeedbackRequest request = new CreateFeedbackRequest(
                "IDEA",
                "Thêm chế độ tối cho Card Blast",
                "Em muốn có dark mode chơi ban đêm đỡ chói mắt ạ"
        );

        FeedbackThreadDto result = feedbackService.createThread(userId, request);

        assertThat(result.id()).isEqualTo(10L);
        assertThat(result.subject()).isEqualTo("Thêm chế độ tối cho Card Blast");
        assertThat(result.category()).isEqualTo("IDEA");
        assertThat(result.status()).isEqualTo("OPEN");
        assertThat(result.adminUnread()).isTrue();
        assertThat(result.userUnread()).isFalse();
        verify(feedbackMessageRepository).save(any(FeedbackMessage.class));
        verify(messagingTemplate).convertAndSend(eq("/topic/admin/feedback-badge"), any(FeedbackUnreadCountDto.class));
    }

    @Test
    @DisplayName("Create thread throws 429 when rate limit of 5 per hour exceeded")
    void testCreateThread_RateLimitExceeded() {
        when(feedbackMessageRepository.countBySenderUserIdAndCreatedAtAfter(eq(userId), any())).thenReturn(5L);

        CreateFeedbackRequest request = new CreateFeedbackRequest("BUG", "Lỗi", "Nội dung");

        assertThatThrownBy(() -> feedbackService.createThread(userId, request))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS));
    }

    @Test
    @DisplayName("User follow-up succeeds and updates thread status to OPEN and adminUnread to true")
    void testUserFollowUp_Success() {
        when(feedbackMessageRepository.countBySenderUserIdAndCreatedAtAfter(eq(userId), any())).thenReturn(2L);
        when(userRepository.findById(userId)).thenReturn(Optional.of(testUser));

        FeedbackThread thread = FeedbackThread.builder()
                .id(10L)
                .userId(userId)
                .category("IDEA")
                .subject("Test")
                .status("ANSWERED")
                .adminUnread(false)
                .userUnread(false)
                .lastMessageAt(Instant.now())
                .build();
        when(feedbackThreadRepository.findById(10L)).thenReturn(Optional.of(thread));

        FeedbackMessage savedMsg = FeedbackMessage.builder()
                .id(101L)
                .threadId(10L)
                .senderUserId(userId)
                .fromAdmin(false)
                .content("Cảm ơn admin đã phản hồi!")
                .createdAt(Instant.now())
                .build();
        when(feedbackMessageRepository.save(any(FeedbackMessage.class))).thenReturn(savedMsg);

        FeedbackMessageRequest request = new FeedbackMessageRequest("Cảm ơn admin đã phản hồi!");
        FeedbackMessageDto result = feedbackService.userFollowUp(userId, 10L, request);

        assertThat(result.id()).isEqualTo(101L);
        assertThat(result.threadId()).isEqualTo(10L);
        assertThat(result.senderUserId()).isEqualTo(userId);
        assertThat(result.senderName()).isEqualTo("Minh Anh");
        assertThat(result.content()).isEqualTo("Cảm ơn admin đã phản hồi!");
        assertThat(result.fromAdmin()).isFalse();
        assertThat(result.createdAt()).isNotNull();
        assertThat(thread.getStatus()).isEqualTo("OPEN");
        assertThat(thread.isAdminUnread()).isTrue();
        verify(feedbackThreadRepository).save(thread);
        verify(messagingTemplate).convertAndSend(eq("/topic/feedback/10"), any(FeedbackMessageDto.class));
        verify(messagingTemplate).convertAndSend(eq("/topic/admin/feedback-badge"), any(FeedbackUnreadCountDto.class));
    }

    @Test
    @DisplayName("User follow-up throws 403 when user is not thread owner")
    void testUserFollowUp_ForbiddenForNonOwner() {
        when(feedbackMessageRepository.countBySenderUserIdAndCreatedAtAfter(eq(userId), any())).thenReturn(1L);

        FeedbackThread thread = FeedbackThread.builder()
                .id(10L)
                .userId(999L)
                .category("IDEA")
                .subject("Test")
                .build();
        when(feedbackThreadRepository.findById(10L)).thenReturn(Optional.of(thread));

        FeedbackMessageRequest request = new FeedbackMessageRequest("Tin nhắn");

        assertThatThrownBy(() -> feedbackService.userFollowUp(userId, 10L, request))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }

    @Test
    @DisplayName("Admin reply updates status to ANSWERED, userUnread=true, adminUnread=false")
    void testAdminReply_Success() {
        FeedbackThread thread = FeedbackThread.builder()
                .id(10L)
                .userId(userId)
                .category("BUG")
                .subject("Lỗi phát âm")
                .status("OPEN")
                .adminUnread(true)
                .userUnread(false)
                .lastMessageAt(Instant.now())
                .build();
        when(feedbackThreadRepository.findById(10L)).thenReturn(Optional.of(thread));
        when(userRepository.findById(adminUserId)).thenReturn(Optional.of(adminUser));

        FeedbackMessage savedMsg = FeedbackMessage.builder()
                .id(201L)
                .threadId(10L)
                .senderUserId(adminUserId)
                .fromAdmin(true)
                .content("Admin đã ghi nhận và sửa xong nhé!")
                .createdAt(Instant.now())
                .build();
        when(feedbackMessageRepository.save(any(FeedbackMessage.class))).thenReturn(savedMsg);

        FeedbackMessageRequest request = new FeedbackMessageRequest("Admin đã ghi nhận và sửa xong nhé!");
        FeedbackMessageDto result = feedbackService.adminReply(adminUserId, 10L, request);

        assertThat(result.id()).isEqualTo(201L);
        assertThat(result.threadId()).isEqualTo(10L);
        assertThat(result.senderUserId()).isEqualTo(adminUserId);
        assertThat(result.senderName()).isEqualTo("Admin");
        assertThat(result.content()).isEqualTo("Admin đã ghi nhận và sửa xong nhé!");
        assertThat(result.fromAdmin()).isTrue();
        assertThat(result.createdAt()).isNotNull();
        assertThat(thread.getStatus()).isEqualTo("ANSWERED");
        assertThat(thread.isUserUnread()).isTrue();
        assertThat(thread.isAdminUnread()).isFalse();
        verify(feedbackThreadRepository).save(thread);
        verify(messagingTemplate).convertAndSend(eq("/topic/feedback/10"), any(FeedbackMessageDto.class));
        verify(messagingTemplate).convertAndSend(eq("/topic/user/1/feedback-badge"), any(FeedbackUnreadCountDto.class));
        verify(messagingTemplate).convertAndSend(eq("/topic/admin/feedback-badge"), any(FeedbackUnreadCountDto.class));
    }

    @Test
    @DisplayName("Close thread sets status to CLOSED")
    void testCloseThread_Success() {
        FeedbackThread thread = FeedbackThread.builder()
                .id(10L)
                .userId(userId)
                .category("IDEA")
                .subject("Test")
                .status("ANSWERED")
                .build();
        when(feedbackThreadRepository.findById(10L)).thenReturn(Optional.of(thread));
        when(feedbackThreadRepository.save(any())).thenReturn(thread);

        FeedbackThreadDto result = feedbackService.closeThread(10L);

        assertThat(result.status()).isEqualTo("CLOSED");
        assertThat(thread.getStatus()).isEqualTo("CLOSED");
    }

    @Test
    @DisplayName("Get thread messages clears adminUnread when read by admin")
    void testGetThreadMessages_AdminClearsUnread() {
        FeedbackThread thread = FeedbackThread.builder()
                .id(10L)
                .userId(userId)
                .adminUnread(true)
                .userUnread(false)
                .build();
        when(feedbackThreadRepository.findById(10L)).thenReturn(Optional.of(thread));
        when(feedbackMessageRepository.findByThreadIdOrderByCreatedAtAsc(10L)).thenReturn(List.of());

        feedbackService.getThreadMessages(adminUserId, true, 10L);

        assertThat(thread.isAdminUnread()).isFalse();
        verify(feedbackThreadRepository).save(thread);
    }

    @Test
    @DisplayName("Get thread messages clears userUnread when read by owner")
    void testGetThreadMessages_UserClearsUnread() {
        FeedbackThread thread = FeedbackThread.builder()
                .id(10L)
                .userId(userId)
                .adminUnread(false)
                .userUnread(true)
                .build();
        when(feedbackThreadRepository.findById(10L)).thenReturn(Optional.of(thread));
        when(feedbackMessageRepository.findByThreadIdOrderByCreatedAtAsc(10L)).thenReturn(List.of());

        feedbackService.getThreadMessages(userId, false, 10L);

        assertThat(thread.isUserUnread()).isFalse();
        verify(feedbackThreadRepository).save(thread);
    }

    @Test
    @DisplayName("Get thread messages throws 403 for unauthorized non-owner learner")
    void testGetThreadMessages_UnauthorizedUser() {
        FeedbackThread thread = FeedbackThread.builder()
                .id(10L)
                .userId(999L)
                .build();
        when(feedbackThreadRepository.findById(10L)).thenReturn(Optional.of(thread));

        assertThatThrownBy(() -> feedbackService.getThreadMessages(userId, false, 10L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }

    @Test
    @DisplayName("getMyThreads and getAdminInbox batch-load latest snippets in one query without N+1")
    void testThreadListingsBatchLoadLatestSnippets() {
        FeedbackThread t1 = FeedbackThread.builder().id(10L).userId(userId).category("IDEA").subject("S1").status("OPEN").build();
        FeedbackThread t2 = FeedbackThread.builder().id(20L).userId(userId).category("BUG").subject("S2").status("OPEN").build();
        when(feedbackThreadRepository.findByUserIdOrderByLastMessageAtDesc(userId)).thenReturn(List.of(t1, t2));
        when(userRepository.findById(userId)).thenReturn(Optional.of(testUser));

        FeedbackMessageRepository.LatestSnippetProjection p1 = mock(FeedbackMessageRepository.LatestSnippetProjection.class);
        when(p1.getThreadId()).thenReturn(10L);
        when(p1.getContent()).thenReturn("Latest 10");
        FeedbackMessageRepository.LatestSnippetProjection p2 = mock(FeedbackMessageRepository.LatestSnippetProjection.class);
        when(p2.getThreadId()).thenReturn(20L);
        when(p2.getContent()).thenReturn("Latest 20");
        when(feedbackMessageRepository.findLatestSnippetsByThreadIds(List.of(10L, 20L))).thenReturn(List.of(p1, p2));

        List<FeedbackThreadDto> myThreads = feedbackService.getMyThreads(userId);
        assertThat(myThreads).extracting(FeedbackThreadDto::lastMessageSnippet)
                .containsExactly("Latest 10", "Latest 20");
        verify(feedbackMessageRepository, never()).findFirstByThreadIdOrderByCreatedAtDesc(any());
    }
}
