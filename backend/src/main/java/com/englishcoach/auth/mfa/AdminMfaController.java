package com.englishcoach.auth.mfa;

import com.englishcoach.auth.mfa.AdminMfaService.Caller;
import com.englishcoach.auth.mfa.AdminMfaService.MfaException;
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
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * The administrator's second factor. Every route needs a signed-in session (URL rule {@code anyRequest
 * authenticated}); the service then admits only the official administrator account. These routes work while the
 * session's administrator authority is still withheld: passing them is how it is obtained. Answers are never
 * cached; a secret or a recovery code appears in exactly one answer.
 */
@RestController
@RequestMapping("/api/v1/mfa")
@RequiredArgsConstructor
public class AdminMfaController {

    private final AdminMfaService service;

    @GetMapping("/status")
    public ResponseEntity<?> status(@AuthenticationPrincipal UserDetailsImpl principal, HttpServletRequest request) {
        return ok(service.status(caller(principal, request)));
    }

    @PostMapping("/totp/enroll")
    public ResponseEntity<?> startTotp(@AuthenticationPrincipal UserDetailsImpl principal, HttpServletRequest request) {
        return ok(service.startTotpEnrollment(caller(principal, request)));
    }

    @PostMapping("/totp/confirm")
    public ResponseEntity<?> confirmTotp(@AuthenticationPrincipal UserDetailsImpl principal,
                                         @RequestBody JsonNode body, HttpServletRequest request) {
        return ok(service.confirmTotpEnrollment(caller(principal, request), text(body, "code")));
    }

    @DeleteMapping("/totp")
    public ResponseEntity<?> removeTotp(@AuthenticationPrincipal UserDetailsImpl principal, HttpServletRequest request) {
        service.removeTotp(caller(principal, request));
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    @PostMapping("/webauthn/register/options")
    public ResponseEntity<?> registerOptions(@AuthenticationPrincipal UserDetailsImpl principal, HttpServletRequest request) {
        return ok(service.startWebAuthnRegistration(caller(principal, request)));
    }

    @PostMapping("/webauthn/register/verify")
    public ResponseEntity<?> registerVerify(@AuthenticationPrincipal UserDetailsImpl principal,
                                            @RequestBody JsonNode body, HttpServletRequest request) {
        return ok(service.finishWebAuthnRegistration(caller(principal, request), text(body, "challengeId"),
                text(body, "label"), json(body, "credential")));
    }

    @DeleteMapping("/webauthn/{id}")
    public ResponseEntity<?> removeCredential(@AuthenticationPrincipal UserDetailsImpl principal,
                                              @PathVariable String id, HttpServletRequest request) {
        service.removeWebAuthnCredential(caller(principal, request), id);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    @PostMapping("/webauthn/assert/options")
    public ResponseEntity<?> assertOptions(@AuthenticationPrincipal UserDetailsImpl principal, HttpServletRequest request) {
        return ok(service.startWebAuthnAssertion(caller(principal, request)));
    }

    /** Session verification and step-up: {@code {method, code}} or {@code {method: "WEBAUTHN", challengeId, credential}}. */
    @PostMapping("/verify")
    public ResponseEntity<?> verify(@AuthenticationPrincipal UserDetailsImpl principal, @RequestBody JsonNode body,
                                    HttpServletRequest request) {
        return ok(service.verify(caller(principal, request), text(body, "method"), text(body, "code"),
                text(body, "challengeId"), json(body, "credential")));
    }

    @PostMapping("/recovery-codes/regenerate")
    public ResponseEntity<?> regenerate(@AuthenticationPrincipal UserDetailsImpl principal, HttpServletRequest request) {
        return ok(service.regenerateRecoveryCodes(caller(principal, request)));
    }

    @ExceptionHandler(MfaException.class)
    public ResponseEntity<?> refused(MfaException e) {
        return ResponseEntity.status(e.status()).cacheControl(CacheControl.noStore())
                .body(Map.of("code", e.code(), "message", e.getMessage()));
    }

    static Caller caller(UserDetailsImpl principal, HttpServletRequest request) {
        AuthSessionContext session = AuthSessionContext.current();
        if (principal == null || session == null || session.sessionId() == null) {
            throw new MfaException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "Sign in again.");
        }
        String userAgent = request.getHeader("User-Agent");
        return new Caller(principal.getId(), session.sessionId(), session.authenticatedAt(), session.mfaVerifiedAt(),
                session.stepUpAt(), ClientIpResolver.resolve(request),
                userAgent == null ? "Unknown" : userAgent.substring(0, Math.min(userAgent.length(), 400)));
    }

    private static ResponseEntity<?> ok(Object body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }

    private static String text(JsonNode body, String field) {
        JsonNode node = body == null ? null : body.get(field);
        if (node == null || node.isNull()) return null;
        String value = node.asText();
        return value.length() > 4096 ? null : value;
    }

    /** A nested object handed on as JSON text (the WebAuthn response, exactly as the browser serialised it). */
    private static String json(JsonNode body, String field) {
        JsonNode node = body == null ? null : body.get(field);
        if (node == null || !node.isObject()) return null;
        String value = node.toString();
        return value.length() > 64_000 ? null : value;
    }
}
