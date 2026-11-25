package com.englishcoach.progress.dto;

import com.fasterxml.jackson.annotation.JsonFormat;
import lombok.Builder;

import java.time.LocalDate;

@Builder
public record HeatmapDayDto(
        @JsonFormat(shape = JsonFormat.Shape.STRING, pattern = "yyyy-MM-dd")
        LocalDate date,
        int activityCount,
        int intensity
) {}
