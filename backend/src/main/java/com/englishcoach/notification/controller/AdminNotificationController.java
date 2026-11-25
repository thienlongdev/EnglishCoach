package com.englishcoach.notification.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.notification.dto.AdminCreateNotificationRequest;
import com.englishcoach.notification.dto.AdminNotificationDto;
import com.englishcoach.notification.service.NotificationService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/admin/notifications")
@RequiredArgsConstructor
@Slf4j
public class AdminNotificationController {

    private final NotificationService notificationService;

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping
    public ResponseEntity<AdminNotificationDto> createNotification(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @Valid @RequestBody AdminCreateNotificationRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        AdminNotificationDto created = notificationService.createNotificationByAdmin(principal.getId(), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @GetMapping
    public ResponseEntity<List<AdminNotificationDto>> getAdminNotifications(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        List<AdminNotificationDto> notifications = notificationService.getAdminNotifications(page, size);
        return ResponseEntity.ok(notifications);
    }
}
