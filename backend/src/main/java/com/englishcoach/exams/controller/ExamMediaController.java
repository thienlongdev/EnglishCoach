package com.englishcoach.exams.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.model.ExamMediaRecords.*;
import com.englishcoach.exams.model.ExamTypes.MediaPurpose;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@Slf4j
@RestController
@RequestMapping("/api/v1/exams")
@RequiredArgsConstructor
public class ExamMediaController {

    public static final String RECORDING_SANDBOX_CSP = "default-src 'none'; media-src 'self'; sandbox";
    private static final String ASSET_SANDBOX_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; sandbox";
    private static final Set<String> SAFE_ASSET_IMAGE_MIMES = Set.of(
            "image/png", "image/jpeg", "image/webp", "image/gif"
    );

    private final ExamMediaService mediaService;
    /** Exams Phase 9A: the administrator read of a learner recording is decided by the canonical official-admin check. */
    private final com.englishcoach.auth.policy.AdminIdentityService adminIdentity;
    private final com.englishcoach.exams.security.ExamRateLimiter rateLimiter;

    @PostMapping({"/attempts/{id}/recordings", "/recordings"})
    public ResponseEntity<InitiateRecordingResponseDto> initiateRecording(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable(required = false) UUID id,
            @RequestBody InitiateRecordingRequest request
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        UUID attemptId = id != null ? id : request.attemptId();
        if (attemptId == null) {
            return ResponseEntity.badRequest().build();
        }
        return ResponseEntity.ok(mediaService.initiateRecording(userDetails.getId(), attemptId, request));
    }

    @PutMapping("/recordings/{id}/chunks/{sequence}")
    public ResponseEntity<ExamMediaService.UploadChunkReceiptDto> uploadChunk(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @PathVariable int sequence,
            @RequestHeader(value = "X-Chunk-Sha256", required = false) String clientSha256,
            @RequestBody byte[] chunkData
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(mediaService.saveChunk(userDetails.getId(), id, sequence, clientSha256, chunkData));
    }

    @GetMapping("/recordings/{id}/chunks/{sequence}")
    public ResponseEntity<byte[]> getChunk(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @PathVariable int sequence
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        ExamMediaService.ChunkDataResult result = mediaService.getChunkData(userDetails.getId(), id, sequence);
        MediaType safeType = ExamMediaService.sanitizeAudioMediaType(result.mimeType());
        boolean allowlistedAudio = ExamMediaService.isAllowlistedAudioMediaType(safeType);
        ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                .header("Content-Security-Policy", RECORDING_SANDBOX_CSP)
                .header("X-Content-Type-Options", "nosniff")
                .cacheControl(CacheControl.noStore().cachePrivate())
                .contentType(safeType);
        if (allowlistedAudio) {
            builder.header(HttpHeaders.CONTENT_DISPOSITION, "inline");
        } else {
            builder.header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"recording.bin\"");
        }
        return builder.body(result.data());
    }

    @PostMapping("/recordings/{id}/seal")
    public ResponseEntity<SealRecordingResponseDto> sealRecording(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @RequestBody SealRecordingRequest request
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(mediaService.sealRecording(userDetails.getId(), id, request));
    }

    @GetMapping("/recordings/{id}")
    public ResponseEntity<RecordingStatusDto> getRecordingStatus(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(mediaService.getRecordingStatus(userDetails.getId(), id));
    }

    @PostMapping("/recordings/{id}/fail")
    public ResponseEntity<Void> failRecording(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @RequestBody(required = false) FailRecordingRequest request
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        String errorCode = request != null ? request.errorCode() : "UPLOAD_FAILED";
        mediaService.failRecording(userDetails.getId(), id, errorCode);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/attempts/{id}/playback-grants")
    public ResponseEntity<PlaybackGrantDto> createPlaybackGrant(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @RequestBody Map<String, String> body
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        // Exams Phase 9F: grant creation is throttled per learner (a runner needs a handful per part, never hundreds)
        rateLimiter.check(com.englishcoach.exams.security.ExamRateLimiter.Operation.PLAYBACK_GRANT, userDetails.getId());
        UUID assetId;
        MediaPurpose purpose;
        try {
            assetId = UUID.fromString(String.valueOf(body.get("assetId")));
            purpose = body.containsKey("purpose") ? MediaPurpose.valueOf(body.get("purpose")) : MediaPurpose.SIMULATION_LISTENING;
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        }

        return ResponseEntity.ok(mediaService.createPlaybackGrant(userDetails.getId(), id, assetId, purpose));
    }

    /**
     * Exams Phase 9E: the grant is resolved (token, expiry, asset) BEFORE any byte is produced; only then is a streaming
     * resource returned and Spring MVC serves the {@code Range} request from it (206 + Content-Range, 416 for an
     * unsatisfiable range, 200 without Range). Nothing is loaded into memory as a whole; protected media is never cached
     * by shared caches.
     */
    @GetMapping("/media/{grantToken}")
    public ResponseEntity<Resource> streamMedia(@PathVariable String grantToken,
                                                @RequestHeader(value = HttpHeaders.RANGE, required = false) String range) {
        try {
            ExamMediaService.GrantedMedia media = mediaService.openGrantedMedia(grantToken);
            MediaType safeType = sanitizeAssetMediaType(media.mimeType());
            if (range != null && !range.isBlank()) {
                // an unsatisfiable / malformed range ⇒ 416 with no body (Spring would otherwise send the whole object)
                try {
                    org.springframework.http.HttpRange.toResourceRegions(
                            org.springframework.http.HttpRange.parseRanges(range), media.resource());
                } catch (IllegalArgumentException invalidRange) {
                    return ResponseEntity.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                            .header(HttpHeaders.CONTENT_RANGE, "bytes */" + media.resource().contentLength())
                            .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                            .build();
                }
            }
            ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                    .header("Content-Security-Policy", ASSET_SANDBOX_CSP)
                    .header("X-Content-Type-Options", "nosniff")
                    .cacheControl(CacheControl.noStore().cachePrivate())
                    .contentType(safeType);
            if (MediaType.APPLICATION_OCTET_STREAM.equals(safeType)) {
                builder.header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"media.bin\"");
            }
            return builder.body(media.resource());
        } catch (SecurityException e) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (IllegalArgumentException e) {
            return ResponseEntity.notFound().build();
        } catch (java.io.IOException | java.io.UncheckedIOException e) {
            log.warn("Exam media unavailable: {}", e.getClass().getSimpleName());
            return ResponseEntity.notFound().build();
        }
    }

    @GetMapping({"/recordings/{id}/playback", "/media/recordings/{id}/playback"})
    public ResponseEntity<Resource> getRecordingPlayback(
            @PathVariable UUID id,
            @RequestParam(required = false) String token,
            @RequestHeader(value = HttpHeaders.RANGE, required = false) String range,
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        boolean isAdmin = userDetails != null && adminIdentity != null && adminIdentity.isOfficialAdmin(userDetails.getId());
        try {
            ExamMediaService.GrantedMedia media = mediaService.openRecordingPlayback(userId, id, token, isAdmin);
            if (range != null && !range.isBlank()) {
                try {
                    org.springframework.http.HttpRange.toResourceRegions(
                            org.springframework.http.HttpRange.parseRanges(range), media.resource());
                } catch (IllegalArgumentException invalidRange) {
                    return ResponseEntity.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                            .header(HttpHeaders.CONTENT_RANGE, "bytes */" + media.resource().contentLength())
                            .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                            .build();
                }
            }
            MediaType safeType = ExamMediaService.sanitizeAudioMediaType(media.mimeType());
            boolean allowlistedAudio = ExamMediaService.isAllowlistedAudioMediaType(safeType);
            ResponseEntity.BodyBuilder builder = ResponseEntity.ok()
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                    .header("Content-Security-Policy", RECORDING_SANDBOX_CSP)
                    .header("X-Content-Type-Options", "nosniff")
                    .cacheControl(CacheControl.noStore().cachePrivate())
                    .contentType(safeType);
            if (allowlistedAudio) {
                builder.header(HttpHeaders.CONTENT_DISPOSITION, "inline");
            } else {
                builder.header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"recording.bin\"");
            }
            return builder.body(media.resource());
        } catch (SecurityException e) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        } catch (IllegalArgumentException e) {
            return ResponseEntity.notFound().build();
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.CONFLICT).build();
        } catch (Exception e) {
            log.error("Error streaming recording playback for {}: {}", id, e.getMessage());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build();
        }
    }

    private static MediaType sanitizeAssetMediaType(String rawMime) {
        if (rawMime == null || rawMime.isBlank()) {
            return MediaType.parseMediaType("audio/mpeg");
        }
        MediaType audioType = ExamMediaService.sanitizeAudioMediaType(rawMime);
        if (ExamMediaService.isAllowlistedAudioMediaType(audioType)) {
            return audioType;
        }
        int semi = rawMime.indexOf(';');
        String base = (semi >= 0 ? rawMime.substring(0, semi) : rawMime).trim().toLowerCase(Locale.ROOT);
        if (SAFE_ASSET_IMAGE_MIMES.contains(base)) {
            return MediaType.parseMediaType(base);
        }
        return MediaType.APPLICATION_OCTET_STREAM;
    }
}
