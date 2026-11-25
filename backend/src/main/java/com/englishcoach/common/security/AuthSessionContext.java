package com.englishcoach.common.security;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import java.time.Instant;
import java.util.UUID;

/**
 * What the request path already read about the caller's session, carried as the authentication's details so that
 * nothing later in the request has to read the session row again.
 *
 * @param mfaVerifiedAt when this session passed a second factor (null: never)
 * @param stepUpAt      when this session last proved a second factor for a sensitive action (null: never)
 * @param adminAccess   for an account whose stored role is administrator: whether this session may act as one
 *                      (null for every other account)
 */
public record AuthSessionContext(UUID sessionId, Long userId, String authMethod, Instant authenticatedAt,
                                 Instant mfaVerifiedAt, Instant stepUpAt, AdminAccess adminAccess) {

    /** Whether a session of the administrator account currently carries administrator authority. */
    public enum AdminAccess {
        /** Second factor satisfied (or none enrolled while enrolment is not yet required). */
        GRANTED,
        /** A second factor is enrolled and this session has not passed it. */
        MFA_REQUIRED,
        /** No second factor is enrolled and one is required before any administrator action. */
        ENROLLMENT_REQUIRED
    }

    /** The session of the current request, or null (anonymous, a test identity, a token without a session). */
    public static AuthSessionContext current() {
        return of(SecurityContextHolder.getContext().getAuthentication());
    }

    public static AuthSessionContext of(Authentication authentication) {
        return authentication != null && authentication.getDetails() instanceof AuthSessionContext context
                ? context : null;
    }

    /** True when this session belongs to the administrator account but may not act as administrator now. */
    public boolean adminAuthorityWithheld() {
        return adminAccess != null && adminAccess != AdminAccess.GRANTED;
    }
}
