package com.englishcoach.auth.dto;

import jakarta.validation.constraints.NotBlank;

public record GoogleExchangeRequest(
        @NotBlank(message = "Google ID token is required")
        String idToken,
        String expectedNonce,
        String linkIntent
) {}
