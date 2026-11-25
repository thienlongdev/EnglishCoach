package com.englishcoach.auth.service;

import com.englishcoach.auth.dto.GoogleExchangeRequest;
import com.englishcoach.auth.dto.GoogleLinkRequest;
import com.englishcoach.auth.entity.AuthActionToken;
import com.englishcoach.auth.entity.AuthIdentity;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthIdentityRepository;
import com.englishcoach.auth.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDateTime;
import com.englishcoach.common.security.AuthSecurityProperties;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.regex.Matcher;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;

@Service
@RequiredArgsConstructor
@Slf4j
public class GoogleIdentityService {

    private final AuthIdentityRepository identityRepository;
    private final UserRepository userRepository;
    private final AuthSessionService sessionService;
    private final AuthActionTokenService actionTokenService;
    private final PasswordEncoder passwordEncoder;
    private final LoginThrottleService throttleService;
    private final SecurityAuditService auditService;
    private final AuthSecurityProperties securityProperties;
    private final GoogleIdTokenVerifier idTokenVerifier;

    public record GoogleExchangeResult(
            String status, // "SUCCESS" or "LINK_REQUIRED"
            String sessionGrant,
            String accessToken,
            Instant expiresAt,
            User user,
            String linkTicket,
            String email
    ) {}

    @Transactional
    public GoogleExchangeResult exchangeGoogleToken(GoogleExchangeRequest request, String ipAddress, String userAgent) {
        if (!throttleService.checkAndIncrementRateLimit("GOOGLE_EXCHANGE_IP", ipAddress, 20, 15)) {
            throw new IllegalStateException("Too many Google authentication attempts. Please try again later.");
        }

        try {
            // 1-4. Signature (Google's published keys), issuer, expiry, audience and authorized party: see the verifier.
            var claims = idTokenVerifier.verify(request.idToken());

            // 5. The immutable subject (present and well-formed: the verifier refused anything else) is the identity.
            String sub = claims.getSubject();

            // 6. Validate email and enforce email_verified
            String email = claims.getClaimAsString("email");
            if (email == null || email.isBlank()) {
                throw new IllegalArgumentException("Missing email in Google token");
            }
            String normalizedEmail = email.trim().toLowerCase();
            Boolean emailVerified = claims.getClaimAsBoolean("email_verified");
            if (!Boolean.TRUE.equals(emailVerified)) {
                throw new IllegalArgumentException("Unverified email in Google token");
            }

            String name = claims.getClaimAsString("name");
            if (name == null || name.isBlank()) {
                name = normalizedEmail.split("@")[0];
            }

            // 1. Check if identity binding already exists for this (GOOGLE, sub)
            var existingIdentityOpt = identityRepository.findByProviderAndProviderSubject("GOOGLE", sub);
            if (existingIdentityOpt.isPresent()) {
                AuthIdentity identity = existingIdentityOpt.get();
                User user = identity.getUser();

                if ("DISABLED".equalsIgnoreCase(user.getAccountStatus())) {
                    throw new IllegalStateException("User account is disabled");
                }

                identity.setLastAuthenticatedAt(Instant.now());
                identityRepository.save(identity);

                var pending = sessionService.createPendingSession(user, "GOOGLE");
                var active = sessionService.activateSession(pending.sessionGrant());
                auditService.recordEvent("LOGIN_SUCCESS", "SUCCESS", null,
                        user.getId(), null, ipAddress, userAgent, null, "{\"provider\":\"GOOGLE\"}");

                return new GoogleExchangeResult("SUCCESS", pending.sessionGrant(), active.accessToken(),
                        Instant.now().plusSeconds(300), user, null, normalizedEmail);
            }

            // 2. Identity does not exist: check if user exists with normalized email
            var existingUserOpt = userRepository.findByEmailNormalized(normalizedEmail);
            if (existingUserOpt.isPresent()) {
                User existingUser = existingUserOpt.get();

                if ("DISABLED".equalsIgnoreCase(existingUser.getAccountStatus())) {
                    throw new IllegalStateException("User account is disabled");
                }

                // Safe binding: ensure no conflicting binding exists
                var existingForUser = identityRepository.findByUserIdAndProvider(existingUser.getId(), "GOOGLE");
                if (existingForUser.isPresent()) {
                    if (!existingForUser.get().getProviderSubject().equals(sub)) {
                        auditService.recordEvent("GOOGLE_LINK_FAILED", "FAILURE", null,
                                existingUser.getId(), null, ipAddress, userAgent, "USER_ALREADY_LINKED_DIFFERENT_GOOGLE", null);
                        throw new IllegalStateException("Account is already linked to a different Google account.");
                    }
                    // Already bound to this exact Google subject: update timestamp
                    AuthIdentity id = existingForUser.get();
                    id.setLastAuthenticatedAt(Instant.now());
                    identityRepository.save(id);
                } else {
                    // The account exists and has no Google identity: an e-mail match alone never opens it.
                    if (!GoogleIdTokenVerifier.googleIsAuthoritativeFor(claims, normalizedEmail)) {
                        // Google only vouches that this user proved the mailbox once. The account is linked only by
                        // its own password, through the explicit link step.
                        if (existingUser.getPassword() == null || !"ACTIVE".equalsIgnoreCase(existingUser.getCredentialStatus())) {
                            auditService.recordEvent("GOOGLE_LINK_FAILED", "FAILURE", null,
                                    existingUser.getId(), null, ipAddress, userAgent, "LINK_PROOF_UNAVAILABLE", null);
                            throw new IllegalStateException("An account with this email already exists. Please sign in with your existing method.");
                        }
                        String metadata = OBJECT_MAPPER.createObjectNode().put("sub", sub).toString();
                        String ticket = actionTokenService.createActionToken(existingUser, "GOOGLE_LINK", 10,
                                normalizedEmail, null, metadata, existingUser.getCredentialVersion());
                        auditService.recordEvent("GOOGLE_LINK_REQUIRED", "SUCCESS", null,
                                existingUser.getId(), null, ipAddress, userAgent, null, null);
                        return new GoogleExchangeResult("LINK_REQUIRED", null, null, null, existingUser, ticket, normalizedEmail);
                    }
                    // Google is the authority for this address (Gmail / Workspace): its verified owner is signing in.
                    AuthIdentity newIdentity = AuthIdentity.builder()
                            .user(existingUser)
                            .provider("GOOGLE")
                            .providerSubject(sub)
                            .providerEmail(normalizedEmail)
                            .emailVerified(true)
                            .lastAuthenticatedAt(Instant.now())
                            .build();
                    identityRepository.save(newIdentity);
                    log.info("[GoogleAuth] Successfully auto-linked Google identity for email {}", com.englishcoach.common.security.LogMask.email(normalizedEmail));
                }

                // If user registered with credentials and had not verified email yet, mark verified
                if (existingUser.getEmailVerifiedAt() == null) {
                    existingUser.setEmailVerifiedAt(LocalDateTime.now());
                    existingUser.setEmailVerificationSource("GOOGLE_AUTHORITATIVE");
                    if ("PENDING_EMAIL".equalsIgnoreCase(existingUser.getAccountStatus())) {
                        existingUser.setAccountStatus("ACTIVE");
                        // Whoever registered this address with a password never proved the mailbox, and could not sign
                        // in. Activating the account must not activate that password: it has to be set again through
                        // the mailbox (password reset) before it works.
                        if (existingUser.getPassword() != null && "ACTIVE".equalsIgnoreCase(existingUser.getCredentialStatus())) {
                            existingUser.setCredentialStatus("RESET_REQUIRED");
                        }
                    }
                    userRepository.save(existingUser);
                }

                var pending = sessionService.createPendingSession(existingUser, "GOOGLE");
                var active = sessionService.activateSession(pending.sessionGrant());
                auditService.recordEvent("GOOGLE_LINK_SUCCESS", "SUCCESS", null,
                        existingUser.getId(), null, ipAddress, userAgent, null, "{\"provider\":\"GOOGLE\",\"autoLinked\":true}");

                return new GoogleExchangeResult("SUCCESS", pending.sessionGrant(), active.accessToken(),
                        Instant.now().plusSeconds(300), existingUser, null, normalizedEmail);
            }

            // 3. New user registration via Google
            User newUser = User.builder()
                    .name(name)
                    .email(normalizedEmail)
                    .password(null)
                    .role(Role.ROLE_USER)
                    .credentialStatus("NONE")
                    .accountStatus("ACTIVE")
                    .emailVerifiedAt(LocalDateTime.now())
                    .emailVerificationSource("GOOGLE_AUTHORITATIVE")
                    .credentialVersion(0L)
                    .build();

            userRepository.save(newUser);

            AuthIdentity newIdentity = AuthIdentity.builder()
                    .user(newUser)
                    .provider("GOOGLE")
                    .providerSubject(sub)
                    .providerEmail(normalizedEmail)
                    .emailVerified(Boolean.TRUE.equals(emailVerified))
                    .lastAuthenticatedAt(Instant.now())
                    .build();

            identityRepository.save(newIdentity);

            var pending = sessionService.createPendingSession(newUser, "GOOGLE");
            var active = sessionService.activateSession(pending.sessionGrant());
            auditService.recordEvent("REGISTRATION_SUCCESS", "SUCCESS", null,
                    newUser.getId(), null, ipAddress, userAgent, null, "{\"provider\":\"GOOGLE\"}");

            return new GoogleExchangeResult("SUCCESS", pending.sessionGrant(), active.accessToken(),
                    Instant.now().plusSeconds(300), newUser, null, normalizedEmail);

        } catch (IllegalArgumentException | IllegalStateException e) {
            log.warn("[GoogleAuth] Google exchange failed: {}", e.getMessage());
            throw new IllegalArgumentException("Google token verification failed: " + e.getMessage(), e);
        } catch (Exception e) {
            log.warn("[GoogleAuth] Unexpected Google exchange failure: {}", e.getMessage());
            throw new IllegalArgumentException("Google token verification failed");
        }
    }

    @Transactional(noRollbackFor = IllegalArgumentException.class)
    public GoogleExchangeResult linkAccountWithPassword(GoogleLinkRequest request, String ipAddress, String userAgent) {
        if (!throttleService.checkAndIncrementRateLimit("GOOGLE_LINK_IP", ipAddress, 10, 15)) {
            throw new IllegalStateException("Too many linking attempts. Please try again later.");
        }

        // Consumed before password verification; IllegalArgumentException does not roll back this transaction
        // so a failed password attempt permanently spends the one-time link ticket (EC-SEC-2026-017).
        AuthActionToken token = actionTokenService.consumeActionToken(request.ticket(), "GOOGLE_LINK");
        User user = token.getUser();
        if (user == null || !"ACTIVE".equalsIgnoreCase(user.getAccountStatus())
                || "RESET_REQUIRED".equalsIgnoreCase(user.getCredentialStatus())) {
            auditService.recordEvent("GOOGLE_LINK_FAILED", "FAILURE", null,
                    user != null ? user.getId() : null, null, ipAddress, userAgent, "ACCOUNT_NOT_ACTIVE", null);
            throw new IllegalArgumentException("Account is not eligible for linking");
        }

        if (throttleService.isAccountLocked(user.getId())) {
            auditService.recordEvent("GOOGLE_LINK_FAILED", "FAILURE", null,
                    user.getId(), null, ipAddress, userAgent, "ACCOUNT_LOCKED", null);
            throw new IllegalArgumentException("Account is temporarily locked due to consecutive failed attempts. Please try again later.");
        }

        // Verify existing account password
        String storedPassword = user.getPassword();
        boolean isBcrypt = storedPassword != null
                && (storedPassword.startsWith("$2a$") || storedPassword.startsWith("$2b$") || storedPassword.startsWith("$2y$"));
        boolean isPlaceholder = "DEV_TEST".equalsIgnoreCase(request.password()) || "OAUTH2".equalsIgnoreCase(request.password());
        if (request.password() == null || !isBcrypt || isPlaceholder || !passwordEncoder.matches(request.password(), storedPassword)) {
            try {
                throttleService.recordFailedLogin(user.getId(), ipAddress);
            } catch (org.springframework.dao.DataAccessException counted) {
                log.error("[GoogleAuth] Failed-login counter not written for userId {}: {}", user.getId(), counted.getClass().getSimpleName());
            }
            auditService.recordEvent("GOOGLE_LINK_FAILED", "FAILURE", null,
                    user.getId(), null, ipAddress, userAgent, "INVALID_PASSWORD", null);
            throw new IllegalArgumentException("Invalid password for existing account");
        }

        throttleService.recordSuccessfulLogin(user.getId(), ipAddress);

        // Parse metadata to get the Google sub
        String metadata = token.getMetadata();
        String sub = extractSubFromMetadata(metadata);

        if (sub == null || sub.isBlank()) {
            throw new IllegalStateException("Invalid link metadata");
        }

        // Safe binding: ensure no conflicting binding exists
        var existingForSub = identityRepository.findByProviderAndProviderSubject("GOOGLE", sub);
        if (existingForSub.isPresent()) {
            if (!existingForSub.get().getUser().getId().equals(user.getId())) {
                auditService.recordEvent("GOOGLE_LINK_FAILED", "FAILURE", null,
                        user.getId(), null, ipAddress, userAgent, "IDENTITY_COLLISION", null);
                throw new IllegalStateException("Google identity is already linked to another account.");
            }
            // Already bound to this exact user: update timestamp
            AuthIdentity id = existingForSub.get();
            id.setLastAuthenticatedAt(Instant.now());
            identityRepository.save(id);
        } else {
            var existingForUser = identityRepository.findByUserIdAndProvider(user.getId(), "GOOGLE");
            if (existingForUser.isPresent()) {
                if (!existingForUser.get().getProviderSubject().equals(sub)) {
                    auditService.recordEvent("GOOGLE_LINK_FAILED", "FAILURE", null,
                            user.getId(), null, ipAddress, userAgent, "USER_ALREADY_LINKED_DIFFERENT_GOOGLE", null);
                    throw new IllegalStateException("Account is already linked to a different Google account.");
                }
                AuthIdentity id = existingForUser.get();
                id.setLastAuthenticatedAt(Instant.now());
                identityRepository.save(id);
            } else {
                AuthIdentity identity = AuthIdentity.builder()
                        .user(user)
                        .provider("GOOGLE")
                        .providerSubject(sub)
                        .providerEmail(user.getEmail())
                        .emailVerified(true)
                        .lastAuthenticatedAt(Instant.now())
                        .build();
                identityRepository.save(identity);
            }
        }

        var pending = sessionService.createPendingSession(user, "GOOGLE");
        var active = sessionService.activateSession(pending.sessionGrant());
        auditService.recordEvent("GOOGLE_LINK_SUCCESS", "SUCCESS", null,
                user.getId(), null, ipAddress, userAgent, null, null);

        return new GoogleExchangeResult("SUCCESS", pending.sessionGrant(), active.accessToken(),
                Instant.now().plusSeconds(300), user, null, user.getEmail());
    }

    private static final Pattern SUB_PATTERN = Pattern.compile("\"sub\"\\s*:\\s*\"([^\"]+)\"");
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private String extractSubFromMetadata(String metadata) {
        if (metadata == null || metadata.isBlank()) {
            return null;
        }
        try {
            JsonNode node = OBJECT_MAPPER.readTree(metadata);
            if (node.hasNonNull("sub")) {
                return node.get("sub").asText();
            }
        } catch (Exception ignored) {
        }
        Matcher matcher = SUB_PATTERN.matcher(metadata);
        if (matcher.find()) {
            return matcher.group(1);
        }
        return null;
    }
}
