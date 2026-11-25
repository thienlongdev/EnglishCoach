package com.englishcoach.user.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.user.dto.UpdateUserProfileRequest;
import com.englishcoach.user.dto.UserProfileDto;
import com.englishcoach.user.service.UserProfileService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.multipart.MultipartFile;

import java.time.Instant;
import java.util.concurrent.TimeUnit;

@RestController
@RequestMapping("/api/v1/users")
@RequiredArgsConstructor
@Slf4j
public class UserProfileController {

    private final UserProfileService userProfileService;

    @GetMapping("/me/profile")
    public ResponseEntity<UserProfileDto> getProfile(@AuthenticationPrincipal UserDetailsImpl principal) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        UserProfileDto profile = userProfileService.getProfile(principal.getId());
        return ResponseEntity.ok(profile);
    }

    @PutMapping("/me/profile")
    public ResponseEntity<UserProfileDto> updateProfile(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @Valid @RequestBody UpdateUserProfileRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        UserProfileDto updated = userProfileService.updateProfile(principal.getId(), request);
        return ResponseEntity.ok(updated);
    }

    @PatchMapping("/me/profile/heatmap-theme")
    public ResponseEntity<UserProfileDto> updateHeatmapTheme(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestBody com.englishcoach.user.dto.UpdateHeatmapThemeRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        UserProfileDto updated = userProfileService.updateHeatmapTheme(principal.getId(), request != null ? request.theme() : null);
        return ResponseEntity.ok(updated);
    }

    @PostMapping(value = "/me/avatar", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<UserProfileDto> uploadAvatar(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam("file") MultipartFile file
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        UserProfileDto updated = userProfileService.uploadAvatar(principal.getId(), file);
        return ResponseEntity.ok(updated);
    }

    @GetMapping("/me/avatar")
    public ResponseEntity<Resource> getAvatar(
            @AuthenticationPrincipal UserDetailsImpl principal,
            WebRequest webRequest
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        Resource resource = userProfileService.loadAvatarResource(principal.getId());
        if (resource == null) {
            return ResponseEntity.notFound().build();
        }
        Instant lastModified = userProfileService.getAvatarLastModified(principal.getId());
        long lastModifiedMillis = lastModified != null ? lastModified.toEpochMilli() : -1;
        String etag = lastModified != null ? "\"" + principal.getId() + "-" + lastModifiedMillis + "\"" : null;

        if (etag != null && lastModifiedMillis > 0) {
            if (webRequest != null && webRequest.checkNotModified(etag, lastModifiedMillis)) {
                return null;
            }
        } else if (lastModifiedMillis > 0 && webRequest != null && webRequest.checkNotModified(lastModifiedMillis)) {
            return null;
        }

        var responseBuilder = ResponseEntity.ok()
                .contentType(MediaType.IMAGE_PNG)
                .cacheControl(CacheControl.maxAge(1, TimeUnit.HOURS).cachePrivate());
        if (etag != null) {
            responseBuilder.eTag(etag);
        }
        if (lastModified != null) {
            responseBuilder.lastModified(lastModified);
        }
        return responseBuilder.body(resource);
    }

    @GetMapping("/{userId}/avatar")
    public ResponseEntity<Resource> getUserAvatar(
            @PathVariable Long userId,
            WebRequest webRequest
    ) {
        Resource resource = userProfileService.loadAvatarResource(userId);
        if (resource == null) {
            return ResponseEntity.notFound().build();
        }
        Instant lastModified = userProfileService.getAvatarLastModified(userId);
        long lastModifiedMillis = lastModified != null ? lastModified.toEpochMilli() : -1;
        String etag = lastModified != null ? "\"" + userId + "-" + lastModifiedMillis + "\"" : null;

        if (etag != null && lastModifiedMillis > 0) {
            if (webRequest != null && webRequest.checkNotModified(etag, lastModifiedMillis)) {
                return null;
            }
        } else if (lastModifiedMillis > 0 && webRequest != null && webRequest.checkNotModified(lastModifiedMillis)) {
            return null;
        }

        var responseBuilder = ResponseEntity.ok()
                .contentType(MediaType.IMAGE_PNG)
                .cacheControl(CacheControl.maxAge(1, TimeUnit.HOURS).cachePublic());
        if (etag != null) {
            responseBuilder.eTag(etag);
        }
        if (lastModified != null) {
            responseBuilder.lastModified(lastModified);
        }
        return responseBuilder.body(resource);
    }

    @DeleteMapping("/me/avatar")
    public ResponseEntity<Void> deleteAvatar(@AuthenticationPrincipal UserDetailsImpl principal) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        userProfileService.deleteAvatar(principal.getId());
        return ResponseEntity.noContent().build();
    }
}
