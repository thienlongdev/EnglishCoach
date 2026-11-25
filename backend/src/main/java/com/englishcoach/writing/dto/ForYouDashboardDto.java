package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ForYouDashboardDto {
    private WritingSessionDto continueSession;
    private Map<String, Object> recommendedDuePractice;
    private Map<String, Object> recommendedTask;

    @Builder.Default
    private List<ErrorMemoryDto> activeFocusPatterns = new ArrayList<>();

    @Builder.Default
    private Long weeklyEvidenceCount = 0L;

    @Builder.Default
    private Integer weeklyWordsWritten = 0;

    @Builder.Default
    private Integer weeklyTargetWords = 1500;

    @Builder.Default
    private Integer daysCompletedThisWeek = 0;

    @Builder.Default
    private Integer completedPracticesToday = 0;

    @Builder.Default
    private Integer targetPracticesDaily = 3;

    @Builder.Default
    private List<DailyWordCountDto> dailyWordCounts = new ArrayList<>();

    @Builder.Default
    private Boolean isCurriculumRecommendation = false;
}
