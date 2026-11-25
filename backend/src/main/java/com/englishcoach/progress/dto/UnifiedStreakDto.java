package com.englishcoach.progress.dto;

import lombok.Builder;

@Builder
public record UnifiedStreakDto(
        int currentStreakDays,
        int longestStreakDays,
        boolean activeToday
) {}
