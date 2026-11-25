package com.englishcoach.notification.dto;

import com.englishcoach.notification.entity.NotificationScope;
import com.englishcoach.notification.entity.NotificationType;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.Instant;

public record AdminCreateNotificationRequest(
        @NotNull(message = "Scope is required")
        NotificationScope scope,

        @NotNull(message = "Type is required")
        NotificationType type,

        @NotBlank(message = "Title is required")
        @Size(max = 255, message = "Title must not exceed 255 characters")
        String title,

        @NotBlank(message = "Body is required")
        @Size(max = 2000, message = "Body must not exceed 2000 characters")
        String body,

        @Size(max = 512, message = "Action URL must not exceed 512 characters")
        String actionUrl,

        Instant publishAt,

        Instant expiresAt,

        String targetEmail
) {
}
