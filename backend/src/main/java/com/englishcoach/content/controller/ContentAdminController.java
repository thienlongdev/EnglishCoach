package com.englishcoach.content.controller;

import com.englishcoach.content.dto.RssRefreshResultDto;
import com.englishcoach.content.service.RssRefreshScheduler;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Admin management controller for Content Hub RSS refresh.
 * Protected by hasRole('ADMIN') per existing security policy.
 */
@RestController
@RequestMapping("/api/v1/admin/content")
@RequiredArgsConstructor
public class ContentAdminController {

    private final RssRefreshScheduler refreshScheduler;

    @PostMapping("/refresh")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<RssRefreshResultDto> triggerRefresh() {
        RssRefreshResultDto result = refreshScheduler.refreshFeeds();
        return ResponseEntity.ok(result);
    }
}
