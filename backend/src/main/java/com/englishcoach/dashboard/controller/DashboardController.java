package com.englishcoach.dashboard.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.flashcard.service.FlashcardService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping({"/api/dashboard", "/api/v1/dashboard"})
@RequiredArgsConstructor
public class DashboardController {

    private final FlashcardService flashcardService;

    private Long getUserId(UserDetailsImpl userDetails) {
        if (userDetails != null && userDetails.getId() != null) {
            return userDetails.getId();
        }
        throw new org.springframework.security.access.AccessDeniedException("Authentication required");
    }

    @GetMapping("/stats")
    public ResponseEntity<Map<String, Object>> getDashboardStats(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false, defaultValue = "20") int limit) {
        Long userId = getUserId(userDetails);
        long dueCount = flashcardService.getDueCount(userId, limit);
        long actualDueCount = flashcardService.countActualDue(userId);
        return ResponseEntity.ok(Map.of(
                "dueCount", dueCount,
                "actualDueCount", actualDueCount,
                "dailyReviewLimit", limit
        ));
    }
}
