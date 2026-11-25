package com.englishcoach.notification.service;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.notification.dto.AdminCreateNotificationRequest;
import com.englishcoach.notification.dto.AdminNotificationDto;
import com.englishcoach.notification.dto.LearnerNotificationDto;
import com.englishcoach.notification.dto.UnreadCountDto;
import com.englishcoach.notification.entity.Notification;
import com.englishcoach.notification.entity.NotificationScope;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.repository.LearnerNotificationProjection;
import com.englishcoach.notification.repository.NotificationRepository;
import com.englishcoach.notification.repository.NotificationUserStateRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class NotificationServiceTest {

    @Mock
    private NotificationRepository notificationRepository;

    @Mock
    private NotificationUserStateRepository notificationUserStateRepository;

    @Mock
    private UserRepository userRepository;

    @Mock
    private SimpMessagingTemplate messagingTemplate;

    @InjectMocks
    private NotificationServiceImpl notificationService;

    private Long adminUserId;
    private Long userAId;
    private Long userBId;
    private User userB;

    @BeforeEach
    void setUp() {
        adminUserId = 100L;
        userAId = 1L;
        userBId = 2L;
        userB = User.builder()
                .id(userBId)
                .email("userb@example.com")
                .emailNormalized("userb@example.com")
                .name("User B")
                .role(Role.ROLE_USER)
                .build();
    }

    @Test
    @DisplayName("1 & 2: GLOBAL notification stored as ONE row and does NOT fan out user states")
    void testCreateGlobalNotification_StoredAsOneRow_NoFanout() {
        AdminCreateNotificationRequest request = new AdminCreateNotificationRequest(
                NotificationScope.GLOBAL,
                NotificationType.SYSTEM_UPDATE,
                "System Maintenance",
                "Maintenance planned at midnight",
                "/status",
                Instant.now(),
                Instant.now().plus(2, ChronoUnit.DAYS),
                null
        );

        when(notificationRepository.save(any(Notification.class))).thenAnswer(invocation -> {
            Notification n = invocation.getArgument(0);
            n.setId(99L);
            return n;
        });

        AdminNotificationDto result = notificationService.createNotificationByAdmin(adminUserId, request);

        assertThat(result.id()).isEqualTo(99L);
        assertThat(result.scope()).isEqualTo("GLOBAL");
        assertThat(result.targetEmail()).isNull();

        // Verify save called exactly ONCE on notifications table
        verify(notificationRepository, times(1)).save(any(Notification.class));
        // Verify NO interaction with notificationUserStateRepository (Zero fanout)
        verifyNoInteractions(notificationUserStateRepository);
    }

    @Test
    @DisplayName("3: USER notification resolves exact target email")
    void testCreateUserNotification_ResolvesExactTargetEmail() {
        AdminCreateNotificationRequest request = new AdminCreateNotificationRequest(
                NotificationScope.USER,
                NotificationType.EVENT,
                "Welcome Event",
                "Special event for you",
                "/events/1",
                Instant.now(),
                null,
                "UserB@example.com " // Needs trimming & normalization
        );

        when(userRepository.findByEmailNormalized("userb@example.com")).thenReturn(Optional.of(userB));
        when(notificationRepository.save(any(Notification.class))).thenAnswer(invocation -> {
            Notification n = invocation.getArgument(0);
            n.setId(101L);
            return n;
        });

        AdminNotificationDto result = notificationService.createNotificationByAdmin(adminUserId, request);

        assertThat(result.id()).isEqualTo(101L);
        assertThat(result.scope()).isEqualTo("USER");
        assertThat(result.targetEmail()).isEqualTo("userb@example.com");

        ArgumentCaptor<Notification> captor = ArgumentCaptor.forClass(Notification.class);
        verify(notificationRepository).save(captor.capture());
        assertThat(captor.getValue().getTargetUserId()).isEqualTo(userBId);
    }

    @Test
    @DisplayName("4: USER notification requires target email")
    void testCreateUserNotification_RequiresTargetEmail() {
        AdminCreateNotificationRequest request = new AdminCreateNotificationRequest(
                NotificationScope.USER,
                NotificationType.EVENT,
                "Welcome Event",
                "Special event for you",
                null,
                null,
                null,
                "   "
        );

        assertThatThrownBy(() -> notificationService.createNotificationByAdmin(adminUserId, request))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Target email is required");
    }

    @Test
    @DisplayName("5: GLOBAL rejects target email")
    void testCreateGlobalNotification_RejectsTargetEmail() {
        AdminCreateNotificationRequest request = new AdminCreateNotificationRequest(
                NotificationScope.GLOBAL,
                NotificationType.SYSTEM_UPDATE,
                "Global update",
                "For everyone",
                null,
                null,
                null,
                "someuser@example.com"
        );

        assertThatThrownBy(() -> notificationService.createNotificationByAdmin(adminUserId, request))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("targetEmail must be empty when notification scope is GLOBAL");
    }

    @Test
    @DisplayName("16: Action URL rejects external or unsafe URL")
    void testCreateNotification_RejectsExternalActionUrl() {
        List<String> unsafeUrls = List.of(
                "https://evil.com/phish",
                "http://insecure.com",
                "//protocol-relative.com",
                "javascript:alert(1)",
                "data:text/html,bad",
                "relative/without/leading/slash"
        );

        for (String unsafeUrl : unsafeUrls) {
            AdminCreateNotificationRequest request = new AdminCreateNotificationRequest(
                    NotificationScope.GLOBAL,
                    NotificationType.SYSTEM_UPDATE,
                    "Title",
                    "Body text",
                    unsafeUrl,
                    null,
                    null,
                    null
            );

            assertThatThrownBy(() -> notificationService.createNotificationByAdmin(adminUserId, request))
                    .isInstanceOf(ResponseStatusException.class)
                    .hasMessageContaining("Invalid actionUrl");
        }
    }

    @Test
    @DisplayName("Action URL accepts valid internal path")
    void testCreateNotification_AcceptsValidInternalActionUrl() {
        List<String> validUrls = List.of(
                "/profile",
                "/flashcards",
                "/writing",
                "/exams/123",
                "/speaking?tab=shadowing"
        );

        when(notificationRepository.save(any(Notification.class))).thenAnswer(invocation -> {
            Notification n = invocation.getArgument(0);
            n.setId(1L);
            return n;
        });

        for (String validUrl : validUrls) {
            AdminCreateNotificationRequest request = new AdminCreateNotificationRequest(
                    NotificationScope.GLOBAL,
                    NotificationType.SYSTEM_UPDATE,
                    "Title",
                    "Body text",
                    validUrl,
                    null,
                    null,
                    null
            );

            AdminNotificationDto result = notificationService.createNotificationByAdmin(adminUserId, request);
            assertThat(result.actionUrl()).isEqualTo(validUrl);
        }
        verify(messagingTemplate, atLeastOnce()).convertAndSend(eq("/topic/notifications/broadcast"), anyMap());
    }

    @Test
    @DisplayName("ExpiresAt must be after publishAt")
    void testCreateNotification_ExpiresAtBeforePublishAt_Throws() {
        Instant now = Instant.now();
        AdminCreateNotificationRequest request = new AdminCreateNotificationRequest(
                NotificationScope.GLOBAL,
                NotificationType.SYSTEM_UPDATE,
                "Title",
                "Body text",
                "/path",
                now,
                now.minus(1, ChronoUnit.HOURS),
                null
        );

        assertThatThrownBy(() -> notificationService.createNotificationByAdmin(adminUserId, request))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("expiresAt must be after publishAt");
    }

    @Test
    @DisplayName("Learner: Unread count uses direct repository count query")
    void testGetUnreadCount_ReturnsCount() {
        when(notificationRepository.countUnreadForUser(eq(userAId), any(Instant.class)))
                .thenReturn(3L);

        UnreadCountDto unreadCount = notificationService.getUnreadCount(userAId);
        assertThat(unreadCount.unreadCount()).isEqualTo(3L);
        verify(notificationRepository).countUnreadForUser(eq(userAId), any(Instant.class));
    }

    @Test
    @DisplayName("13: Mark as read calls repository upsert and is idempotent")
    void testMarkAsRead_CallsRepositoryUpsert() {
        Long notifId = 42L;
        when(notificationRepository.isNotificationAccessibleToUser(eq(notifId), eq(userAId), any(Instant.class)))
                .thenReturn(true);

        notificationService.markAsRead(userAId, notifId);

        verify(notificationUserStateRepository, times(1))
                .markAsRead(eq(notifId), eq(userAId), any(Instant.class));

        // Call a second time - idempotent
        notificationService.markAsRead(userAId, notifId);
        verify(notificationUserStateRepository, times(2))
                .markAsRead(eq(notifId), eq(userAId), any(Instant.class));
    }

    @Test
    @DisplayName("14: Dismiss calls repository upsert and is idempotent")
    void testDismiss_CallsRepositoryUpsert() {
        Long notifId = 42L;
        when(notificationRepository.isNotificationAccessibleToUser(eq(notifId), eq(userAId), any(Instant.class)))
                .thenReturn(true);

        notificationService.dismiss(userAId, notifId);

        verify(notificationUserStateRepository, times(1))
                .dismiss(eq(notifId), eq(userAId), any(Instant.class));

        // Call a second time - idempotent
        notificationService.dismiss(userAId, notifId);
        verify(notificationUserStateRepository, times(2))
                .dismiss(eq(notifId), eq(userAId), any(Instant.class));
    }

    @Test
    @DisplayName("15: Mark all as read calls repository batch upsert")
    void testMarkAllAsRead_CallsRepositoryBatchUpsert() {
        notificationService.markAllAsRead(userAId);

        verify(notificationUserStateRepository, times(1))
                .markAllAsReadForUser(eq(userAId), any(Instant.class));
    }

    @Test
    @DisplayName("8: User cannot read or dismiss another user's targeted notification")
    void testMarkAsRead_NotVisible_Throws404() {
        Long notifId = 999L;
        when(notificationRepository.isNotificationAccessibleToUser(eq(notifId), eq(userAId), any(Instant.class)))
                .thenReturn(false);

        assertThatThrownBy(() -> notificationService.markAsRead(userAId, notifId))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Notification not found or not accessible");

        verify(notificationUserStateRepository, never()).markAsRead(any(), any(), any());
    }

    @Test
    @DisplayName("Limit is properly bounded between default 20 and max 50")
    void testGetLearnerNotifications_BoundsLimit() {
        when(notificationRepository.findAllNonExpiredGlobalNotifications(any(Instant.class)))
                .thenReturn(List.of());
        when(notificationRepository.findVisibleUserScopedNotifications(eq(userAId), any(Instant.class), eq(50)))
                .thenReturn(List.of());

        notificationService.getLearnerNotifications(userAId, 100); // Exceeds 50
        verify(notificationRepository).findVisibleUserScopedNotifications(eq(userAId), any(Instant.class), eq(50));

        when(notificationRepository.findVisibleUserScopedNotifications(eq(userAId), any(Instant.class), eq(20)))
                .thenReturn(List.of());

        notificationService.getLearnerNotifications(userAId, null); // Default 20
        verify(notificationRepository).findVisibleUserScopedNotifications(eq(userAId), any(Instant.class), eq(20));
        // Raw GLOBAL metadata was served from the 60s shared cache on the second request
        verify(notificationRepository, times(1)).findAllNonExpiredGlobalNotifications(any(Instant.class));
    }

    @Test
    @DisplayName("GLOBAL metadata cache filters publishAt/expiresAt live and overlays live user states")
    void testGlobalCacheFiltersLiveAndOverlaysPerUserState() {
        Instant now = Instant.now();
        Notification activeGlobal = Notification.builder()
                .id(10L)
                .scope(NotificationScope.GLOBAL)
                .type(NotificationType.SYSTEM_UPDATE)
                .title("Live Global")
                .body("Visible now")
                .publishAt(now.minusSeconds(60))
                .expiresAt(now.plusSeconds(3600))
                .build();
        Notification scheduledGlobal = Notification.builder()
                .id(11L)
                .scope(NotificationScope.GLOBAL)
                .type(NotificationType.EVENT)
                .title("Future Global")
                .body("Not yet published")
                .publishAt(now.plusSeconds(3600))
                .build();
        Notification expiredGlobal = Notification.builder()
                .id(12L)
                .scope(NotificationScope.GLOBAL)
                .type(NotificationType.EVENT)
                .title("Expired Global")
                .body("Already expired")
                .publishAt(now.minusSeconds(7200))
                .expiresAt(now.minusSeconds(10))
                .build();

        when(notificationRepository.findAllNonExpiredGlobalNotifications(any(Instant.class)))
                .thenReturn(List.of(activeGlobal, scheduledGlobal, expiredGlobal));
        NotificationRepository.GlobalNotificationStateProjection readState =
                mock(NotificationRepository.GlobalNotificationStateProjection.class);
        when(readState.getNotificationId()).thenReturn(10L);
        when(readState.getIsRead()).thenReturn(true);
        when(readState.getIsDismissed()).thenReturn(false);
        when(notificationRepository.findUserStatesForNotifications(eq(userAId), eq(List.of(10L))))
                .thenReturn(List.of(readState));
        when(notificationRepository.findVisibleUserScopedNotifications(eq(userAId), any(Instant.class), eq(20)))
                .thenReturn(List.of());

        List<LearnerNotificationDto> list = notificationService.getLearnerNotifications(userAId, 20);
        assertThat(list).hasSize(1);
        assertThat(list.get(0).id()).isEqualTo(10L);
        assertThat(list.get(0).read()).isTrue();
    }
}
