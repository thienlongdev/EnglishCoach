package com.englishcoach.common.security;

import jakarta.annotation.PostConstruct;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

@Configuration
@ConfigurationProperties(prefix = "app.security")
@Data
@Slf4j
public class AuthSecurityProperties {

    public static final String DEFAULT_DEV_SECRET = "a-very-secure-random-string-for-local-dev-123456";
    public static final String DEV_EXTENSION_ID = "kfepndgiddgljieglnilcaadlcgmdghj";

    private final Environment environment;

    private String jwtSecret = DEFAULT_DEV_SECRET;
    private int jwtLifetimeMinutes = 30;
    private int sessionIdleLifetimeHours = 24;
    private int sessionAbsoluteLifetimeDays = 7;
    private int sessionPendingLifetimeMinutes = 2;

    private int maxFailedLogins = 5;
    private int lockoutDurationMinutes = 15;

    private boolean testFilterEnabled = false;
    private String baseUrl = "http://localhost:3000";
    private String googleClientId = "";

    private boolean turnstileEnabled = false;
    private boolean turnstileRequired = false;
    private String turnstileSecretKey = "1x0000000000000000000000000000000AA";

    private String mailFrom = "English Coach <no-reply@englishcoach.io.vn>";
    private String mailMode = "auto";

    /**
     * Outside production only: ISO-8601 instant after which the token-issuing endpoints refuse a call without the
     * frontend server's signature ({@link InternalServiceAuthFilter}); blank = not enforced (local development,
     * tests). Production ignores it and always enforces: there is no unsigned window to configure.
     */
    private String internalAuthEnforceAfter = "";

    /**
     * Key of the frontend server's signed calls to the token-issuing endpoints ({@code APP_SECURITY_INTERNAL_SERVICE_KEY}).
     * The only secret the frontend container needs from the backend side; independent of {@link #jwtSecret}.
     * Blank outside production: derived from the signing secret (local development).
     */
    private String internalServiceKey = "";

    /** Dedicated key of second-factor secrets at rest ({@code APP_SECURITY_MFA_ENCRYPTION_KEY}); see MfaSecretCipher. */
    private String mfaEncryptionKey = "";

    /** Recipient of security alerts (sign-in factor changes, emergency reset, payment anomalies, refusal bursts). */
    private String alertEmail = "";

    /** Administrator second factor: {@code true} also refuses an administrator who has not enrolled one yet. */
    private boolean adminMfaRequired = false;
    /** How long a second-factor proof counts as fresh for a sensitive administrator action. */
    private int adminStepUpMinutes = 10;
    /** WebAuthn relying-party id (the site's host name); blank: derived from {@link #baseUrl}. */
    private String webauthnRpId = "";
    /**
     * One-time emergency reset of the administrator's second factors: a new non-blank value is consumed once at
     * start-up (factors removed, sessions revoked, audited). See the owner runbook; never leave it set.
     */
    private String adminMfaEmergencyResetToken = "";

    /** A purpose key must exist, be long enough and differ from the token-signing secret. */
    private void requireIndependentKey(String name, String value) {
        if (value == null || value.isBlank() || value.trim().length() < 32) {
            throw new IllegalStateException("[Security:Fatal] Production startup failed closed: " + name + " must be configured with a random value of at least 32 characters.");
        }
        if (value.trim().equals(jwtSecret == null ? "" : jwtSecret.trim())) {
            throw new IllegalStateException("[Security:Fatal] Production startup failed closed: " + name + " must not reuse AUTH_JWT_SECRET.");
        }
    }

    public java.time.Instant internalAuthEnforceAfterInstant() {
        if (internalAuthEnforceAfter == null || internalAuthEnforceAfter.isBlank()) return null;
        return java.time.Instant.parse(internalAuthEnforceAfter.trim());
    }

    public AuthSecurityProperties() {
        this.environment = null;
    }

    @Autowired(required = false)
    public AuthSecurityProperties(Environment environment) {
        this.environment = environment;
    }

    public boolean isProduction() {
        if (environment == null) return false;
        String[] activeProfiles = environment.getActiveProfiles();
        for (String profile : activeProfiles) {
            if ("prod".equalsIgnoreCase(profile) || "production".equalsIgnoreCase(profile)) {
                return true;
            }
        }
        return false;
    }

    /** The development signing secret, or one too short to resist guessing. */
    boolean weakJwtSecret() {
        return jwtSecret == null || jwtSecret.isBlank() || jwtSecret.equals(DEFAULT_DEV_SECRET) || jwtSecret.length() < 32;
    }

    /** True for a base URL served from this machine only (local development, tests, a staging stack on 127.0.0.1). */
    static boolean isLocalBaseUrl(String url) {
        if (url == null || url.isBlank()) return true;
        try {
            String host = java.net.URI.create(url.trim()).getHost();
            if (host == null) return true;
            host = host.toLowerCase(java.util.Locale.ROOT);
            return host.equals("localhost") || host.equals("127.0.0.1") || host.equals("[::1]") || host.equals("::1")
                    || host.endsWith(".localhost") || host.endsWith(".test");
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    @PostConstruct
    public void validateProductionSecurity() {
        // Security release 2026-11-16 (SEC-03): the published development secret is refused for any server that is not
        // local, whatever profile it runs (a deployment that lost SPRING_PROFILES_ACTIVE would otherwise sign and accept
        // tokens anyone can forge). Local development and tests keep their explicit defaults.
        if (!isProduction() && weakJwtSecret() && !isLocalBaseUrl(baseUrl)) {
            throw new IllegalStateException("[Security:Fatal] Startup failed closed: the development token-signing secret cannot serve "
                    + "a non-local address (app.security.base-url). Configure AUTH_JWT_SECRET (at least 32 random characters).");
        }
        if (isProduction()) {
            if (jwtSecret == null || jwtSecret.isBlank() || jwtSecret.equals(DEFAULT_DEV_SECRET) || jwtSecret.length() < 32) {
                throw new IllegalStateException("[Security:Fatal] Production startup failed closed: AUTH_JWT_SECRET / APP_SECURITY_JWT_SECRET must be configured with a non-default secret of at least 32 characters.");
            }
            // The filter reads its own key; both spellings of the switch must be off.
            boolean filterKeyOn = environment != null
                    && Boolean.parseBoolean(environment.getProperty("app.security.test-filter.enabled", "false"));
            if (testFilterEnabled || filterKeyOn) {
                throw new IllegalStateException("[Security:Fatal] Production startup failed closed: TestUserAuthenticationFilter must NOT be enabled in production (app.security.test-filter-enabled=false).");
            }
            if (turnstileEnabled || turnstileRequired) {
                if (turnstileSecretKey == null || turnstileSecretKey.isBlank() || turnstileSecretKey.matches("^[123]x0000000000.*") || turnstileSecretKey.contains("0000000000")) {
                    throw new IllegalStateException("[Security:Fatal] Production startup failed closed: TURNSTILE_SECRET_KEY must be configured with a real Cloudflare secret key, not a test dummy key.");
                }
            }
            if (!turnstileEnabled || !turnstileRequired) {
                throw new IllegalStateException("[Security:Fatal] Production startup failed closed: TURNSTILE_ENABLED and TURNSTILE_REQUIRED must both be true in production (docs/AGENTS.md section 6).");
            }
            // The exams AI judge credential has no default any more; the old published one is refused.
            String examsAiKey = environment != null ? environment.getProperty("app.exams.ai.api-key", "") : "";
            if ("ec-internal-exam-key".equals(examsAiKey.trim())) {
                throw new IllegalStateException("[Security:Fatal] Production startup failed closed: EXAMS_AI_INTERNAL_KEY must not be the published development value.");
            }
            // The publicly committed Echo Anywhere development extension ID must never be allowed in production.
            String extensionIds = environment != null ? environment.getProperty("app.echo-anywhere.extension-ids", "") : "";
            if (com.englishcoach.extension.EchoAnywhereConfig.parseIds(extensionIds).contains(DEV_EXTENSION_ID)) {
                throw new IllegalStateException("[Security:Fatal] Production startup failed closed: app.echo-anywhere.extension-ids must not include the published development extension ID.");
            }
            requireIndependentKey("APP_SECURITY_INTERNAL_SERVICE_KEY", internalServiceKey);
            requireIndependentKey("APP_SECURITY_MFA_ENCRYPTION_KEY", mfaEncryptionKey);
            if (internalServiceKey.trim().equals(mfaEncryptionKey.trim())) {
                throw new IllegalStateException("[Security:Fatal] Production startup failed closed: APP_SECURITY_INTERNAL_SERVICE_KEY and APP_SECURITY_MFA_ENCRYPTION_KEY must be different values.");
            }
            if (googleClientId == null || googleClientId.isBlank()) {
                log.warn("[Security:Warning] GOOGLE_CLIENT_ID is not configured: Google sign-in is refused until it is set (password sign-in is unaffected).");
            }
            if ("simulated".equalsIgnoreCase(mailMode)) {
                log.warn("[Security:Warning] Production is running with SimulatedMailDeliveryAdapter (app.security.mail-mode=simulated). Outbound transactional emails will NOT be delivered to real inboxes.");
            } else if ("smtp".equalsIgnoreCase(mailMode)) {
                String host = environment != null ? environment.getProperty("spring.mail.host") : null;
                if (host == null || host.isBlank()) {
                    throw new IllegalStateException("[Security:Fatal] Production startup failed closed: MAIL_HOST / spring.mail.host must be configured when mail-mode is smtp.");
                }
            }
            log.info("[Security] Production security configuration validated successfully.");
        }
    }
}
