package com.englishcoach.auth.dto;

public record RefreshTokenRequest(
        String refreshToken,
        String sessionGrant
) {}
