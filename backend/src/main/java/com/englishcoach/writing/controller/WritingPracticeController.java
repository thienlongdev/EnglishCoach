package com.englishcoach.writing.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.writing.dto.ErrorMemoryDto;
import com.englishcoach.writing.service.WritingErrorMemoryService;
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
public class WritingPracticeController {

    private final WritingErrorMemoryService errorMemoryService;

    private Long requireUserId(UserDetailsImpl userDetails) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required for writing operations");
        }
        return userDetails.getId();
    }

    @GetMapping("/mistakes")
    public ResponseEntity<List<ErrorMemoryDto>> getMyMistakes(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(errorMemoryService.getMyMistakes(userId));
    }

    @GetMapping("/mistakes/{patternCode}")
    public ResponseEntity<ErrorMemoryDto> getMistakeByPattern(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String patternCode
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(errorMemoryService.getMistakeByPattern(userId, patternCode));
    }

    @PatchMapping("/mistakes/{patternCode}/mute")
    public ResponseEntity<Void> setMuted(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String patternCode,
            @RequestParam boolean muted
    ) {
        Long userId = requireUserId(userDetails);
        errorMemoryService.setMuted(userId, patternCode, muted);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/issues/{id}/dispute")
    public ResponseEntity<Void> disputeIssue(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String id,
            @RequestParam(required = false) String reason
    ) {
        Long userId = requireUserId(userDetails);
        errorMemoryService.disputeIssue(userId, id, reason != null ? reason : "Learner disputed finding");
        return ResponseEntity.noContent().build();
    }
}
