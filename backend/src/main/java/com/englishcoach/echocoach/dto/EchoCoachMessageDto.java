package com.englishcoach.echocoach.dto;

import java.time.Instant;

public record EchoCoachMessageDto(
        Long id,
        Long sessionId,
        String role,
        String content,
        Instant createdAt
) {
}
