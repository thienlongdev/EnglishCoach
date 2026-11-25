package com.englishcoach.background;

import com.englishcoach.background.BackgroundPreferenceDtos.BackgroundPreferencesResponse;
import com.englishcoach.background.BackgroundPreferenceDtos.SaveBackgroundPreferencesRequest;
import com.englishcoach.common.security.UserDetailsImpl;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

/**
 * Echo Background Studio preferences REST endpoints for the signed-in learner
 * ({@code /api/v1/users/me/**} is {@code .authenticated()} in {@code WebSecurityConfig}).
 * Every operation is strictly scoped to the authenticated principal; no {@code userId} parameter exists.
 */
@RestController
@Validated
@RequestMapping("/api/v1/users/me/background-preferences")
public class BackgroundPreferenceController {

    private final BackgroundPreferenceService service;

    public BackgroundPreferenceController(BackgroundPreferenceService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<BackgroundPreferencesResponse> get(@AuthenticationPrincipal UserDetailsImpl principal) {
        return ok(service.get(owner(principal)));
    }

    @PutMapping
    public ResponseEntity<BackgroundPreferencesResponse> save(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @Valid @RequestBody SaveBackgroundPreferencesRequest request) {
        return ok(service.save(owner(principal), request));
    }

    @DeleteMapping
    public ResponseEntity<Void> reset(@AuthenticationPrincipal UserDetailsImpl principal) {
        service.reset(owner(principal));
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    private static long owner(UserDetailsImpl principal) {
        if (principal == null || principal.getId() == null) {
            throw new BackgroundPreferenceException(401, "AUTH_REQUIRED");
        }
        return principal.getId();
    }

    private static <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
