package com.englishcoach.feedback.dto;

import java.time.Instant;

public record FeedbackThreadDto(
        Long id,
        Long userId,
        String userName,
        String userEmail,
        String category,
        String subject,
        String status,
        boolean adminUnread,
        boolean userUnread,
        Instant createdAt,
        Instant lastMessageAt,
        String lastMessageSnippet
) {
}
