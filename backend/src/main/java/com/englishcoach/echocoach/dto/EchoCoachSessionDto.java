package com.englishcoach.echocoach.dto;

import java.time.Instant;

public record EchoCoachSessionDto(
        Long id,
        String title,
        Instant createdAt,
        Instant updatedAt
) {
}
