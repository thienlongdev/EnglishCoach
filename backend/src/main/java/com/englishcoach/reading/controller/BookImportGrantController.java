package com.englishcoach.reading.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import com.englishcoach.premium.service.PremiumUsageService.BookGrant;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * My Books import allowance (features/my-books). The books themselves never reach the server: the client sends only
 * the SHA-256 fingerprint of each file it is about to add to the device library, asks for a grant BEFORE storing it,
 * then completes (stored) or releases (storing failed) the grant. Free accounts: one new book a day; Premium: no daily
 * cap. Account-scoped (principal only), CSRF-protected like every unsafe request.
 */
@RestController
@RequestMapping("/api/v1/reading/books/import-grants")
public class BookImportGrantController {

    public record GrantRequest(List<String> fingerprints) {}

    public record GrantResponse(List<String> granted, List<String> refused, boolean unlimited, int limit, int used,
                                int remaining, Instant resetsAt) {}

    private final PremiumUsageService usage;
    private final PremiumEntitlementService entitlement;

    public BookImportGrantController(PremiumUsageService usage, PremiumEntitlementService entitlement) {
        this.usage = usage;
        this.entitlement = entitlement;
    }

    @PostMapping
    public GrantResponse grant(@AuthenticationPrincipal UserDetailsImpl user, @RequestBody GrantRequest request) {
        long id = userId(user);
        try {
            BookGrant g = usage.grantBookImports(id, request == null ? null : request.fingerprints(), entitlement.isUserPremium(id));
            return new GrantResponse(g.granted(), g.refused(), g.unlimited(), g.allowance().limit(), g.allowance().used(),
                    g.allowance().remaining(), g.allowance().resetsAt());
        } catch (IllegalArgumentException invalid) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "INVALID_FINGERPRINT");
        }
    }

    @PostMapping("/complete")
    public ResponseEntity<Map<String, Integer>> complete(@AuthenticationPrincipal UserDetailsImpl user, @RequestBody GrantRequest request) {
        return settle(user, request, true);
    }

    @PostMapping("/release")
    public ResponseEntity<Map<String, Integer>> release(@AuthenticationPrincipal UserDetailsImpl user, @RequestBody GrantRequest request) {
        return settle(user, request, false);
    }

    private ResponseEntity<Map<String, Integer>> settle(UserDetailsImpl user, GrantRequest request, boolean stored) {
        long id = userId(user);
        try {
            List<String> fps = request == null ? null : request.fingerprints();
            int changed = stored ? usage.completeBookImports(id, fps) : usage.releaseBookImports(id, fps);
            return ResponseEntity.ok(Map.of("changed", changed));
        } catch (IllegalArgumentException invalid) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "INVALID_FINGERPRINT");
        }
    }

    private static long userId(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        return user.getId();
    }
}
