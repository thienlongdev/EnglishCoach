package com.englishcoach.proficiency.api;

import com.englishcoach.common.security.UserDetailsImpl;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Minimal Proficiency API (Phase 2). Authenticated by the default filter chain (no security
 * change); every read/write is scoped to the caller's own user id.
 */
@RestController
@RequestMapping("/api/v1/proficiency")
@RequiredArgsConstructor
public class ProficiencyController {

    private final ProficiencyQueryService queryService;

    @GetMapping("/me")
    public ResponseEntity<ProficiencyDtos.ProficiencyMeResponse> me(@AuthenticationPrincipal UserDetailsImpl principal) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(queryService.me(principal.getId()));
    }

    @PatchMapping("/me/visibility")
    public ResponseEntity<ProficiencyDtos.VisibilityResponse> setVisibility(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @Valid @RequestBody ProficiencyDtos.VisibilityRequest request) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(queryService.setVisibility(principal.getId(), request.showOnProficiencyBoard()));
    }
}
