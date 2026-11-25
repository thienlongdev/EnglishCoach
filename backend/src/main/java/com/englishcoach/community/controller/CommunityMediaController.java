package com.englishcoach.community.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.community.dto.CommunityPostMediaDto;
import com.englishcoach.community.entity.CommunityPostMedia;
import com.englishcoach.community.service.CommunityMediaStorageService;
import com.englishcoach.community.service.CommunityRestrictionService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.lang.Nullable;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

@RestController
@RequestMapping("/api/v1/community/media")
@Slf4j
public class CommunityMediaController {

    private static final int MAX_CONCURRENT_UPLOADS = 6;
    private static final int MAX_CONCURRENT_UPLOADS_PER_USER = 2;

    private final CommunityMediaStorageService mediaStorageService;
    private final CommunityRestrictionService restrictionService;
    private final Semaphore uploadSlots = new Semaphore(MAX_CONCURRENT_UPLOADS);
    private final ConcurrentHashMap<Long, AtomicInteger> activeUserUploads = new ConcurrentHashMap<>();

    @Autowired
    public CommunityMediaController(
            CommunityMediaStorageService mediaStorageService,
            @Nullable CommunityRestrictionService restrictionService
    ) {
        this.mediaStorageService = mediaStorageService;
        this.restrictionService = restrictionService;
    }

    public CommunityMediaController(CommunityMediaStorageService mediaStorageService) {
        this(mediaStorageService, null);
    }

    @PostMapping("/upload")
    public ResponseEntity<CommunityPostMediaDto> uploadMedia(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam("file") MultipartFile file
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        Long userId = principal.getId();
        if (restrictionService != null) {
            restrictionService.assertCanPost(userId);
        }

        AtomicInteger userCounter = activeUserUploads.computeIfAbsent(userId, k -> new AtomicInteger(0));
        if (userCounter.incrementAndGet() > MAX_CONCURRENT_UPLOADS_PER_USER) {
            userCounter.decrementAndGet();
            throw new ResponseStatusException(
                    HttpStatus.TOO_MANY_REQUESTS,
                    "Bạn đang tải lên quá nhiều tệp cùng lúc. Vui lòng đợi hoàn tất."
            );
        }
        boolean acquiredGlobal = false;
        try {
            if (!uploadSlots.tryAcquire()) {
                throw new ResponseStatusException(
                        HttpStatus.SERVICE_UNAVAILABLE,
                        "Hệ thống đang xử lý nhiều tệp tải lên. Vui lòng thử lại sau giây lát."
                );
            }
            acquiredGlobal = true;

            CommunityPostMedia media = mediaStorageService.uploadMedia(userId, file);

            CommunityPostMediaDto dto = CommunityPostMediaDto.builder()
                    .id(media.getId())
                    .url("/api/v1/community/media/" + media.getStorageKey())
                    .fileName(media.getFileName())
                    .fileSize(media.getFileSize())
                    .mimeType(media.getMimeType())
                    .width(media.getWidth())
                    .height(media.getHeight())
                    .build();

            return ResponseEntity.status(HttpStatus.CREATED)
                    .cacheControl(CacheControl.noStore().cachePrivate())
                    .body(dto);
        } finally {
            if (acquiredGlobal) {
                uploadSlots.release();
            }
            if (userCounter.decrementAndGet() <= 0) {
                activeUserUploads.remove(userId, userCounter);
            }
        }
    }

    @GetMapping("/{storageKey}")
    public ResponseEntity<Resource> getMedia(@PathVariable String storageKey) {
        Resource resource = mediaStorageService.loadMediaResource(storageKey);
        if (resource == null) {
            return ResponseEntity.notFound().build();
        }

        MediaType mediaType = MediaType.APPLICATION_OCTET_STREAM;
        String lower = storageKey.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".mp4")) {
            mediaType = MediaType.parseMediaType("video/mp4");
        } else if (lower.endsWith(".webm")) {
            mediaType = MediaType.parseMediaType("video/webm");
        } else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            mediaType = MediaType.IMAGE_JPEG;
        } else if (lower.endsWith(".png")) {
            mediaType = MediaType.IMAGE_PNG;
        } else if (lower.endsWith(".webp")) {
            mediaType = MediaType.parseMediaType("image/webp");
        }

        // Uploaded bytes are never a document of this site: no script, no plugin, no navigation even if a browser were
        // to sniff them (security release 2026-11-16, SEC-05; nosniff comes from Nginx and Spring Security).
        return ResponseEntity.ok()
                .contentType(mediaType)
                .header("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox")
                .header("X-Content-Type-Options", "nosniff")
                .header("Accept-Ranges", "bytes")
                .cacheControl(CacheControl.maxAge(30, TimeUnit.DAYS).cachePublic())
                .body(resource);
    }
}
