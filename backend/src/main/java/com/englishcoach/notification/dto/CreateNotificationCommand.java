package com.englishcoach.notification.dto;

import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;

public record CreateNotificationCommand(
        Long userId,
        NotificationCategory category,
        NotificationType type,
        String title,
        String content,
        String actionUrl,
        String dedupeKey
) {
    public CreateNotificationCommand {
        if (category == null) {
            category = NotificationCategory.SYSTEM;
        }
        if (type == null) {
            type = switch (category) {
                case STREAK -> NotificationType.STREAK;
                case MILESTONE -> NotificationType.LEARNING_REMINDER;
                case SYSTEM -> NotificationType.SYSTEM_UPDATE;
                case COMMUNITY -> NotificationType.COMMUNITY_INTERACTION;
            };
        }
    }
}
