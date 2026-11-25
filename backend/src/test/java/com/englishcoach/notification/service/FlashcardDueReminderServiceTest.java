package com.englishcoach.notification.service;

import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.progress.config.LearningProgressProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.core.namedparam.SqlParameterSource;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Daily due-review reminder: created once per learner and local day only when already-studied cards are due, never on
 * every bell read, marked read once nothing is due, and silent when the bell polls again the same day.
 */
class FlashcardDueReminderServiceTest {

    private static final long USER = 31L;
    private NotificationService notifications;
    private FlashcardRepository cards;
    private NamedParameterJdbcTemplate jdbc;
    private FlashcardDueReminderService reminder;
    private final AtomicLong now = new AtomicLong(1_000_000L);
    private final String todayKey = "FLASHCARD_DUE:" + LocalDate.now(ZoneId.of("Asia/Ho_Chi_Minh"));

    @BeforeEach
    void setUp() {
        notifications = mock(NotificationService.class);
        cards = mock(FlashcardRepository.class);
        jdbc = mock(NamedParameterJdbcTemplate.class);
        reminder = new FlashcardDueReminderService(notifications, cards, jdbc, new LearningProgressProperties());
        reminder.clock = now::get;
        when(jdbc.queryForList(anyString(), any(SqlParameterSource.class))).thenReturn(List.of());
        when(notifications.create(any())).thenReturn(Optional.empty());
    }

    @Test
    @DisplayName("Due studied cards ⇒ one REVIEW_DUE reminder with the real count, today's key and the review link")
    void createsOneReminderWithRealCount() {
        when(cards.countReviewDueByUserId(eq(USER), any())).thenReturn(20L);
        reminder.reconcile(USER);

        ArgumentCaptor<CreateNotificationCommand> cmd = ArgumentCaptor.forClass(CreateNotificationCommand.class);
        verify(notifications).create(cmd.capture());
        assertThat(cmd.getValue().title()).isEqualTo("Bạn có 20 từ cần ôn hôm nay");
        assertThat(cmd.getValue().type()).isEqualTo(NotificationType.REVIEW_DUE);
        assertThat(cmd.getValue().dedupeKey()).isEqualTo(todayKey);
        assertThat(cmd.getValue().actionUrl()).isEqualTo("/flashcards?review=learned");
        assertThat(cmd.getValue().userId()).isEqualTo(USER);

        // the bell polls again: no query, no second reminder
        reminder.reconcile(USER);
        reminder.reconcile(USER);
        verify(notifications, times(1)).create(any());
        verify(jdbc, times(1)).queryForList(anyString(), any(SqlParameterSource.class));
    }

    @Test
    @DisplayName("Nothing due ⇒ no reminder; checked again only after the recheck interval")
    void nothingDueCreatesNothing() {
        when(cards.countReviewDueByUserId(eq(USER), any())).thenReturn(0L);
        reminder.reconcile(USER);
        reminder.reconcile(USER);
        verify(notifications, never()).create(any());
        verify(cards, times(1)).countReviewDueByUserId(eq(USER), any());

        now.addAndGet(FlashcardDueReminderService.RECHECK_NONE_DUE_MILLIS + 1);
        when(cards.countReviewDueByUserId(eq(USER), any())).thenReturn(4L);
        reminder.reconcile(USER);
        verify(notifications, times(1)).create(any());
    }

    @Test
    @DisplayName("Today's reminder exists (another tab, a restart): never a second one; read once nothing is due")
    void existingReminderSettlesWhenDone() {
        when(jdbc.queryForList(anyString(), any(SqlParameterSource.class)))
                .thenReturn(List.of(Map.of("id", 77L, "done", false)));
        when(cards.countReviewDueByUserId(eq(USER), any())).thenReturn(3L);
        reminder.reconcile(USER);
        verify(notifications, never()).create(any());
        verify(notifications, never()).markAsRead(anyLong(), anyLong());

        // the learner reviews everything; after a rating the memo is forgotten
        when(cards.countReviewDueByUserId(eq(USER), any())).thenReturn(0L);
        reminder.forget(USER);
        reminder.reconcile(USER);
        verify(notifications).markAsRead(USER, 77L);
        verify(notifications, never()).markAsRead(eq(USER), longThat(id -> id != 77L));

        reminder.reconcile(USER);
        verify(notifications, times(1)).markAsRead(anyLong(), anyLong());
    }

    @Test
    @DisplayName("Two simultaneous bell reads of one learner: one reconciliation, one creation attempt")
    void simultaneousReadsAreSingleFlight() throws Exception {
        java.util.concurrent.CountDownLatch inside = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        when(cards.countReviewDueByUserId(eq(USER), any())).thenAnswer(i -> {
            inside.countDown();
            release.await(5, java.util.concurrent.TimeUnit.SECONDS);
            return 6L;
        });
        Thread first = new Thread(() -> reminder.reconcile(USER));
        first.start();
        assertThat(inside.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        reminder.reconcile(USER); // arrives while the first is still counting
        release.countDown();
        first.join(5000);
        verify(notifications, times(1)).create(any());
        verify(cards, times(1)).countReviewDueByUserId(eq(USER), any());
    }

    @Test
    @DisplayName("A failure inside reconciliation never reaches the bell")
    void failureIsContained() {
        when(jdbc.queryForList(anyString(), any(SqlParameterSource.class))).thenThrow(new RuntimeException("db down"));
        reminder.reconcile(USER);
        verify(notifications, never()).create(any());
    }
}
