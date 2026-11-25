package com.englishcoach.coach.service;

import com.englishcoach.coach.dto.*;

public interface CoachService {
    LearningPlanResponse createPlan(Long userId, CreateLearningPlanRequest request);
}
