package com.englishcoach.notification.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.notification.dto.NotificationEnvelope;
import com.englishcoach.notification.entity.Notification;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Map;

@Component
@Slf4j
public class NotificationPushPublisher {

    private final SimpMessagingTemplate messagingTemplate;
    private final UserRepository userRepository;

    public NotificationPushPublisher(
            @Lazy SimpMessagingTemplate messagingTemplate,
            UserRepository userRepository
    ) {
        this.messagingTemplate = messagingTemplate;
        this.userRepository = userRepository;
    }

    public void publishCreated(Long userId, Notification notification, long unreadCount) {
        if (messagingTemplate == null || userId == null || notification == null) return;

        NotificationEnvelope.NotificationData data = new NotificationEnvelope.NotificationData(
                String.valueOf(notification.getId()),
                notification.getCategory() != null ? notification.getCategory().name() : "SYSTEM",
                notification.getTitle(),
                notification.getBody(),
                notification.getActionUrl(),
                notification.getCreatedAt() != null ? notification.getCreatedAt().toString() : Instant.now().toString(),
                unreadCount
        );

        NotificationEnvelope envelope = NotificationEnvelope.of("NOTIFICATION_CREATED", data);
        sendToUserSafely(userId, "/queue/notifications", envelope, notification.getCategory() != null ? notification.getCategory().name() : "SYSTEM");
    }

    public void publishRead(Long userId, Long notificationId, long unreadCount) {
        if (messagingTemplate == null || userId == null) return;

        NotificationEnvelope.NotificationData data = new NotificationEnvelope.NotificationData(
                notificationId != null ? String.valueOf(notificationId) : null,
                null,
                null,
                null,
                null,
                Instant.now().toString(),
                unreadCount
        );

        NotificationEnvelope envelope = NotificationEnvelope.of("NOTIFICATION_READ", data);
        sendToUserSafely(userId, "/queue/notifications", envelope, "NOTIFICATION_READ");
    }

    public void publishAllRead(Long userId) {
        if (messagingTemplate == null || userId == null) return;

        NotificationEnvelope.NotificationData data = new NotificationEnvelope.NotificationData(
                null,
                null,
                null,
                null,
                null,
                Instant.now().toString(),
                0
        );

        NotificationEnvelope envelope = NotificationEnvelope.of("NOTIFICATIONS_ALL_READ", data);
        sendToUserSafely(userId, "/queue/notifications", envelope, "NOTIFICATIONS_ALL_READ");
    }

    public void publishUnreadCountSync(Long userId, long unreadCount) {
        if (messagingTemplate == null || userId == null) return;

        NotificationEnvelope.NotificationData data = new NotificationEnvelope.NotificationData(
                null,
                null,
                null,
                null,
                null,
                Instant.now().toString(),
                unreadCount
        );

        NotificationEnvelope envelope = NotificationEnvelope.of("UNREAD_COUNT_SYNC", data);
        sendToUserSafely(userId, "/queue/notifications", envelope, "UNREAD_COUNT_SYNC");
    }

    public void publishSystemAnnouncement(Long notificationId, String title) {
        if (messagingTemplate == null) return;
        try {
            messagingTemplate.convertAndSend("/topic/system-announcements", Map.of(
                    "type", "SYSTEM_ANNOUNCEMENT",
                    "notificationId", notificationId != null ? notificationId : 0L,
                    "title", title != null ? title : "",
                    "occurredAt", Instant.now().toString()
            ));
            log.info("[Notification Push] Broadcasted system announcement id={}", notificationId);
        } catch (Exception e) {
            log.warn("[Notification Push] Failed to broadcast announcement id={}: {}", notificationId, e.getMessage());
        }
    }

    private void sendToUserSafely(Long userId, String destination, Object payload, String category) {
        try {
            String userIdStr = String.valueOf(userId);
            messagingTemplate.convertAndSendToUser(userIdStr, destination, payload);

            // Also deliver to email if user has active session with email principal
            try {
                User user = userRepository.findById(userId).orElse(null);
                if (user != null && user.getEmail() != null && !user.getEmail().equalsIgnoreCase(userIdStr)) {
                    messagingTemplate.convertAndSendToUser(user.getEmail(), destination, payload);
                }
            } catch (Exception ignored) {}

            log.info("[Notification Push] Pushed to userId={}, category={}, destination={}", userId, category, destination);
        } catch (Exception e) {
            // Broker failure is logged without PII in content and never propagates upward
            log.warn("[Notification Push] Failed to push to userId={}, category={}: {}", userId, category, e.getMessage());
        }
    }
}
