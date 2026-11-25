package com.englishcoach.progress.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.progress.dto.HeatmapResponseDto;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.service.UnifiedProgressService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/progress")
@RequiredArgsConstructor
@Slf4j
public class ProgressController {

    private final UnifiedProgressService unifiedProgressService;

    @GetMapping("/streak")
    public ResponseEntity<UnifiedStreakDto> getStreak(@AuthenticationPrincipal UserDetailsImpl principal) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        UnifiedStreakDto streak = unifiedProgressService.getStreak(principal.getId());
        return ResponseEntity.ok(streak);
    }

    @GetMapping("/heatmap")
    public ResponseEntity<HeatmapResponseDto> getHeatmap(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(value = "days", required = false) Integer days
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        HeatmapResponseDto heatmap = unifiedProgressService.getHeatmap(principal.getId(), days);
        return ResponseEntity.ok(heatmap);
    }
}
