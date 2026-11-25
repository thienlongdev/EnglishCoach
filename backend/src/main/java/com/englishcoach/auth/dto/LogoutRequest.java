package com.englishcoach.auth.dto;

import jakarta.validation.constraints.NotBlank;

public record LogoutRequest(
        @NotBlank(message = "Session grant is required")
        String sessionGrant
) {}
