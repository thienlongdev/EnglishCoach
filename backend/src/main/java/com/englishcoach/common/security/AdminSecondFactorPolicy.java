package com.englishcoach.common.security;

import java.time.Instant;

/**
 * Decides whether a session of the administrator account may carry administrator authority. Implemented by the
 * second-factor module ({@code auth.mfa.AdminMfaGate}); the request path only asks.
 */
public interface AdminSecondFactorPolicy {

    AuthSessionContext.AdminAccess accessFor(long userId, Instant sessionMfaVerifiedAt);
}
