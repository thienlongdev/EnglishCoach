package com.englishcoach.progress.dto;

import lombok.Builder;

import java.util.List;

@Builder
public record HeatmapResponseDto(
        int currentStreakDays,
        int longestStreakDays,
        int activeDaysThisYear,
        int activitiesThisMonth,
        String theme,
        List<HeatmapDayDto> days
) {}
