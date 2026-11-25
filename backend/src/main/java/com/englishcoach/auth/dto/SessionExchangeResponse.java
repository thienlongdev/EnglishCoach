package com.englishcoach.auth.dto;

import java.time.Instant;

public record SessionExchangeResponse(
        String accessToken,
        Instant expiresAt,
        UserSummaryDto user
) {}
