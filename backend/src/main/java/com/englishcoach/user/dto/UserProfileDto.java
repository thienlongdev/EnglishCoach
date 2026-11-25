package com.englishcoach.user.dto;

import com.fasterxml.jackson.annotation.JsonFormat;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

public record UserProfileDto(
        String email,
        String accountName,
        String displayName,
        String phone,
        String city,
        String province,
        @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd")
        LocalDate dateOfBirth,
        Instant accountCreatedAt,
        boolean avatarPresent,
        Instant avatarUpdatedAt,
        List<String> authMethods,
        boolean canChangePassword,
        String heatmapTheme
) {}
