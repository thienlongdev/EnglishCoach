package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class LongitudinalProgressDto {
    private long totalWordsCumulative;
    private int completedSessionsCount;
    private int totalPracticesCompleted;
    private Double averageScore;
    private List<WritingTimelinePointDto> timeline;
    private List<ErrorDensityPointDto> errorDensityHistory;
}
