package com.englishcoach.notification.listener;

import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.event.ExamCompletedNotificationEvent;
import com.englishcoach.notification.event.FlashcardSessionNotificationEvent;
import com.englishcoach.notification.event.StreakExtendedNotificationEvent;
import com.englishcoach.notification.service.NotificationService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

@Component
@RequiredArgsConstructor
@Slf4j
public class NotificationEventListener {

    private final NotificationService notificationService;
    /** Reads today's review count for the daily-goal milestone (absent in slim tests: the milestone is then skipped). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate jdbc;

    @Async("notificationAsyncExecutor")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void onExamCompleted(ExamCompletedNotificationEvent event) {
        if (event == null || event.userId() == null) return;
        try {
            CreateNotificationCommand command = event.toCommand();
            notificationService.create(command);
            log.info("[Notification Listener] Handled ExamCompletedNotificationEvent for attemptId={}", event.attemptId());
        } catch (Exception e) {
            log.warn("[Notification Listener] Failed processing exam notification for attemptId={}: {}", event.attemptId(), e.getMessage());
        }
    }

    @Async("notificationAsyncExecutor")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void onFlashcardSessionCompleted(FlashcardSessionNotificationEvent event) {
        if (event == null || event.userId() == null) return;
        try {
            // the milestone says "N thẻ": it is created only once the learner really reviewed N cards today (it used to
            // appear after the first review of the day). Each review publishes the event again, so it comes at the Nth.
            if (!reachedToday(event)) return;
            CreateNotificationCommand command = event.toCommand();
            notificationService.create(command);
            log.info("[Notification Listener] Handled FlashcardSessionNotificationEvent for userId={}", event.userId());
        } catch (Exception e) {
            log.warn("[Notification Listener] Failed processing flashcard session notification for userId={}: {}", event.userId(), e.getMessage());
        }
    }

    private boolean reachedToday(FlashcardSessionNotificationEvent event) {
        if (jdbc == null) return false;
        int goal = event.cardsReviewed() > 0 ? event.cardsReviewed() : 10;
        java.time.ZoneId zone = java.time.ZoneId.of("Asia/Ho_Chi_Minh");
        java.time.LocalDate day = event.date() != null ? event.date() : java.time.LocalDate.now(zone);
        Long reviews = jdbc.queryForObject("""
                SELECT COUNT(*) FROM public.learning_activity_events
                WHERE user_id = :u AND activity_type = 'FLASHCARD_REVIEWED' AND occurred_at >= :since
                """, new org.springframework.jdbc.core.namedparam.MapSqlParameterSource()
                .addValue("u", event.userId())
                .addValue("since", java.sql.Timestamp.from(day.atStartOfDay(zone).toInstant())), Long.class);
        return reviews != null && reviews >= goal;
    }

    @Async("notificationAsyncExecutor")
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void onStreakExtended(StreakExtendedNotificationEvent event) {
        if (event == null || event.userId() == null) return;
        try {
            CreateNotificationCommand command = event.toCommand();
            notificationService.create(command);
            log.info("[Notification Listener] Handled StreakExtendedNotificationEvent for userId={}, streak={}", event.userId(), event.streakDays());

            if (java.util.Set.of(3, 7, 14, 30, 50, 100, 365).contains(event.streakDays())) {
                notificationService.create(new CreateNotificationCommand(
                        event.userId(),
                        com.englishcoach.notification.entity.NotificationCategory.MILESTONE,
                        com.englishcoach.notification.entity.NotificationType.STREAK,
                        com.englishcoach.notification.service.NotificationTemplates.streakMilestoneTitle(event.streakDays()),
                        com.englishcoach.notification.service.NotificationTemplates.streakMilestoneContent(event.streakDays()),
                        "/profile",
                        "STREAK_MILESTONE:" + event.streakDays()
                ));
            }
        } catch (Exception e) {
            log.warn("[Notification Listener] Failed processing streak extended notification for userId={}: {}", event.userId(), e.getMessage());
        }
    }
}
