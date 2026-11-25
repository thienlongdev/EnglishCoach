package com.englishcoach.auth.policy;

import com.englishcoach.auth.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Server-side admin check by user id: reads the CURRENT row (role + e-mail) — never a client-sent role / e-mail and never
 * a token claim. Used by privileged services (manual Premium, frame override) on top of the URL rule
 * {@code /api/v1/admin/** hasRole('ADMIN')}.
 */
@Service
@RequiredArgsConstructor
public class AdminIdentityService {

    private final UserRepository userRepository;

    /**
     * The official administrator, acting as one NOW: the stored role and e-mail say so, and the session making this
     * request has not had its administrator authority withheld for a missing second factor (security release V3).
     */
    @Transactional(readOnly = true)
    public boolean isOfficialAdmin(Long userId) {
        if (userId == null) return false;
        var session = com.englishcoach.common.security.AuthSessionContext.current();
        if (session != null && userId.equals(session.userId()) && session.adminAuthorityWithheld()) return false;
        return isOfficialAdminAccount(userId);
    }

    /**
     * The stored facts only (role + e-mail), whatever the current session has proven. For the second-factor module
     * itself, which must recognise the administrator account before its second factor is satisfied.
     */
    @Transactional(readOnly = true)
    public boolean isOfficialAdminAccount(Long userId) {
        if (userId == null) return false;
        return userRepository.findById(userId)
                .map(u -> OfficialAdminPolicy.isOfficialAdmin(u.getEmail(), u.getRole()))
                .orElse(false);
    }

    /** 403 (never 500) unless {@code userId} is the official administrator. */
    @Transactional(readOnly = true)
    public void requireOfficialAdmin(Long userId) {
        if (!isOfficialAdmin(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Administrator access required");
        }
    }
}
