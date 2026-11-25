package com.englishcoach.auth.controller;

import com.englishcoach.auth.mfa.RequireStepUp;
import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.auth.service.AccountSessionService;
import com.englishcoach.auth.service.AccountSessionService.Caller;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.ClientIpResolver;
import com.englishcoach.common.security.UserDetailsImpl;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.Map;
import java.util.UUID;

/**
 * Session list and termination (security closure 2026-10). Learner routes live under {@code /api/v1/account/**}
 * (signed in, URL rule {@code anyRequest().authenticated()}, cookie writes CSRF-checked); the administrator routes
 * under {@code /api/v1/admin/**} ({@code hasRole('ADMIN')}, re-checked by {@link AdminIdentityService}; ending another
 * user's sessions needs a fresh second-factor proof).
 */
@RestController
@RequiredArgsConstructor
public class AccountSessionController {

    private final AccountSessionService service;
    private final AdminIdentityService adminIdentity;

    @GetMapping("/api/v1/account/sessions")
    public ResponseEntity<?> mine(@AuthenticationPrincipal UserDetailsImpl principal, HttpServletRequest request) {
        return ok(Map.of("sessions", service.list(caller(principal, request))));
    }

    @DeleteMapping("/api/v1/account/sessions/{id}")
    public ResponseEntity<?> endOne(@AuthenticationPrincipal UserDetailsImpl principal, @PathVariable String id,
                                    HttpServletRequest request) {
        Caller caller = caller(principal, request);
        UUID targetId = parse(id);
        if (!targetId.equals(caller.sessionId())) {
            requireAdminMfaSatisfied();
        }
        return ok(service.revokeOne(caller, targetId));
    }

    @PostMapping("/api/v1/account/sessions/revoke-others")
    public ResponseEntity<?> endOthers(@AuthenticationPrincipal UserDetailsImpl principal, HttpServletRequest request) {
        Caller caller = caller(principal, request);
        requireAdminMfaSatisfied();
        return ok(service.revokeOthers(caller));
    }

    @PostMapping("/api/v1/admin/security/sessions/lookup")
    public ResponseEntity<?> adminLookup(@AuthenticationPrincipal UserDetailsImpl principal, @RequestBody JsonNode body) {
        adminIdentity.requireOfficialAdmin(principal == null ? null : principal.getId());
        return ok(service.adminLookup(body == null || body.get("email") == null ? null : body.get("email").asText()));
    }

    @RequireStepUp
    @PostMapping("/api/v1/admin/security/sessions/revoke")
    public ResponseEntity<?> adminRevoke(@AuthenticationPrincipal UserDetailsImpl principal, @RequestBody JsonNode body,
                                         HttpServletRequest request) {
        adminIdentity.requireOfficialAdmin(principal == null ? null : principal.getId());
        JsonNode target = body == null ? null : body.get("userId");
        if (target == null || !target.canConvertToLong()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "userId required");
        }
        return ok(service.adminRevokeAll(caller(principal, request), target.asLong()));
    }

    private static Caller caller(UserDetailsImpl principal, HttpServletRequest request) {
        AuthSessionContext session = AuthSessionContext.current();
        if (principal == null || session == null || session.sessionId() == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Sign in again");
        }
        String ua = request.getHeader("User-Agent");
        return new Caller(principal.getId(), session.sessionId(), session.authenticatedAt(),
                ClientIpResolver.resolve(request), ua == null ? "Unknown" : ua.substring(0, Math.min(ua.length(), 400)));
    }

    private static void requireAdminMfaSatisfied() {
        AuthSessionContext session = AuthSessionContext.current();
        if (session != null && session.adminAuthorityWithheld()) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "MFA_REQUIRED");
        }
    }

    private static UUID parse(String id) {
        try {
            return UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Session not found");
        }
    }

    private static ResponseEntity<?> ok(Object body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
