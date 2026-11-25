package com.englishcoach.auth.dto;

import jakarta.validation.constraints.NotBlank;

public record GoogleLinkRequest(
        @NotBlank(message = "Ticket is required")
        String ticket,
        String password,
        String emailProof
) {}
