package com.englishcoach.notification.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.time.Instant;
import java.util.UUID;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record NotificationEnvelope(
        String type,
        int version,
        String eventId,
        String occurredAt,
        NotificationData data
) {
    public static NotificationEnvelope of(String type, NotificationData data) {
        return new NotificationEnvelope(
                type,
                1,
                UUID.randomUUID().toString(),
                Instant.now().toString(),
                data
        );
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record NotificationData(
            String id,
            String category,
            String title,
            String content,
            String actionUrl,
            String createdAt,
            long unreadCount
    ) {}
}
