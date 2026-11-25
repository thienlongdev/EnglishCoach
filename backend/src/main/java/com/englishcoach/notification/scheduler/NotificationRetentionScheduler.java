package com.englishcoach.notification.scheduler;

import com.englishcoach.notification.service.NotificationService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
@Slf4j
public class NotificationRetentionScheduler {

    private final NotificationService notificationService;

    /**
     * Daily maintenance: cleans up READ notifications older than 90 days
     * and prunes per-user notification list to a cap of ~300 notifications.
     */
    @Scheduled(cron = "${app.notifications.retention.cron:0 0 3 * * *}")
    public void executeRetentionCleanup() {
        log.info("[Notification Retention] Starting scheduled cleanup");
        try {
            notificationService.cleanupOldReadNotifications();
            notificationService.pruneUserNotificationsCap(300);
            log.info("[Notification Retention] Completed retention cleanup successfully");
        } catch (Exception e) {
            log.error("[Notification Retention] Error during retention cleanup: {}", e.getMessage(), e);
        }
    }
}
