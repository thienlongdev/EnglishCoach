package com.englishcoach.auth.mfa;

import com.englishcoach.auth.policy.OfficialAdminPolicy;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.auth.service.SecurityAuditService;
import com.englishcoach.common.security.AuthSecurityProperties;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

/**
 * Recovery of last resort for an administrator who has lost every second factor AND every recovery code. There is
 * no standing bypass: no password, header or URL skips the second factor. The proof is control of the server
 * itself: the owner writes a fresh random value (32 characters or more) into
 * {@code APP_SECURITY_ADMIN_MFA_EMERGENCY_RESET_TOKEN} in the production environment file and recreates the
 * backend. At start-up, once per value:
 * <ol>
 *   <li>every second factor and recovery code of the administrator account is removed;</li>
 *   <li>every session of that account is revoked;</li>
 *   <li>the reset is audited, and the value's digest is recorded so the same value never works again.</li>
 * </ol>
 * The administrator then signs in and enrols again (within 30 minutes of signing in). The owner removes the value
 * from the environment file afterwards; leaving it there has no further effect.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class AdminMfaEmergencyReset implements ApplicationRunner {

    private final AuthSecurityProperties properties;
    private final MfaStore store;
    private final AdminMfaGate gate;
    private final UserRepository users;
    private final AuthSessionService sessions;
    private final SecurityAuditService audit;

    @Override
    public void run(ApplicationArguments args) {
        String token = properties.getAdminMfaEmergencyResetToken();
        if (token == null || token.isBlank()) return;
        token = token.trim();
        if (token.length() < 32) {
            log.error("[MFA:EmergencyReset] Ignored: the one-time value must be at least 32 characters.");
            return;
        }
        var admin = users.findByEmailNormalized(OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL).orElse(null);
        if (admin == null) {
            log.error("[MFA:EmergencyReset] Ignored: the administrator account was not found.");
            return;
        }
        if (!store.recordEmergencyReset(digest(token), admin.getId())) {
            log.info("[MFA:EmergencyReset] This one-time value was already used; remove it from the environment file.");
            return;
        }
        store.deleteAllFactors(admin.getId());
        gate.evict(admin.getId());
        sessions.revokeAllUserSessions(admin.getId(), "MFA_EMERGENCY_RESET");
        audit.recordEvent("MFA_EMERGENCY_RESET", "SUCCESS", null, admin.getId(), null, "server", "startup",
                "OWNER_ENVIRONMENT_VALUE", null);
        log.warn("[MFA:EmergencyReset] Administrator second factors removed and sessions revoked. "
                + "Sign in, enrol again, then remove the one-time value from the environment file.");
    }

    private static String digest(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
