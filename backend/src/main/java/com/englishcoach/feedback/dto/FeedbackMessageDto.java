package com.englishcoach.feedback.dto;

import java.time.Instant;

public record FeedbackMessageDto(
        Long id,
        Long threadId,
        Long senderUserId,
        String senderName,
        boolean fromAdmin,
        String content,
        Instant createdAt
) {
}
