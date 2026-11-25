package com.englishcoach.garden.application;

import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationService;
import org.springframework.stereotype.Component;

/**
 * Delivers a take notice through the existing notification centre (persistent row, read / unread state, the bell's
 * unread count and its realtime push). The call joins the garden transaction that recorded the take, so a take and its
 * notice are stored together or not at all. Player-to-player notices use the existing COMMUNITY category.
 */
@Component
public class NotificationSocialNotifier implements SocialNotifier {

    private final NotificationService notifications;

    public NotificationSocialNotifier(NotificationService notifications) {
        this.notifications = notifications;
    }

    @Override
    public void taken(long ownerId, String dedupeKey, String title, String body, String actionUrl) {
        notifications.create(new CreateNotificationCommand(ownerId, NotificationCategory.COMMUNITY,
                NotificationType.COMMUNITY_INTERACTION, title, body, actionUrl, dedupeKey));
    }
}
