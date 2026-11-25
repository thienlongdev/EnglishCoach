package com.englishcoach.speaking.profile;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.speaking.dto.SpeakingSessionDetailDto;
import com.englishcoach.speaking.dto.SpeakingSessionHistoryPageDto;
import com.englishcoach.speaking.profile.SpeakingProfileDtos.SpeakingHubEntryDto;
import com.englishcoach.speaking.profile.SpeakingProfileDtos.SpeakingProfileOverviewDto;
import com.englishcoach.speaking.profile.SpeakingProfileDtos.SpeakingProfilePronunciationDto;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/**
 * Lazy section-scoped Speaking Profile REST endpoints ({@code /api/v1/speaking/profile/**}).
 *
 * <p>Protected by {@code WebSecurityConfig} ({@code /api/v1/speaking/** -> authenticated()}).
 * Every handler resolves the learner identity strictly from the authenticated principal
 * (never from query/path parameters) and emits {@code Cache-Control: no-store}.
 */
@RestController
@RequestMapping("/api/v1/speaking/profile")
@RequiredArgsConstructor
public class SpeakingProfileController {

    private final SpeakingProfileAnalyticsService analyticsService;

    @GetMapping("/entry")
    public ResponseEntity<SpeakingHubEntryDto> getHubEntry(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        return noStoreOk(analyticsService.getHubEntry(requireUserId(principal)));
    }

    @GetMapping("/overview")
    public ResponseEntity<SpeakingProfileOverviewDto> getOverview(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        return noStoreOk(analyticsService.getOverview(requireUserId(principal)));
    }

    @GetMapping("/pronunciation")
    public ResponseEntity<SpeakingProfilePronunciationDto> getPronunciation(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        return noStoreOk(analyticsService.getPronunciation(requireUserId(principal)));
    }

    @GetMapping("/history")
    public ResponseEntity<SpeakingSessionHistoryPageDto> getHistory(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "10") int size,
            @RequestParam(defaultValue = "ALL") String mode,
            @RequestParam(defaultValue = "ALL") String status
    ) {
        int safePage = Math.max(0, page);
        int safeSize = Math.max(1, Math.min(50, size));
        return noStoreOk(analyticsService.getHistory(requireUserId(principal), mode, status, safePage, safeSize));
    }

    @GetMapping("/history/{sessionId}")
    public ResponseEntity<SpeakingSessionDetailDto> getSessionDetail(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable Long sessionId
    ) {
        return noStoreOk(analyticsService.getSessionDetail(requireUserId(principal), sessionId));
    }

    private static Long requireUserId(UserDetailsImpl principal) {
        if (principal == null || principal.getId() == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        }
        return principal.getId();
    }

    private static <T> ResponseEntity<T> noStoreOk(T body) {
        return ResponseEntity.ok()
                .cacheControl(CacheControl.noStore())
                .body(body);
    }
}
