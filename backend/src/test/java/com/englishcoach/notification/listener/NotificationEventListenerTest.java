package com.englishcoach.notification.listener;

import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.event.ExamCompletedNotificationEvent;
import com.englishcoach.notification.event.FlashcardSessionNotificationEvent;
import com.englishcoach.notification.event.StreakExtendedNotificationEvent;
import com.englishcoach.notification.service.NotificationService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDate;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class NotificationEventListenerTest {

    @Mock
    private NotificationService notificationService;

    private NotificationEventListener listener;

    private final Long userId = 42L;

    @BeforeEach
    void setUp() {
        listener = new NotificationEventListener(notificationService);
    }

    @Test
    @DisplayName("P0-E: onExamCompleted dispatches to NotificationService.create")
    void testOnExamCompleted() {
        UUID attemptId = UUID.randomUUID();
        ExamCompletedNotificationEvent event = new ExamCompletedNotificationEvent(
                userId, attemptId, "IELTS Academic Test 1", "7.5"
        );

        listener.onExamCompleted(event);

        ArgumentCaptor<CreateNotificationCommand> captor = ArgumentCaptor.forClass(CreateNotificationCommand.class);
        verify(notificationService, times(1)).create(captor.capture());

        CreateNotificationCommand cmd = captor.getValue();
        assertThat(cmd.userId()).isEqualTo(userId);
        assertThat(cmd.category()).isEqualTo(NotificationCategory.MILESTONE);
        assertThat(cmd.dedupeKey()).isEqualTo("EXAM_COMPLETED:" + attemptId);
        assertThat(cmd.content()).contains("7.5");
    }

    @Test
    @DisplayName("P0-E: onFlashcardSessionCompleted dispatches to NotificationService.create")
    void testOnFlashcardSessionCompleted() {
        FlashcardSessionNotificationEvent event = new FlashcardSessionNotificationEvent(
                userId, "DAILY_GOAL:2026-09-30", 25, LocalDate.of(2026, 9, 30)
        );
        org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate jdbc =
                org.mockito.Mockito.mock(org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate.class);
        org.springframework.test.util.ReflectionTestUtils.setField(listener, "jdbc", jdbc);
        // fewer reviews today than the milestone names: nothing is created
        when(jdbc.queryForObject(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.any(org.springframework.jdbc.core.namedparam.SqlParameterSource.class),
                org.mockito.ArgumentMatchers.eq(Long.class))).thenReturn(3L);
        listener.onFlashcardSessionCompleted(event);
        verify(notificationService, never()).create(org.mockito.ArgumentMatchers.any());

        when(jdbc.queryForObject(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.any(org.springframework.jdbc.core.namedparam.SqlParameterSource.class),
                org.mockito.ArgumentMatchers.eq(Long.class))).thenReturn(25L);
        listener.onFlashcardSessionCompleted(event);

        ArgumentCaptor<CreateNotificationCommand> captor = ArgumentCaptor.forClass(CreateNotificationCommand.class);
        verify(notificationService, times(1)).create(captor.capture());

        CreateNotificationCommand cmd = captor.getValue();
        assertThat(cmd.userId()).isEqualTo(userId);
        assertThat(cmd.category()).isEqualTo(NotificationCategory.MILESTONE);
        assertThat(cmd.dedupeKey()).isEqualTo("DAILY_GOAL:2026-09-30");
        assertThat(cmd.actionUrl()).isEqualTo("/flashcards");
    }

    @Test
    @DisplayName("P0-E: onStreakExtended dispatches to NotificationService.create")
    void testOnStreakExtended() {
        StreakExtendedNotificationEvent event = new StreakExtendedNotificationEvent(
                userId, 10, LocalDate.of(2026, 9, 30)
        );

        listener.onStreakExtended(event);

        ArgumentCaptor<CreateNotificationCommand> captor = ArgumentCaptor.forClass(CreateNotificationCommand.class);
        verify(notificationService, times(1)).create(captor.capture());

        CreateNotificationCommand cmd = captor.getValue();
        assertThat(cmd.userId()).isEqualTo(userId);
        assertThat(cmd.category()).isEqualTo(NotificationCategory.STREAK);
        assertThat(cmd.dedupeKey()).isEqualTo("STREAK_EXTENDED:2026-09-30");
        assertThat(cmd.content()).contains("10");
    }
}
