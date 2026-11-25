package com.englishcoach.exams.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.model.ExamProfileRecords.IeltsProfileDto;
import com.englishcoach.exams.model.ExamProfileRecords.RecommendationDto;
import com.englishcoach.exams.model.ExamProfileRecords.ToeicProfileDto;
import com.englishcoach.exams.service.ExamProfileService;
import com.englishcoach.exams.service.ExamRecommendationService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Slf4j
@RestController
@RequestMapping("/api/v1/exams/profiles")
@RequiredArgsConstructor
public class ExamProfileController {

    private final ExamProfileService profileService;
    private final ExamRecommendationService recommendationService;

    /**
     * IELTS Competency Profile (Latest, Best, History, Criteria, OSR).
     * Strictly isolated from TOEIC scores.
     */
    @GetMapping("/ielts")
    public ResponseEntity<IeltsProfileDto> getIeltsProfile(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = userDetails.getId();
        IeltsProfileDto profile = profileService.getIeltsProfile(userId);
        return ResponseEntity.ok(profile);
    }

    /**
     * TOEIC Competency Profile (L&R Total, S, W).
     * Strictly isolated from IELTS scores.
     * No four-skill overall.
     */
    @GetMapping("/toeic")
    public ResponseEntity<ToeicProfileDto> getToeicProfile(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = userDetails.getId();
        ToeicProfileDto profile = profileService.getToeicProfile(userId);
        return ResponseEntity.ok(profile);
    }

    /**
     * Diagnostic recommendations for the current learner.
     */
    @GetMapping("/recommendations")
    public ResponseEntity<List<RecommendationDto>> getRecommendations(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = userDetails.getId();
        List<RecommendationDto> recommendations = recommendationService.getUserRecommendations(userId);
        return ResponseEntity.ok(recommendations);
    }
}
