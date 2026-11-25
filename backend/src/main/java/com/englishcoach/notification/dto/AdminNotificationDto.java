package com.englishcoach.notification.dto;

import java.time.Instant;

public record AdminNotificationDto(
        Long id,
        String scope,
        String type,
        String title,
        String body,
        String actionUrl,
        Instant publishAt,
        Instant expiresAt,
        String targetEmail,
        Long createdByUserId,
        String state,
        Instant createdAt
) {
}
