package com.englishcoach.notification.dto;

import java.time.Instant;

public record LearnerNotificationDto(
        Long id,
        String type,
        String title,
        String body,
        String actionUrl,
        Instant publishedAt,
        boolean read
) {
}
