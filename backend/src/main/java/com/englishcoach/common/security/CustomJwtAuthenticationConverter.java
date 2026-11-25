package com.englishcoach.common.security;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class CustomJwtAuthenticationConverter implements Converter<Jwt, AbstractAuthenticationToken> {

    private final UserRepository userRepository;
    private final com.englishcoach.auth.service.AuthSessionService authSessionService;

    /** Present in the application; absent when a test builds the converter by hand (no second-factor rule then). */
    private AdminSecondFactorPolicy adminSecondFactorPolicy;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    public void setAdminSecondFactorPolicy(AdminSecondFactorPolicy adminSecondFactorPolicy) {
        this.adminSecondFactorPolicy = adminSecondFactorPolicy;
    }

    /**
     * The request's authentication. For the administrator account the ROLE_ADMIN authority is carried only by a
     * session the second-factor policy admits; any other session of that account acts as an ordinary learner, so
     * every administrator check in the application (URL rules, method security, STOMP topics) refuses it without
     * knowing about second factors.
     */
    private UsernamePasswordAuthenticationToken authenticationFor(User user, Jwt jwt,
                                                                com.englishcoach.auth.entity.AuthSession session) {
        AuthSessionContext.AdminAccess adminAccess = null;
        UserDetailsImpl userDetails = UserDetailsImpl.build(user);
        if (user.getRole() == Role.ROLE_ADMIN && adminSecondFactorPolicy != null) {
            adminAccess = adminSecondFactorPolicy.accessFor(user.getId(),
                    session != null ? session.getMfaVerifiedAt() : null);
            if (adminAccess != AuthSessionContext.AdminAccess.GRANTED) {
                userDetails = new UserDetailsImpl(user.getId(), user.getEmail(), user.getPassword(),
                        java.util.List.of(new org.springframework.security.core.authority.SimpleGrantedAuthority(
                                Role.ROLE_USER.name())));
            }
        }
        UsernamePasswordAuthenticationToken authentication =
                new UsernamePasswordAuthenticationToken(userDetails, jwt, userDetails.getAuthorities());
        // The session facts this read already has: the CSRF token, the second-factor and step-up checks use them
        // without another statement.
        if (session != null || adminAccess != null) {
            authentication.setDetails(new AuthSessionContext(
                    session != null ? session.getId() : null, user.getId(),
                    session != null ? session.getAuthMethod() : null,
                    session != null ? session.getAuthenticatedAt() : null,
                    session != null ? session.getMfaVerifiedAt() : null,
                    session != null ? session.getStepUpAt() : null, adminAccess));
        }
        return authentication;
    }

    @Override
    public AbstractAuthenticationToken convert(Jwt jwt) {
        // The ordinary request: a token that names its account and its session. Both are read in ONE statement and
        // every check below is the one the step-by-step path makes (same account, not disabled, session ACTIVE and
        // inside its lifetimes). Anything else (no session claim, no numeric account claim, a session that is missing
        // or belongs to another account) takes the original path unchanged and is decided there.
        AbstractAuthenticationToken direct = convertWithSession(jwt);
        if (direct != null) return direct;

        User user = null;

        // Try canonical userId claim or numerical subject first
        Object userIdClaim = jwt.getClaim("userId");
        if (userIdClaim instanceof Number n) {
            user = userRepository.findById(n.longValue()).orElse(null);
        } else if (userIdClaim instanceof String s) {
            try {
                user = userRepository.findById(Long.parseLong(s)).orElse(null);
            } catch (NumberFormatException ignored) {
            }
        }

        if (user == null) {
            String subject = jwt.getSubject();
            if (subject != null) {
                try {
                    user = userRepository.findById(Long.parseLong(subject)).orElse(null);
                } catch (NumberFormatException ignored) {
                }
            }
        }

        // Fallback to normalized email claim
        if (user == null) {
            String email = jwt.getClaimAsString("email");
            if (email == null) {
                email = jwt.getSubject();
            }
            if (email != null && email.contains("@")) {
                user = userRepository.findByEmail(email.trim().toLowerCase()).orElse(null);
            }
        }

        if (user == null) {
            throw new org.springframework.security.oauth2.server.resource.InvalidBearerTokenException("User account does not exist or requires registration");
        }

        if ("DISABLED".equalsIgnoreCase(user.getAccountStatus())) {
            throw new org.springframework.security.oauth2.server.resource.InvalidBearerTokenException("User account is disabled");
        }
        if (user.getAccountStatus() != null && !"ACTIVE".equalsIgnoreCase(user.getAccountStatus())) {
            throw new org.springframework.security.oauth2.server.resource.InvalidBearerTokenException("User account is not active");
        }

        // Check revocable session if sid is present in JWT
        String sid = jwt.getClaimAsString("sid");
        if (sid != null && !sid.isBlank()) {
            try {
                java.util.UUID sessionId = java.util.UUID.fromString(sid);
                boolean validSession = authSessionService.validateAndTouchActiveSession(sessionId, user.getId());
                if (!validSession) {
                    throw new org.springframework.security.oauth2.server.resource.InvalidBearerTokenException("Session is revoked or expired");
                }
            } catch (IllegalArgumentException e) {
                throw new org.springframework.security.oauth2.server.resource.InvalidBearerTokenException("Malformed session ID in token");
            }
        }

        // A token that reached this path names no session this request has read: it can never have passed a
        // second factor.
        return authenticationFor(user, jwt, null);
    }

    /** Null when this token is not the ordinary case (the caller then runs the original path). */
    private AbstractAuthenticationToken convertWithSession(Jwt jwt) {
        Long claimedUserId = null;
        Object userIdClaim = jwt.getClaim("userId");
        if (userIdClaim instanceof Number n) {
            claimedUserId = n.longValue();
        } else if (userIdClaim instanceof String s) {
            try {
                claimedUserId = Long.parseLong(s);
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        String sid = jwt.getClaimAsString("sid");
        if (claimedUserId == null || sid == null || sid.isBlank()) return null;
        java.util.UUID sessionId;
        try {
            sessionId = java.util.UUID.fromString(sid);
        } catch (IllegalArgumentException e) {
            return null;
        }
        var loaded = authSessionService.loadForRequest(sessionId, claimedUserId);
        if (loaded == null) return null;
        User user = loaded.user();
        if ("DISABLED".equalsIgnoreCase(user.getAccountStatus())) {
            throw new org.springframework.security.oauth2.server.resource.InvalidBearerTokenException("User account is disabled");
        }
        if (user.getAccountStatus() != null && !"ACTIVE".equalsIgnoreCase(user.getAccountStatus())) {
            throw new org.springframework.security.oauth2.server.resource.InvalidBearerTokenException("User account is not active");
        }
        if (!authSessionService.validateLoaded(loaded)) {
            throw new org.springframework.security.oauth2.server.resource.InvalidBearerTokenException("Session is revoked or expired");
        }
        return authenticationFor(user, jwt, loaded.session());
    }
}
