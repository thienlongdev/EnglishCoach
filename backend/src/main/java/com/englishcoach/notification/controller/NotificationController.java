package com.englishcoach.notification.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.notification.dto.LearnerNotificationDto;
import com.englishcoach.notification.dto.UnreadCountDto;
import com.englishcoach.notification.service.NotificationService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/notifications")
@RequiredArgsConstructor
@Slf4j
public class NotificationController {

    private final NotificationService notificationService;
    /** Daily Flashcards review reminder, reconciled lazily on the bell's reads (absent in slim test contexts). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.notification.service.FlashcardDueReminderService flashcardDueReminder;

    @GetMapping
    public ResponseEntity<List<LearnerNotificationDto>> getNotifications(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(required = false) Integer limit
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (flashcardDueReminder != null) flashcardDueReminder.reconcile(principal.getId());
        List<LearnerNotificationDto> notifications =
                notificationService.getLearnerNotifications(principal.getId(), limit);
        return ResponseEntity.ok(notifications);
    }

    @GetMapping("/unread-count")
    public ResponseEntity<UnreadCountDto> getUnreadCount(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        if (flashcardDueReminder != null) flashcardDueReminder.reconcile(principal.getId());
        UnreadCountDto unreadCount = notificationService.getUnreadCount(principal.getId());
        return ResponseEntity.ok(unreadCount);
    }

    @PostMapping("/{id}/read")
    public ResponseEntity<Map<String, Object>> markAsRead(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable("id") Long id
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        notificationService.markAsRead(principal.getId(), id);
        return ResponseEntity.ok(Map.of("success", true));
    }

    @PostMapping("/read-all")
    public ResponseEntity<Map<String, Object>> markAllAsRead(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        notificationService.markAllAsRead(principal.getId());
        return ResponseEntity.ok(Map.of("success", true));
    }

    @PostMapping("/{id}/dismiss")
    public ResponseEntity<Map<String, Object>> dismiss(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable("id") Long id
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        notificationService.dismiss(principal.getId(), id);
        return ResponseEntity.ok(Map.of("success", true));
    }
}
