package com.englishcoach.common.security;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** SEC-03: the published development signing secret never serves a non-local address, whatever the profile. */
class DevSecretGuardTest {

    private static AuthSecurityProperties props(String secret, String baseUrl) {
        AuthSecurityProperties p = new AuthSecurityProperties(new MockEnvironment());
        p.setJwtSecret(secret);
        p.setBaseUrl(baseUrl);
        return p;
    }

    @Test
    void localDevelopmentKeepsItsDefault() {
        assertThatCode(() -> props(AuthSecurityProperties.DEFAULT_DEV_SECRET, "http://localhost:3000").validateProductionSecurity())
                .doesNotThrowAnyException();
        assertThatCode(() -> props(AuthSecurityProperties.DEFAULT_DEV_SECRET, "http://127.0.0.1:3000").validateProductionSecurity())
                .doesNotThrowAnyException();
    }

    @Test
    void aPublicAddressWithTheDevelopmentSecretFailsClosed() {
        assertThatThrownBy(() -> props(AuthSecurityProperties.DEFAULT_DEV_SECRET, "https://englishcoach.io.vn").validateProductionSecurity())
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> props("short", "https://staging.example.com").validateProductionSecurity())
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void aPublicAddressWithAStrongSecretStarts() {
        assertThatCode(() -> props("s".repeat(40), "https://staging.example.com").validateProductionSecurity())
                .doesNotThrowAnyException();
    }
}
