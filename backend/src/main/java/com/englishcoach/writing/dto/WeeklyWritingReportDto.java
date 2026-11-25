package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class WeeklyWritingReportDto {
    private Instant periodStart;
    private Instant periodEnd;
    private int totalWordsWritten;
    private int completedSessions;
    private int draftsComposed;
    private int practicesCompleted;
    private Double errorResolutionVelocity;
    private List<MasteredPatternDto> topMasteredPatterns;
    private List<SkillDimensionScoreDto> skillDimensionScores;
    private String constructiveSummary;
}
