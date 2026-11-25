package com.englishcoach.notification.event;

import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationTemplates;

import java.time.LocalDate;

public record StreakExtendedNotificationEvent(
        Long userId,
        int streakDays,
        LocalDate date
) {
    public CreateNotificationCommand toCommand() {
        String title = NotificationTemplates.streakExtendedTitle(streakDays);
        String content = NotificationTemplates.streakExtendedContent(streakDays);
        String dedupeKey = "STREAK_EXTENDED:" + (date != null ? date : LocalDate.now());
        String actionUrl = "/profile";

        return new CreateNotificationCommand(
                userId,
                NotificationCategory.STREAK,
                NotificationType.STREAK,
                title,
                content,
                actionUrl,
                dedupeKey
        );
    }
}
