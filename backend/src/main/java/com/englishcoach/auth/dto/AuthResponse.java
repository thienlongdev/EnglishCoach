package com.englishcoach.auth.dto;

import java.time.Instant;

public record AuthResponse(
        Long id,
        String email,
        String name,
        String role,
        String accessToken,
        String sessionGrant,
        Instant expiresAt
) {
    public AuthResponse(Long id, String email, String name, String role, String accessToken) {
        this(id, email, name, role, accessToken, null, null);
    }
}
