package com.englishcoach.writing.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.writing.service.WritingPracticeSubmissionService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Free practice submission of a Writing Coach draft (no AI, no Premium quota): the server records its saved text. */
@RestController
@RequestMapping("/api/v1/writing")
public class WritingPracticeSubmissionController {

    private final WritingPracticeSubmissionService service;

    public WritingPracticeSubmissionController(WritingPracticeSubmissionService service) {
        this.service = service;
    }

    @PostMapping("/sessions/{id}/practice-submission")
    public ResponseEntity<WritingPracticeSubmissionService.Result> submit(@AuthenticationPrincipal UserDetailsImpl user,
                                                                          @PathVariable String id) {
        if (user == null || user.getId() == null) throw new AccessDeniedException("Authentication required");
        if (id == null || id.length() > 64) throw new com.englishcoach.writing.exception.WritingNotFoundException("Writing session not found.");
        return ResponseEntity.ok(service.submit(user.getId(), id));
    }
}
