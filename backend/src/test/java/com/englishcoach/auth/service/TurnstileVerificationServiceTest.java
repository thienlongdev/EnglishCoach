package com.englishcoach.auth.service;

import com.englishcoach.common.security.AuthSecurityProperties;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

class TurnstileVerificationServiceTest {

    @Test
    @DisplayName("Turnstile disabled: returns true without calling Cloudflare")
    void whenTurnstileDisabled_returnsTrue() {
        AuthSecurityProperties properties = new AuthSecurityProperties();
        properties.setTurnstileEnabled(false);
        properties.setTurnstileRequired(false);

        TurnstileVerificationService service = new TurnstileVerificationService(properties);

        boolean result = service.verifyToken(null, "127.0.0.1", "LOGIN");
        assertThat(result).isTrue();
    }

    @Test
    @DisplayName("Turnstile enabled but not required: missing token returns true")
    void whenTokenMissingAndNotRequired_returnsTrue() {
        AuthSecurityProperties properties = new AuthSecurityProperties();
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(false);

        TurnstileVerificationService service = new TurnstileVerificationService(properties);

        boolean result = service.verifyToken("", "127.0.0.1", "LOGIN");
        assertThat(result).isTrue();
    }

    @Test
    @DisplayName("Turnstile enabled and required: missing token throws IllegalArgumentException")
    void whenTokenMissingAndRequired_throwsException() {
        AuthSecurityProperties properties = new AuthSecurityProperties();
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(true);

        TurnstileVerificationService service = new TurnstileVerificationService(properties);

        assertThatThrownBy(() -> service.verifyToken(null, "127.0.0.1", "LOGIN"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Anti-bot verification challenge is required");
    }

    @Test
    @DisplayName("Production safety: fails closed if production profile is active and dummy test secret is used")
    void whenProductionProfileUsesDummySecret_validateProductionSecurityFailsClosed() {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("prod");

        AuthSecurityProperties properties = new AuthSecurityProperties(env);
        properties.setJwtSecret("a-very-secure-production-secret-key-32-chars-long!");
        properties.setTestFilterEnabled(false);
        properties.setTurnstileEnabled(true);
        properties.setTurnstileSecretKey("1x0000000000000000000000000000000AA");

        assertThatThrownBy(properties::validateProductionSecurity)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TURNSTILE_SECRET_KEY must be configured with a real Cloudflare secret key");

        properties.setTurnstileSecretKey("3x0000000000000000000000000000000AA");
        assertThatThrownBy(properties::validateProductionSecurity)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TURNSTILE_SECRET_KEY must be configured with a real Cloudflare secret key");
    }

    @Test
    @DisplayName("Production safety: passes when production profile uses a genuine secret key")
    void whenProductionProfileUsesGenuineSecret_validateProductionSecurityPasses() {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("prod");

        AuthSecurityProperties properties = new AuthSecurityProperties(env);
        properties.setJwtSecret("a-very-secure-production-secret-key-32-chars-long!");
        properties.setTestFilterEnabled(false);
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(true);
        properties.setTurnstileSecretKey("0x4AAAAAAAx_real_cloudflare_production_key_here");
        // security closure: production also needs its two independent purpose keys
        properties.setInternalServiceKey("independent-internal-service-key-for-this-test-0123");
        properties.setMfaEncryptionKey("independent-mfa-encryption-key-for-this-test-456789");

        properties.validateProductionSecurity();
    }

    @Test
    @DisplayName("Production safety: fails closed when the challenge is switched off or made optional in production")
    void whenProductionProfileMakesTurnstileOptional_validateProductionSecurityFailsClosed() {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("prod");

        AuthSecurityProperties optional = new AuthSecurityProperties(env);
        optional.setJwtSecret("a-very-secure-production-secret-key-32-chars-long!");
        optional.setTurnstileEnabled(true);
        optional.setTurnstileRequired(false);
        optional.setTurnstileSecretKey("0x4AAAAAAAx_real_cloudflare_production_key_here");
        assertThatThrownBy(optional::validateProductionSecurity)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TURNSTILE_ENABLED and TURNSTILE_REQUIRED must both be true");

        AuthSecurityProperties disabled = new AuthSecurityProperties(env);
        disabled.setJwtSecret("a-very-secure-production-secret-key-32-chars-long!");
        disabled.setTurnstileEnabled(false);
        disabled.setTurnstileRequired(false);
        assertThatThrownBy(disabled::validateProductionSecurity)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("TURNSTILE_ENABLED and TURNSTILE_REQUIRED must both be true");
    }

    @Test
    @DisplayName("Siteverify rejection: timeout-or-duplicate returns expired/reused error message")
    void whenSiteverifyReturnsTimeoutOrDuplicate_throwsExpiredException() {
        AuthSecurityProperties properties = new AuthSecurityProperties();
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(true);

        RestTemplate restTemplate = Mockito.mock(RestTemplate.class);
        Map<String, Object> responseBody = Map.of(
                "success", false,
                "error-codes", List.of("timeout-or-duplicate")
        );
        when(restTemplate.postForEntity(anyString(), any(HttpEntity.class), eq(Map.class)))
                .thenReturn(new ResponseEntity<>(responseBody, HttpStatus.OK));

        TurnstileVerificationService service = new TurnstileVerificationService(properties);
        service.setRestTemplate(restTemplate);

        assertThatThrownBy(() -> service.verifyToken("used-token", "1.2.3.4", "login"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Anti-bot verification challenge expired or already used");
    }

    @Test
    @DisplayName("Siteverify rejection: general failure throws challenge failed exception")
    void whenSiteverifyReturnsGeneralFailure_throwsFailedException() {
        AuthSecurityProperties properties = new AuthSecurityProperties();
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(true);

        RestTemplate restTemplate = Mockito.mock(RestTemplate.class);
        Map<String, Object> responseBody = Map.of(
                "success", false,
                "error-codes", List.of("invalid-input-response")
        );
        when(restTemplate.postForEntity(anyString(), any(HttpEntity.class), eq(Map.class)))
                .thenReturn(new ResponseEntity<>(responseBody, HttpStatus.OK));

        TurnstileVerificationService service = new TurnstileVerificationService(properties);
        service.setRestTemplate(restTemplate);

        assertThatThrownBy(() -> service.verifyToken("invalid-token", "1.2.3.4", "login"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Anti-bot verification challenge failed. Please try again.");
    }

    @Test
    @DisplayName("Siteverify success: matching action and localhost returns true")
    void whenSiteverifySuccessWithMatchingAction_returnsTrue() {
        AuthSecurityProperties properties = new AuthSecurityProperties();
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(true);

        RestTemplate restTemplate = Mockito.mock(RestTemplate.class);
        Map<String, Object> responseBody = Map.of(
                "success", true,
                "action", "login",
                "hostname", "localhost"
        );
        when(restTemplate.postForEntity(anyString(), any(HttpEntity.class), eq(Map.class)))
                .thenReturn(new ResponseEntity<>(responseBody, HttpStatus.OK));

        TurnstileVerificationService service = new TurnstileVerificationService(properties);
        service.setRestTemplate(restTemplate);

        boolean result = service.verifyToken("valid-token", "127.0.0.1", "login");
        assertThat(result).isTrue();
    }

    @Test
    @DisplayName("Siteverify success: action mismatch throws IllegalArgumentException")
    void whenSiteverifySuccessWithActionMismatch_throwsException() {
        AuthSecurityProperties properties = new AuthSecurityProperties();
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(true);

        RestTemplate restTemplate = Mockito.mock(RestTemplate.class);
        Map<String, Object> responseBody = Map.of(
                "success", true,
                "action", "register",
                "hostname", "localhost"
        );
        when(restTemplate.postForEntity(anyString(), any(HttpEntity.class), eq(Map.class)))
                .thenReturn(new ResponseEntity<>(responseBody, HttpStatus.OK));

        TurnstileVerificationService service = new TurnstileVerificationService(properties);
        service.setRestTemplate(restTemplate);

        assertThatThrownBy(() -> service.verifyToken("valid-token", "127.0.0.1", "login"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Anti-bot verification action mismatch");
    }

    @Test
    @DisplayName("Siteverify success in production: allowed hostnames pass")
    void whenProductionAllowedHostname_returnsTrue() {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("prod");

        AuthSecurityProperties properties = new AuthSecurityProperties(env);
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(true);
        properties.setTurnstileSecretKey("0x4AAAAAAAx_real_prod_key");

        RestTemplate restTemplate = Mockito.mock(RestTemplate.class);
        Map<String, Object> responseBody = Map.of(
                "success", true,
                "action", "forgot-password",
                "hostname", "englishcoach.io.vn"
        );
        when(restTemplate.postForEntity(anyString(), any(HttpEntity.class), eq(Map.class)))
                .thenReturn(new ResponseEntity<>(responseBody, HttpStatus.OK));

        TurnstileVerificationService service = new TurnstileVerificationService(properties);
        service.setRestTemplate(restTemplate);

        boolean result = service.verifyToken("valid-token", "1.2.3.4", "forgot-password");
        assertThat(result).isTrue();
    }

    @Test
    @DisplayName("Siteverify success in production: disallowed hostname throws IllegalArgumentException")
    void whenProductionDisallowedHostname_throwsException() {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("prod");

        AuthSecurityProperties properties = new AuthSecurityProperties(env);
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(true);
        properties.setTurnstileSecretKey("0x4AAAAAAAx_real_prod_key");

        RestTemplate restTemplate = Mockito.mock(RestTemplate.class);
        Map<String, Object> responseBody = Map.of(
                "success", true,
                "action", "forgot-password",
                "hostname", "evil-phishing-site.com"
        );
        when(restTemplate.postForEntity(anyString(), any(HttpEntity.class), eq(Map.class)))
                .thenReturn(new ResponseEntity<>(responseBody, HttpStatus.OK));

        TurnstileVerificationService service = new TurnstileVerificationService(properties);
        service.setRestTemplate(restTemplate);

        assertThatThrownBy(() -> service.verifyToken("valid-token", "1.2.3.4", "forgot-password"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Anti-bot verification hostname mismatch");
    }

    @Test
    @DisplayName("Siteverify network failure: fails closed when Turnstile is required")
    void whenNetworkFailsAndRequired_failsClosed() {
        AuthSecurityProperties properties = new AuthSecurityProperties();
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(true);

        RestTemplate restTemplate = Mockito.mock(RestTemplate.class);
        when(restTemplate.postForEntity(anyString(), any(HttpEntity.class), eq(Map.class)))
                .thenThrow(new ResourceAccessException("Connection timed out to Cloudflare"));

        TurnstileVerificationService service = new TurnstileVerificationService(properties);
        service.setRestTemplate(restTemplate);

        assertThatThrownBy(() -> service.verifyToken("valid-token", "1.2.3.4", "login"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Anti-bot verification service is temporarily unavailable");
    }

    @Test
    @DisplayName("Siteverify network failure: fails open when Turnstile is NOT required")
    void whenNetworkFailsAndNotRequired_failsOpen() {
        AuthSecurityProperties properties = new AuthSecurityProperties();
        properties.setTurnstileEnabled(true);
        properties.setTurnstileRequired(false);

        RestTemplate restTemplate = Mockito.mock(RestTemplate.class);
        when(restTemplate.postForEntity(anyString(), any(HttpEntity.class), eq(Map.class)))
                .thenThrow(new ResourceAccessException("Connection timed out to Cloudflare"));

        TurnstileVerificationService service = new TurnstileVerificationService(properties);
        service.setRestTemplate(restTemplate);

        boolean result = service.verifyToken("valid-token", "1.2.3.4", "login");
        assertThat(result).isTrue();
    }
}
