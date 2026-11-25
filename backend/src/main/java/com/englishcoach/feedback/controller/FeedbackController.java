package com.englishcoach.feedback.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.feedback.dto.*;
import com.englishcoach.feedback.service.FeedbackService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

@RestController
@RequestMapping("/api/v1/feedback")
@RequiredArgsConstructor
@Slf4j
public class FeedbackController {

    private final FeedbackService feedbackService;

    private boolean isAdmin(UserDetailsImpl principal) {
        if (principal == null || principal.getAuthorities() == null) {
            return false;
        }
        return principal.getAuthorities().stream()
                .anyMatch(a -> "ROLE_ADMIN".equals(a.getAuthority()));
    }

    // =========================================================================
    // REGULAR USER ENDPOINTS
    // =========================================================================

    @PostMapping
    @PreAuthorize("!hasRole('ADMIN')")
    public ResponseEntity<FeedbackThreadDto> createThread(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @Valid @RequestBody CreateFeedbackRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (isAdmin(principal)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Quản trị viên không thể gửi góp ý học viên");
        }
        FeedbackThreadDto created = feedbackService.createThread(principal.getId(), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @GetMapping("/mine")
    @PreAuthorize("!hasRole('ADMIN')")
    public ResponseEntity<List<FeedbackThreadDto>> getMyThreads(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (isAdmin(principal)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Quản trị viên không có danh sách góp ý cá nhân");
        }
        List<FeedbackThreadDto> threads = feedbackService.getMyThreads(principal.getId());
        return ResponseEntity.ok(threads);
    }

    @GetMapping("/mine/unread-count")
    @PreAuthorize("!hasRole('ADMIN')")
    public ResponseEntity<FeedbackUnreadCountDto> getMyUnreadCount(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (isAdmin(principal)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Quản trị viên không có thông báo góp ý cá nhân");
        }
        FeedbackUnreadCountDto unreadCount = feedbackService.getMyUnreadCount(principal.getId());
        return ResponseEntity.ok(unreadCount);
    }

    @PostMapping("/{id}/follow-up")
    @PreAuthorize("!hasRole('ADMIN')")
    public ResponseEntity<FeedbackMessageDto> userFollowUp(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable("id") Long id,
            @Valid @RequestBody FeedbackMessageRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (isAdmin(principal)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Quản trị viên sử dụng cổng phản hồi admin");
        }
        FeedbackMessageDto message = feedbackService.userFollowUp(principal.getId(), id, request);
        return ResponseEntity.status(HttpStatus.CREATED).body(message);
    }

    // =========================================================================
    // ADMIN ENDPOINTS
    // =========================================================================

    @GetMapping("/admin/inbox")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<List<FeedbackThreadDto>> getAdminInbox(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (!isAdmin(principal)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Yêu cầu quyền quản trị viên");
        }
        List<FeedbackThreadDto> inbox = feedbackService.getAdminInbox();
        return ResponseEntity.ok(inbox);
    }

    @GetMapping("/admin/unread-count")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<FeedbackUnreadCountDto> getAdminUnreadCount(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (!isAdmin(principal)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Yêu cầu quyền quản trị viên");
        }
        FeedbackUnreadCountDto count = feedbackService.getAdminUnreadCount();
        return ResponseEntity.ok(count);
    }

    @PostMapping("/admin/{id}/reply")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<FeedbackMessageDto> adminReply(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable("id") Long id,
            @Valid @RequestBody FeedbackMessageRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (!isAdmin(principal)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Yêu cầu quyền quản trị viên");
        }
        FeedbackMessageDto reply = feedbackService.adminReply(principal.getId(), id, request);
        return ResponseEntity.status(HttpStatus.CREATED).body(reply);
    }

    @PatchMapping("/admin/{id}/close")
    @PreAuthorize("hasRole('ADMIN')")
    public ResponseEntity<FeedbackThreadDto> closeThread(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable("id") Long id
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (!isAdmin(principal)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Yêu cầu quyền quản trị viên");
        }
        FeedbackThreadDto closed = feedbackService.closeThread(id);
        return ResponseEntity.ok(closed);
    }

    // =========================================================================
    // SHARED ENDPOINT
    // =========================================================================

    @GetMapping("/{id}/messages")
    public ResponseEntity<List<FeedbackMessageDto>> getThreadMessages(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable("id") Long id
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        boolean admin = isAdmin(principal);
        List<FeedbackMessageDto> messages = feedbackService.getThreadMessages(principal.getId(), admin, id);
        return ResponseEntity.ok(messages);
    }
}
