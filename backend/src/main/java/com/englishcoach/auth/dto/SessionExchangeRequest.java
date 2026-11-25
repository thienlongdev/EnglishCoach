package com.englishcoach.auth.dto;

import jakarta.validation.constraints.NotBlank;

public record SessionExchangeRequest(
        @NotBlank(message = "Session grant is required")
        String sessionGrant
) {}
