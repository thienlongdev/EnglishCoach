package com.englishcoach.premium.admin;

import com.englishcoach.common.security.UserDetailsImpl;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;

/**
 * Manual Premium entitlement — official administrator only. Three gates: URL rule {@code /api/v1/admin/**
 * hasRole('ADMIN')} (WebSecurityConfig), {@code @PreAuthorize} here, and {@link PremiumAdminService} re-checking the
 * caller's current DB row against the official-admin policy. The target user comes from the path; nothing in the body
 * can name an admin, a role or a payment.
 */
@RestController
@RequestMapping("/api/v1/admin/premium")
@PreAuthorize("hasRole('ADMIN')")
@RequiredArgsConstructor
public class PremiumAdminController {

    private final PremiumAdminService service;

    @GetMapping("/users")
    public List<PremiumAdminDtos.UserSummary> search(@AuthenticationPrincipal UserDetailsImpl principal,
                                                     @RequestParam(name = "query", required = false) String query) {
        return service.search(adminId(principal), query, Instant.now());
    }

    @GetMapping("/users/{userId}")
    public PremiumAdminDtos.UserEntitlement view(@AuthenticationPrincipal UserDetailsImpl principal, @PathVariable long userId) {
        return service.view(adminId(principal), userId, Instant.now());
    }

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/users/{userId}/grant")
    public PremiumAdminDtos.UserEntitlement grant(@AuthenticationPrincipal UserDetailsImpl principal, @PathVariable long userId,
                                                  @RequestBody PremiumAdminDtos.GrantRequest body) {
        return service.grant(adminId(principal), userId, body, Instant.now());
    }

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/users/{userId}/revoke")
    public PremiumAdminDtos.UserEntitlement revoke(@AuthenticationPrincipal UserDetailsImpl principal, @PathVariable long userId,
                                                   @RequestBody PremiumAdminDtos.RevokeRequest body) {
        return service.revoke(adminId(principal), userId, body, Instant.now());
    }

    private static long adminId(UserDetailsImpl principal) {
        if (principal == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        return principal.getId();
    }
}
