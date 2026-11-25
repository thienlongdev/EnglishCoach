package com.englishcoach.coach.controller;

import com.englishcoach.coach.dto.CreateLearningPlanRequest;
import com.englishcoach.coach.service.CoachService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/learning-plans")
@Slf4j
public class CoachController {
    private final CoachService coachService;

    public CoachController(CoachService coachService) {
        this.coachService = coachService;
    }

    @PostMapping
    public ResponseEntity<Void> create(
            @AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl userDetails,
            @RequestBody(required = false) CreateLearningPlanRequest request) {
        // EC-SEC-2026-004: Legacy ungated learning-plan generation endpoint is permanently retired (0 FE callers).
        return ResponseEntity.status(HttpStatus.GONE).build();
    }
}
