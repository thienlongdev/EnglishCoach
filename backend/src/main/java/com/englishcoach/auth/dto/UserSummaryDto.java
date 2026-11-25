package com.englishcoach.auth.dto;

import java.util.List;

public record UserSummaryDto(
        Long id,
        String email,
        String name,
        String role,
        Boolean emailVerified,
        List<String> authenticationMethods
) {}
