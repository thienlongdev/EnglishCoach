package com.englishcoach.auth.controller;

import com.englishcoach.auth.dto.*;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthIdentityRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.*;
import com.englishcoach.common.security.AppJwtService;
import com.englishcoach.common.security.UserDetailsImpl;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import com.englishcoach.common.security.AuthSecurityProperties;
import org.springframework.beans.factory.annotation.Autowired;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping({"/api/v1/auth", "/api/auth"})
@Slf4j
public class AuthController {

    private final UserRepository userRepository;
    private final AuthIdentityRepository identityRepository;
    private final PasswordEncoder passwordEncoder;
    private final AuthSessionService authSessionService;
    private final LoginThrottleService loginThrottleService;
    private final RegistrationService registrationService;
    private final PasswordRecoveryService passwordRecoveryService;
    private final GoogleIdentityService googleIdentityService;
    private final SecurityAuditService auditService;
    private final AppJwtService appJwtService;
    private final TurnstileVerificationService turnstileVerificationService;
    private final AuthSecurityProperties securityProperties;

    /** Dummy BCrypt hash used to equalize login response timing for unknown emails / passwordless accounts. */
    private static final String DUMMY_BCRYPT_HASH =
            new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder().encode("ec-dummy-timing-equalizer");

    /** Absent only in unit tests that build the controller by hand. */
    @Autowired(required = false)
    private com.englishcoach.common.security.CsrfTokenService csrfTokenService;

    /** Absent only in unit tests that build the controller by hand. */
    @Autowired(required = false)
    private AuthActionTokenService authActionTokenService;

    @Autowired
    public AuthController(
            UserRepository userRepository,
            AuthIdentityRepository identityRepository,
            PasswordEncoder passwordEncoder,
            AuthSessionService authSessionService,
            LoginThrottleService loginThrottleService,
            RegistrationService registrationService,
            PasswordRecoveryService passwordRecoveryService,
            GoogleIdentityService googleIdentityService,
            SecurityAuditService auditService,
            AppJwtService appJwtService,
            TurnstileVerificationService turnstileVerificationService,
            @Autowired(required = false) AuthSecurityProperties securityProperties
    ) {
        this.userRepository = userRepository;
        this.identityRepository = identityRepository;
        this.passwordEncoder = passwordEncoder;
        this.authSessionService = authSessionService;
        this.loginThrottleService = loginThrottleService;
        this.registrationService = registrationService;
        this.passwordRecoveryService = passwordRecoveryService;
        this.googleIdentityService = googleIdentityService;
        this.auditService = auditService;
        this.appJwtService = appJwtService;
        this.turnstileVerificationService = turnstileVerificationService;
        this.securityProperties = securityProperties != null ? securityProperties : new AuthSecurityProperties();
    }

    public AuthController(
            UserRepository userRepository,
            AuthIdentityRepository identityRepository,
            PasswordEncoder passwordEncoder,
            AuthSessionService authSessionService,
            LoginThrottleService loginThrottleService,
            RegistrationService registrationService,
            PasswordRecoveryService passwordRecoveryService,
            GoogleIdentityService googleIdentityService,
            SecurityAuditService auditService,
            AppJwtService appJwtService,
            TurnstileVerificationService turnstileVerificationService
    ) {
        this(userRepository, identityRepository, passwordEncoder, authSessionService,
                loginThrottleService, registrationService, passwordRecoveryService,
                googleIdentityService, auditService, appJwtService, turnstileVerificationService,
                new AuthSecurityProperties());
    }

    private String getClientIp(HttpServletRequest request) {
        return com.englishcoach.common.security.ClientIpResolver.resolve(request);
    }

    private String getUserAgent(HttpServletRequest request) {
        String ua = request.getHeader("User-Agent");
        return ua != null ? ua : "Unknown";
    }

    @PostMapping("/login")
    public ResponseEntity<?> login(@Valid @RequestBody LoginRequest request, HttpServletRequest httpRequest) {
        String ip = getClientIp(httpRequest);
        String ua = getUserAgent(httpRequest);
        String email = request.email().trim().toLowerCase();
        log.info("[Auth] Login attempt for email: {} from IP: {}", com.englishcoach.common.security.LogMask.email(email), ip);

        // Turnstile check
        try {
            turnstileVerificationService.verifyToken(request.turnstileToken(), ip, "login");
        } catch (IllegalArgumentException e) {
            log.warn("[Auth] Login rejected by anti-bot verification: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("code", "CAPTCHA_FAILED", "message", e.getMessage()));
        }

        // Rate limit: 10 attempts per minute per IP
        if (!loginThrottleService.checkAndIncrementRateLimit("LOGIN_IP", ip, 10, 1)) {
            log.warn("[Auth] IP rate limit exceeded for IP: {}", ip);
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .body(Map.of("code", "RATE_LIMIT_EXCEEDED", "message", "Too many login attempts. Please try again shortly."));
        }

        User user = userRepository.findByEmailNormalized(email).orElse(null);
        if (user == null) {
            user = userRepository.findByEmail(email).orElse(null);
        }

        if (user == null) {
            // Perform a dummy BCrypt check so missing accounts do not expose a timing oracle.
            passwordEncoder.matches(request.password() != null ? request.password() : "", DUMMY_BCRYPT_HASH);
            log.warn("[Auth] Login rejected: user not found: {}", com.englishcoach.common.security.LogMask.email(email));
            auditService.recordEvent("LOGIN_FAILED", "FAILURE", null, null, null, ip, ua, "USER_NOT_FOUND", null);
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "INVALID_CREDENTIALS", "message", "Invalid email or password."));
        }

        // Check account lock
        if (loginThrottleService.isAccountLocked(user.getId())) {
            log.warn("[Auth] Login rejected: account locked for userId: {}", user.getId());
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "ACCOUNT_LOCKED", "message", "Account is temporarily locked due to consecutive failed attempts. Please try again later."));
        }

        // Check account status
        if ("DISABLED".equalsIgnoreCase(user.getAccountStatus())) {
            log.warn("[Auth] Login rejected: account disabled for userId: {}", user.getId());
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "ACCOUNT_DISABLED", "message", "Account has been disabled."));
        }

        String storedPassword = user.getPassword();
        boolean passwordValid = false;
        boolean isBcryptHash = storedPassword != null
                && (storedPassword.startsWith("$2a$") || storedPassword.startsWith("$2b$") || storedPassword.startsWith("$2y$"));
        boolean isKnownPlaceholder = "DEV_TEST".equalsIgnoreCase(request.password())
                || "OAUTH2".equalsIgnoreCase(request.password());

        if (isBcryptHash && !isKnownPlaceholder) {
            passwordValid = passwordEncoder.matches(request.password(), storedPassword);
        } else {
            passwordEncoder.matches(request.password() != null ? request.password() : "", DUMMY_BCRYPT_HASH);
            if (isKnownPlaceholder) {
                log.warn("[Auth] Login rejected: account {} attempted placeholder credentials", com.englishcoach.common.security.LogMask.email(email));
            }
        }

        if (!passwordValid) {
            log.warn("[Auth] Login rejected: invalid password for: {}", com.englishcoach.common.security.LogMask.email(email));
            // Counting the failure must never change the answer: a wrong password is a 401, whatever the counter does.
            try {
                loginThrottleService.recordFailedLogin(user.getId(), ip);
            } catch (org.springframework.dao.DataAccessException counted) {
                log.error("[Auth] Failed-login counter not written for userId {}: {}", user.getId(), counted.getClass().getSimpleName());
            }
            auditService.recordEvent("LOGIN_FAILED", "FAILURE", null, user.getId(), null, ip, ua, "INVALID_PASSWORD", null);
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "INVALID_CREDENTIALS", "message", "Invalid email or password."));
        }

        // Password is valid - reset failed attempts
        loginThrottleService.recordSuccessfulLogin(user.getId(), ip);

        // Check credential status
        if ("RESET_REQUIRED".equalsIgnoreCase(user.getCredentialStatus())) {
            log.warn("[Auth] Account requires password reset: {}", com.englishcoach.common.security.LogMask.email(email));
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(Map.of("code", "RESET_REQUIRED", "message", "Password reset is required for this account before logging in."));
        }

        // Check if email verification is mandatory
        if ("PENDING_EMAIL".equalsIgnoreCase(user.getAccountStatus())) {
            log.warn("[Auth] Account requires email verification: {}", com.englishcoach.common.security.LogMask.email(email));
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(Map.of("code", "EMAIL_VERIFICATION_REQUIRED", "message", "Please verify your email address before logging in."));
        }

        // Create revocable backend session and activate it
        var pendingSession = authSessionService.createPendingSession(user, "CREDENTIALS");
        var activeSession = authSessionService.activateSession(pendingSession.sessionGrant());
        String accessToken = activeSession.accessToken();

        auditService.recordEvent("LOGIN_SUCCESS", "SUCCESS", null, user.getId(), activeSession.sessionId().toString(), ip, ua, null, null);
        log.info("[Auth] Login successful for: {} (role: {})", com.englishcoach.common.security.LogMask.email(email), user.getRole());

        int lifetimeMinutes = securityProperties != null ? securityProperties.getJwtLifetimeMinutes() : 30;
        return ResponseEntity.ok(new AuthResponse(
                user.getId(),
                user.getEmail(),
                user.getName(),
                user.getRole().name(),
                accessToken,
                pendingSession.sessionGrant(),
                Instant.now().plus(lifetimeMinutes, ChronoUnit.MINUTES)
        ));
    }

    @PostMapping({"/refresh", "/session/refresh"})
    public ResponseEntity<?> refreshToken(
            @RequestBody(required = false) RefreshTokenRequest request,
            HttpServletRequest httpRequest
    ) {
        String token = null;
        if (request != null) {
            if (request.refreshToken() != null && !request.refreshToken().isBlank()) {
                token = request.refreshToken().trim();
            } else if (request.sessionGrant() != null && !request.sessionGrant().isBlank()) {
                token = request.sessionGrant().trim();
            }
        }

        // The grant comes in the body only, from the frontend's server code (which keeps it in its encrypted HttpOnly
        // session cookie). No cookie of this backend carries a grant and an access token is not a grant, so the
        // former cookie and Authorization-header fallbacks are gone.
        if (token == null || token.isBlank()) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "MISSING_REFRESH_TOKEN", "message", "Refresh token is required"));
        }

        try {
            var result = authSessionService.activateSession(token);
            User user = result.user();
            int lifetimeMinutes = securityProperties != null ? securityProperties.getJwtLifetimeMinutes() : 30;
            Instant expiresAt = Instant.now().plus(lifetimeMinutes, ChronoUnit.MINUTES);
            long expiresIn = lifetimeMinutes * 60L;

            Map<String, Object> resp = new HashMap<>();
            resp.put("accessToken", result.accessToken());
            resp.put("sessionGrant", token);
            resp.put("refreshToken", token);
            resp.put("expiresAt", expiresAt);
            resp.put("expiresIn", expiresIn);
            if (csrfTokenService != null && result.sessionId() != null) {
                // For the frontend server to hand to the page: the header value of cookie-authenticated writes.
                resp.put("csrfToken", csrfTokenService.tokenFor(result.sessionId()));
            }
            if (user != null) {
                resp.put("user", Map.of(
                        "id", user.getId(),
                        "email", user.getEmail() != null ? user.getEmail() : "",
                        "name", user.getName() != null ? user.getName() : "",
                        "role", user.getRole() != null ? user.getRole().name() : "ROLE_USER"
                ));
            }
            return ResponseEntity.ok(resp);
        } catch (IllegalArgumentException | IllegalStateException e) {
            log.warn("[Auth] Token refresh rejected: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "INVALID_REFRESH_TOKEN", "message", "Refresh token is invalid or expired."));
        } catch (Exception e) {
            log.error("[Auth] Unexpected error during token refresh: {}", e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "REFRESH_FAILED", "message", "Authentication session renewal failed."));
        }
    }

    @PostMapping("/session/exchange")
    public ResponseEntity<?> exchangeSession(@Valid @RequestBody SessionExchangeRequest request) {
        try {
            var result = authSessionService.activateSession(request.sessionGrant());
            User user = result.user();

            List<String> methods = new ArrayList<>();
            if (user.getPassword() != null && "ACTIVE".equalsIgnoreCase(user.getCredentialStatus())) {
                methods.add("CREDENTIALS");
            }
            if (identityRepository.existsByUserIdAndProvider(user.getId(), "GOOGLE")) {
                methods.add("GOOGLE");
            }

            UserSummaryDto summary = new UserSummaryDto(
                    user.getId(),
                    user.getEmail(),
                    user.getName(),
                    user.getRole().name(),
                    user.getEmailVerifiedAt() != null,
                    methods
            );

            int lifetimeMinutes = securityProperties != null ? securityProperties.getJwtLifetimeMinutes() : 30;
            return ResponseEntity.ok(new SessionExchangeResponse(
                    result.accessToken(),
                    Instant.now().plus(lifetimeMinutes, ChronoUnit.MINUTES),
                    summary
            ));
        } catch (Exception e) {
            log.warn("[Auth] Session exchange failed: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "INVALID_GRANT", "message", "Session grant is invalid or expired."));
        }
    }

    @PostMapping("/logout")
    public ResponseEntity<Void> logout(@RequestBody(required = false) LogoutRequest request, HttpServletRequest httpRequest) {
        if (request != null && request.sessionGrant() != null && !request.sessionGrant().isBlank()) {
            authSessionService.revokeSession(request.sessionGrant(), "USER_LOGOUT");
        } else if (httpRequest != null) {
            String authHeader = httpRequest.getHeader("Authorization");
            if (authHeader != null && authHeader.startsWith("Bearer ")) {
                try {
                    String token = authHeader.substring(7).trim();
                    var claims = appJwtService.parseAndValidateToken(token);
                    String sid = claims.get("sid", String.class);
                    if (sid != null && !sid.isBlank()) {
                        authSessionService.revokeSessionById(UUID.fromString(sid), "USER_LOGOUT");
                    }
                } catch (Exception ignored) {}
            }
        }
        return ResponseEntity.noContent().build();
    }

    /**
     * The CSRF token of the caller's own session, for a page whose readable copy is missing. Another site cannot
     * read this answer (CORS admits only this application's origins).
     */
    @GetMapping("/csrf")
    public ResponseEntity<?> csrfToken(@AuthenticationPrincipal UserDetailsImpl principal) {
        var session = com.englishcoach.common.security.AuthSessionContext.current();
        if (principal == null || session == null || session.sessionId() == null || csrfTokenService == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "UNAUTHORIZED", "message", "Authentication required."));
        }
        return ResponseEntity.ok()
                .header("Cache-Control", "no-store")
                .body(Map.of("csrfToken", csrfTokenService.tokenFor(session.sessionId())));
    }

    @GetMapping("/me")
    public ResponseEntity<?> getCurrentUser(@AuthenticationPrincipal UserDetailsImpl principal) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "UNAUTHORIZED", "message", "Authentication required."));
        }

        User user = userRepository.findById(principal.getId()).orElse(null);
        if (user == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "USER_NOT_FOUND", "message", "User not found."));
        }

        List<String> methods = new ArrayList<>();
        if (user.getPassword() != null && "ACTIVE".equalsIgnoreCase(user.getCredentialStatus())) {
            methods.add("CREDENTIALS");
        }
        if (identityRepository.existsByUserIdAndProvider(user.getId(), "GOOGLE")) {
            methods.add("GOOGLE");
        }

        return ResponseEntity.ok(new UserSummaryDto(
                user.getId(),
                user.getEmail(),
                user.getName(),
                user.getRole().name(),
                user.getEmailVerifiedAt() != null,
                methods
        ));
    }

    @PostMapping("/register")
    public ResponseEntity<?> register(@Valid @RequestBody RegisterRequest request, HttpServletRequest httpRequest) {
        try {
            turnstileVerificationService.verifyToken(request.turnstileToken(), getClientIp(httpRequest), "register");
        } catch (IllegalArgumentException e) {
            log.warn("[Auth] Registration rejected by anti-bot verification: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("code", "CAPTCHA_FAILED", "message", e.getMessage()));
        }

        try {
            // Committed on return; the mail goes to the provider only afterwards. A new address and an existing one
            // both get a mail, so reporting the provider's answer reveals nothing about the account.
            AuthMailService.PreparedMail mail = registrationService.register(request, getClientIp(httpRequest), getUserAgent(httpRequest));
            AuthMailService.DeliveryOutcome outcome = mail == null ? null : registrationService.deliver(mail);
            Map<String, Object> body = new HashMap<>();
            body.put("message", "Registration accepted. Check this address for our email.");
            if (outcome != null) body.put("delivery", outcome.name());
            if (outcome == AuthMailService.DeliveryOutcome.FAILED) body.put("code", "MAIL_DELIVERY_FAILED");
            return ResponseEntity.status(HttpStatus.ACCEPTED).body(body);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY)
                    .body(Map.of("code", "VALIDATION_FAILED", "message", e.getMessage()));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .body(Map.of("code", "RATE_LIMIT_EXCEEDED", "message", e.getMessage()));
        }
    }

    @PostMapping("/verify-email")
    public ResponseEntity<?> verifyEmail(@Valid @RequestBody VerifyEmailRequest request, HttpServletRequest httpRequest) {
        try {
            RegistrationService.VerifyOutcome outcome = registrationService.verifyEmail(request, getClientIp(httpRequest));
            if (outcome == RegistrationService.VerifyOutcome.ALREADY_VERIFIED) {
                return ResponseEntity.ok(Map.of("status", "ALREADY_VERIFIED"));
            }
            return ResponseEntity.noContent().build();
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("code", "INVALID_OR_EXPIRED_LINK", "message", "This link is invalid or expired."));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .body(Map.of("code", "RATE_LIMIT_EXCEEDED", "message", e.getMessage()));
        }
    }

    @PostMapping("/resend-verification")
    public ResponseEntity<?> resendVerification(@Valid @RequestBody ResendVerificationRequest request, HttpServletRequest httpRequest) {
        try {
            turnstileVerificationService.verifyToken(request.turnstileToken(), getClientIp(httpRequest), "resend-verification");
        } catch (IllegalArgumentException e) {
            log.warn("[Auth] Resend verification rejected by anti-bot verification: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("code", "CAPTCHA_FAILED", "message", e.getMessage()));
        }

        try {
            var mail = registrationService.resendVerification(request, getClientIp(httpRequest));
            if (mail != null && mail.isPresent()
                    && registrationService.deliver(mail.get()) == AuthMailService.DeliveryOutcome.FAILED) {
                // Only an address with an account can get here; said only while the provider is failing.
                return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                        .body(Map.of("code", "MAIL_DELIVERY_FAILED", "message", "The email could not be sent right now. Please try again in a few minutes."));
            }
            return ResponseEntity.status(HttpStatus.ACCEPTED)
                    .body(Map.of("message", "If eligible, an email will be sent."));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .body(Map.of("code", "RATE_LIMIT_EXCEEDED", "message", e.getMessage()));
        }
    }

    @PostMapping("/forgot-password")
    public ResponseEntity<?> forgotPassword(@Valid @RequestBody ForgotPasswordRequest request, HttpServletRequest httpRequest) {
        try {
            turnstileVerificationService.verifyToken(request.turnstileToken(), getClientIp(httpRequest), "forgot-password");
            passwordRecoveryService.forgotPassword(request, getClientIp(httpRequest), getUserAgent(httpRequest));
            return ResponseEntity.status(HttpStatus.ACCEPTED)
                    .body(Map.of("message", "If eligible, an email will be sent."));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("code", "CAPTCHA_FAILED", "message", e.getMessage()));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .body(Map.of("code", "RATE_LIMIT_EXCEEDED", "message", e.getMessage()));
        }
    }

    @PostMapping("/reset-password")
    public ResponseEntity<?> resetPassword(@Valid @RequestBody ResetPasswordRequest request, HttpServletRequest httpRequest) {
        try {
            passwordRecoveryService.resetPassword(request, getClientIp(httpRequest));
            return ResponseEntity.noContent().build();
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("code", "INVALID_OR_EXPIRED_LINK", "message", e.getMessage()));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .body(Map.of("code", "RATE_LIMIT_EXCEEDED", "message", e.getMessage()));
        }
    }

    @PostMapping("/change-password")
    public ResponseEntity<?> changePassword(@AuthenticationPrincipal UserDetailsImpl principal,
                                            @Valid @RequestBody ChangePasswordRequest request,
                                            HttpServletRequest httpRequest) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "UNAUTHORIZED", "message", "Authentication required."));
        }
        var currentSession = com.englishcoach.common.security.AuthSessionContext.current();
        if (currentSession != null && currentSession.adminAuthorityWithheld()) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(Map.of("code", "MFA_REQUIRED", "message", "Second-factor verification is required before changing the password."));
        }
        // A session is not proof of knowing the password: the current-password check must not become an oracle
        // for whoever holds a stolen session. Five tries a minute per account.
        if (!loginThrottleService.checkAndIncrementRateLimit("CHANGE_PASSWORD_USER", "u:" + principal.getId(), 5, 1)) {
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .body(Map.of("code", "RATE_LIMIT_EXCEEDED", "message", "Too many attempts. Please try again shortly."));
        }
        try {
            passwordRecoveryService.changePassword(principal.getId(), request, getClientIp(httpRequest));
            if (authActionTokenService != null) {
                authActionTokenService.revokeActiveTokens(principal.getId(), List.of("PASSWORD_RESET", "GOOGLE_LINK"));
            }
            return ResponseEntity.noContent().build();
        } catch (IllegalArgumentException e) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                    .body(Map.of("code", "VALIDATION_FAILED", "message", e.getMessage()));
        }
    }

    @PostMapping("/google/exchange")
    public ResponseEntity<?> googleExchange(@Valid @RequestBody GoogleExchangeRequest request, HttpServletRequest httpRequest) {
        try {
            var result = googleIdentityService.exchangeGoogleToken(request, getClientIp(httpRequest), getUserAgent(httpRequest));
            if ("LINK_REQUIRED".equals(result.status())) {
                return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of(
                        "status", "LINK_REQUIRED",
                        "ticket", result.linkTicket(),
                        "email", result.email(),
                        "message", "An account with this email already exists. Please confirm your password to link your Google account."
                ));
            }
            Map<String, Object> resp = new java.util.HashMap<>();
            resp.put("status", "SUCCESS");
            resp.put("sessionGrant", result.sessionGrant());
            if (result.accessToken() != null) {
                resp.put("accessToken", result.accessToken());
            }
            resp.put("expiresAt", result.expiresAt());
            resp.put("user", Map.of(
                    "id", result.user().getId(),
                    "email", result.user().getEmail(),
                    "name", result.user().getName(),
                    "role", result.user().getRole().name()
            ));
            return ResponseEntity.ok(resp);
        } catch (IllegalArgumentException e) {
            log.warn("[Auth] Google exchange rejected: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "GOOGLE_AUTH_FAILED", "message", "Google authentication failed. Please try again."));
        } catch (IllegalStateException e) {
            log.warn("[Auth] Google exchange rate-limited or blocked: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .body(Map.of("code", "RATE_LIMIT_EXCEEDED", "message", "Too many Google authentication attempts. Please try again later."));
        }
    }

    @PostMapping("/google/link")
    public ResponseEntity<?> googleLink(@Valid @RequestBody GoogleLinkRequest request, HttpServletRequest httpRequest) {
        try {
            var result = googleIdentityService.linkAccountWithPassword(request, getClientIp(httpRequest), getUserAgent(httpRequest));
            Map<String, Object> resp = new java.util.HashMap<>();
            resp.put("status", "SUCCESS");
            resp.put("sessionGrant", result.sessionGrant());
            if (result.accessToken() != null) {
                resp.put("accessToken", result.accessToken());
            }
            resp.put("expiresAt", result.expiresAt());
            resp.put("user", Map.of(
                    "id", result.user().getId(),
                    "email", result.user().getEmail(),
                    "name", result.user().getName(),
                    "role", result.user().getRole().name()
            ));
            return ResponseEntity.ok(resp);
        } catch (IllegalArgumentException e) {
            log.warn("[Auth] Google account link rejected: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "LINK_FAILED", "message", "Unable to link Google account. Please verify your credentials and try again."));
        } catch (IllegalStateException e) {
            if (e.getMessage() != null && e.getMessage().toLowerCase(java.util.Locale.ROOT).contains("too many")) {
                return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                        .body(Map.of("code", "RATE_LIMIT_EXCEEDED", "message", "Too many linking attempts. Please try again later."));
            }
            log.warn("[Auth] Google account link rejected: {}", e.getMessage());
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("code", "LINK_FAILED", "message", "Unable to link Google account. Please verify your credentials and try again."));
        }
    }
}
