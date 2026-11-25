package com.englishcoach.mocktest.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.mocktest.dto.MockExamDto;
import com.englishcoach.mocktest.dto.MockExamResultDto;
import com.englishcoach.mocktest.service.MockTestService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/mocktests")
@RequiredArgsConstructor
public class MockTestController {

    private final MockTestService mockTestService;

    @GetMapping
    public ResponseEntity<List<MockExamDto>> getAllExams() {
        return ResponseEntity.ok(mockTestService.getAllExams());
    }

    @GetMapping("/results")
    public ResponseEntity<List<MockExamResultDto>> getResults(@AuthenticationPrincipal UserDetailsImpl userDetails) {
        if (userDetails == null) return ResponseEntity.status(401).build();
        return ResponseEntity.ok(mockTestService.getUserResults(userDetails.getId()));
    }

    @PostMapping("/{examId}/submit")
    public ResponseEntity<Void> submitExam(@AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long examId,
            @RequestParam int score) {
        // STEP-098: Client-supplied score submission is permanently disabled.
        // All examination scoring is strictly server-authoritative under /api/v1/exams.
        return ResponseEntity.status(org.springframework.http.HttpStatus.GONE).build();
    }
}
