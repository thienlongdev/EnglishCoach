package com.englishcoach.auth.mfa;

import com.englishcoach.common.security.AdminSecondFactorPolicy;
import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.AuthSessionContext.AdminAccess;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Whether a session of the administrator account may act as administrator:
 * <ul>
 *   <li>a second factor is enrolled ⇒ the session must have passed it, always;</li>
 *   <li>none is enrolled ⇒ allowed only while {@code app.security.admin-mfa-required} is false (the enrolment
 *       phase); once it is true the account can do nothing as administrator except enrol.</li>
 * </ul>
 * "Enrolled" is read from the database and remembered for a short time (the administrator is one account and this
 * is asked on every one of its requests); every change of factors evicts the memory at once.
 */
@Component
@RequiredArgsConstructor
public class AdminMfaGate implements AdminSecondFactorPolicy {

    static final long ENROLLED_TTL_MILLIS = 30_000;

    private final MfaStore store;
    private final AuthSecurityProperties properties;
    private final ConcurrentHashMap<Long, long[]> enrolledMemo = new ConcurrentHashMap<>();

    @Override
    public AdminAccess accessFor(long userId, Instant sessionMfaVerifiedAt) {
        if (enrolled(userId)) {
            return sessionMfaVerifiedAt != null ? AdminAccess.GRANTED : AdminAccess.MFA_REQUIRED;
        }
        return properties.isAdminMfaRequired() ? AdminAccess.ENROLLMENT_REQUIRED : AdminAccess.GRANTED;
    }

    /** At least one usable factor: a WebAuthn credential or a confirmed authenticator app. */
    public boolean enrolled(long userId) {
        long now = System.currentTimeMillis();
        long[] memo = enrolledMemo.get(userId);
        if (memo != null && now - memo[1] < ENROLLED_TTL_MILLIS) return memo[0] == 1;
        boolean enrolled = !store.webAuthnCredentials(userId).isEmpty()
                || store.totp(userId).map(t -> t.confirmedAt() != null).orElse(false);
        enrolledMemo.put(userId, new long[]{enrolled ? 1 : 0, now});
        return enrolled;
    }

    public void evict(long userId) {
        enrolledMemo.remove(userId);
    }
}
