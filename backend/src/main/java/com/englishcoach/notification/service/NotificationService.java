package com.englishcoach.notification.service;

import com.englishcoach.notification.dto.AdminCreateNotificationRequest;
import com.englishcoach.notification.dto.AdminNotificationDto;
import com.englishcoach.notification.dto.LearnerNotificationDto;
import com.englishcoach.notification.dto.UnreadCountDto;

import java.util.List;

public interface NotificationService {

    List<LearnerNotificationDto> getLearnerNotifications(Long userId, Integer limit);

    UnreadCountDto getUnreadCount(Long userId);

    void markAsRead(Long userId, Long notificationId);

    void markAllAsRead(Long userId);

    void dismiss(Long userId, Long notificationId);

    AdminNotificationDto createNotificationByAdmin(Long adminUserId, AdminCreateNotificationRequest request);

    List<AdminNotificationDto> getAdminNotifications(int page, int size);

    void createPaymentSuccessNotification(Long userId, String planName);

    default void createPaymentSuccessNotification(Long userId, String planName, Long orderId) {
        createPaymentSuccessNotification(userId, planName);
    }

    java.util.Optional<com.englishcoach.notification.entity.Notification> create(com.englishcoach.notification.dto.CreateNotificationCommand command);

    void cleanupOldReadNotifications();

    void pruneUserNotificationsCap(int maxPerUser);
}
