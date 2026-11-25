package com.englishcoach.coach.dto;
import java.util.List;
public record LearningPlanResponse(String id, String summary, List<String> weeklyPlan) {}
