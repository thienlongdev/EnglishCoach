package com.englishcoach.writing.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.service.WritingAnalyticsService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Slf4j
@RestController
@RequestMapping("/api/v1/writing")
@RequiredArgsConstructor
public class WritingIntelligenceController {

    private final WritingAnalyticsService analyticsService;

    private Long requireUserId(UserDetailsImpl userDetails) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required for writing intelligence operations");
        }
        return userDetails.getId();
    }

    @GetMapping("/analytics/weekly-report")
    public ResponseEntity<WeeklyWritingReportDto> getWeeklyReport(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(analyticsService.getWeeklyReport(userId));
    }

    @GetMapping("/analytics/longitudinal")
    public ResponseEntity<LongitudinalProgressDto> getLongitudinalProgress(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(analyticsService.getLongitudinalProgress(userId));
    }

    @GetMapping("/analytics/skills")
    public ResponseEntity<List<SkillDimensionScoreDto>> getSkillDimensionScores(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(analyticsService.getSkillDimensionScores(userId));
    }

    @RequirePremiumAi("WRITING_AI_FEEDBACK")
    @PostMapping("/intelligence/task-generate")
    public ResponseEntity<AdaptiveTaskAiResponse> generateAdaptiveTask(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody(required = false) AdaptiveTaskRequestDto request
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(analyticsService.generateAdaptiveTask(userId, request));
    }

    @RequirePremiumAi("WRITING_AI_FEEDBACK")
    @PostMapping("/intelligence/socratic-plan")
    public ResponseEntity<SocraticPlanAiResponse> getSocraticGuidance(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody SocraticPlanRequestDto request
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(analyticsService.getSocraticGuidance(userId, request));
    }

    @RequirePremiumAi("WRITING_AI_FEEDBACK")
    @PostMapping("/intelligence/compare-model")
    public ResponseEntity<ModelAnswerComparisonAiResponse> compareModelAnswer(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody ModelAnswerComparisonRequestDto request
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(analyticsService.compareModelAnswer(userId, request));
    }
}
