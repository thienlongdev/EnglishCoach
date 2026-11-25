package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.*;

import java.util.List;

public interface WritingAnalyticsService {
    WeeklyWritingReportDto getWeeklyReport(Long userId);
    LongitudinalProgressDto getLongitudinalProgress(Long userId);
    List<SkillDimensionScoreDto> getSkillDimensionScores(Long userId);
    AdaptiveTaskAiResponse generateAdaptiveTask(Long userId, AdaptiveTaskRequestDto request);
    SocraticPlanAiResponse getSocraticGuidance(Long userId, SocraticPlanRequestDto request);
    ModelAnswerComparisonAiResponse compareModelAnswer(Long userId, ModelAnswerComparisonRequestDto request);
}
