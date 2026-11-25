package com.englishcoach.notification.service;

import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.dto.NotificationEnvelope;
import com.englishcoach.notification.entity.Notification;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.repository.NotificationRepository;
import com.englishcoach.notification.repository.NotificationUserStateRepository;
import com.englishcoach.auth.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;

import java.time.Instant;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class NotificationPlatformTest {

    @Mock
    private NotificationRepository notificationRepository;

    @Mock
    private NotificationUserStateRepository notificationUserStateRepository;

    @Mock
    private UserRepository userRepository;

    @Mock
    private NotificationPushPublisher pushPublisher;

    private NotificationServiceImpl notificationService;

    private final Long userId = 42L;

    @BeforeEach
    void setUp() {
        notificationService = new NotificationServiceImpl(
                notificationRepository,
                notificationUserStateRepository,
                userRepository,
                null,
                pushPublisher
        );
    }

    @Test
    @DisplayName("P0-C: Persists category, is_read=false, System sender branding")
    void testCreate_PersistsCorrectFields() {
        CreateNotificationCommand cmd = new CreateNotificationCommand(
                userId,
                NotificationCategory.STREAK,
                NotificationType.LEARNING_REMINDER,
                "Duy trì streak 5 ngày",
                "Bạn đã duy trì streak 5 ngày liên tiếp!",
                "/dashboard",
                "STREAK_EXTENDED:2026-09-30"
        );

        when(notificationRepository.existsByUserIdAndDedupeKey(eq(userId), eq("STREAK_EXTENDED:2026-09-30")))
                .thenReturn(false);

        when(notificationRepository.insertUserNotificationIdempotent(
                eq("LEARNING_REMINDER"),
                eq("STREAK"),
                eq(userId),
                eq(NotificationTemplates.BRANDING_SENDER),
                eq("Duy trì streak 5 ngày"),
                eq("Bạn đã duy trì streak 5 ngày liên tiếp!"),
                eq("/dashboard"),
                eq("STREAK_EXTENDED:2026-09-30"),
                any(Instant.class)
        )).thenReturn(Optional.of(101L));

        when(notificationRepository.countUnreadForUser(eq(userId), any(Instant.class))).thenReturn(1L);

        Optional<Notification> result = notificationService.create(cmd);

        assertThat(result).isPresent();
        Notification n = result.get();
        assertThat(n.getCategory()).isEqualTo(NotificationCategory.STREAK);
        assertThat(n.getSender()).isEqualTo(NotificationTemplates.BRANDING_SENDER);
        assertThat(n.getSender()).doesNotContain("AI Coach");
        assertThat(n.isRead()).isFalse();
        assertThat(n.getDedupeKey()).isEqualTo("STREAK_EXTENDED:2026-09-30");
        assertThat(n.getActionUrl()).isEqualTo("/dashboard");

        verify(pushPublisher, times(1)).publishCreated(eq(userId), eq(n), eq(1L));
    }

    @Test
    @DisplayName("P0-C: Duplicate dedupe_key via repository check is idempotent no-op and no push")
    void testCreate_DuplicateDedupeKey_FastPathNoOp() {
        CreateNotificationCommand cmd = new CreateNotificationCommand(
                userId,
                NotificationCategory.MILESTONE,
                NotificationType.LEARNING_REMINDER,
                "Hoàn thành bài thi",
                "Chúc mừng bạn!",
                "/exams",
                "EXAM_COMPLETED:att-123"
        );

        when(notificationRepository.existsByUserIdAndDedupeKey(eq(userId), eq("EXAM_COMPLETED:att-123")))
                .thenReturn(true);

        Optional<Notification> result = notificationService.create(cmd);

        assertThat(result).isEmpty();
        verify(notificationRepository, never()).insertUserNotificationIdempotent(
                any(), any(), any(), any(), any(), any(), any(), any(), any());
        verify(pushPublisher, never()).publishCreated(anyLong(), any(), anyLong());
    }

    @Test
    @DisplayName("P0-C: Duplicate key conflict via ON CONFLICT DO NOTHING is handled cleanly without 25P02 exception")
    void testCreate_DuplicateKeyDataIntegrityException_HandledSilently() {
        CreateNotificationCommand cmd = new CreateNotificationCommand(
                userId,
                NotificationCategory.MILESTONE,
                NotificationType.LEARNING_REMINDER,
                "Hoàn thành bài thi",
                "Chúc mừng bạn!",
                "/exams",
                "EXAM_COMPLETED:att-123"
        );

        when(notificationRepository.existsByUserIdAndDedupeKey(eq(userId), eq("EXAM_COMPLETED:att-123")))
                .thenReturn(false);

        when(notificationRepository.insertUserNotificationIdempotent(
                any(), any(), eq(userId), any(), any(), any(), any(), eq("EXAM_COMPLETED:att-123"), any(Instant.class)
        )).thenReturn(Optional.empty());

        Optional<Notification> result = notificationService.create(cmd);

        assertThat(result).isEmpty();
        verify(pushPublisher, never()).publishCreated(anyLong(), any(), anyLong());
    }

    @Test
    @DisplayName("P0-E: Push failure is isolated and never throws upward; row remains persisted")
    void testCreate_PushFailure_IsIsolated() {
        CreateNotificationCommand cmd = new CreateNotificationCommand(
                userId,
                NotificationCategory.SYSTEM,
                NotificationType.SYSTEM_UPDATE,
                "Hệ thống bảo trì",
                "Hệ thống sẽ cập nhật vào lúc 00:00",
                "/status",
                "MAINTENANCE:001"
        );

        when(notificationRepository.existsByUserIdAndDedupeKey(anyLong(), anyString())).thenReturn(false);

        when(notificationRepository.insertUserNotificationIdempotent(
                any(), any(), eq(userId), any(), any(), any(), any(), eq("MAINTENANCE:001"), any(Instant.class)
        )).thenReturn(Optional.of(202L));

        doThrow(new RuntimeException("Simulated broker disconnect"))
                .when(pushPublisher).publishCreated(anyLong(), any(), anyLong());

        assertThatCode(() -> {
            Optional<Notification> res = notificationService.create(cmd);
            assertThat(res).isPresent();
            assertThat(res.get().getId()).isEqualTo(202L);
        }).doesNotThrowAnyException();
    }

    @Test
    @DisplayName("P0-B & P0-C: actionUrl validation enforces internal route rules (starts with single /, no //, no scheme)")
    void testActionUrlValidation() {
        assertThat(NotificationServiceImpl.isValidActionUrl("/flashcards")).isTrue();
        assertThat(NotificationServiceImpl.isValidActionUrl("/exams/123/results")).isTrue();
        assertThat(NotificationServiceImpl.isValidActionUrl("")).isTrue();
        assertThat(NotificationServiceImpl.isValidActionUrl(null)).isTrue();

        // Invalid: external, scheme, double slash, xss
        assertThat(NotificationServiceImpl.isValidActionUrl("//evil.com")).isFalse();
        assertThat(NotificationServiceImpl.isValidActionUrl("https://evil.com")).isFalse();
        assertThat(NotificationServiceImpl.isValidActionUrl("http://evil.com")).isFalse();
        assertThat(NotificationServiceImpl.isValidActionUrl("javascript:alert(1)")).isFalse();
        assertThat(NotificationServiceImpl.isValidActionUrl("data:text/html,bad")).isFalse();
        assertThat(NotificationServiceImpl.isValidActionUrl("flashcards")).isFalse();
    }

    @Test
    @DisplayName("P0-F: markAsRead and markAllAsRead update repository and emit sync events")
    void testMarkAsRead_EmitsSyncEvent() {
        Long notifId = 303L;
        when(notificationRepository.isNotificationAccessibleToUser(eq(notifId), eq(userId), any(Instant.class)))
                .thenReturn(true);
        when(notificationRepository.countUnreadForUser(eq(userId), any(Instant.class)))
                .thenReturn(2L);

        notificationService.markAsRead(userId, notifId);

        verify(notificationRepository).markNotificationAsRead(eq(notifId), eq(userId), any(Instant.class));
        verify(pushPublisher).publishRead(eq(userId), eq(notifId), eq(2L));
    }

    @Test
    @DisplayName("P0-F: markAllAsRead emits sync event")
    void testMarkAllAsRead_EmitsSyncEvent() {
        notificationService.markAllAsRead(userId);

        verify(notificationRepository).markAllNotificationsAsReadForUser(eq(userId), any(Instant.class));
        verify(pushPublisher).publishAllRead(eq(userId));
    }

    @Test
    @DisplayName("P0-C: Retention cleanup calls repository delete and prune methods")
    void testRetentionCleanup() {
        when(notificationRepository.deleteReadNotificationsOlderThan(any(Instant.class))).thenReturn(15);
        when(notificationRepository.pruneUserNotificationsOverCap(eq(300))).thenReturn(5);

        notificationService.cleanupOldReadNotifications();
        notificationService.pruneUserNotificationsCap(300);

        verify(notificationRepository).deleteReadNotificationsOlderThan(any(Instant.class));
        verify(notificationRepository).pruneUserNotificationsOverCap(300);
    }
}
