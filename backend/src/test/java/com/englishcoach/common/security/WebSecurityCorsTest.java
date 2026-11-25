package com.englishcoach.common.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;

import static org.assertj.core.api.Assertions.assertThat;

class WebSecurityCorsTest {

    @Test
    @DisplayName("CORS: Production allowed origins validate https://englishcoach.io.vn and www")
    void whenProductionOriginsConfigured_allowsProductionDomains() {
        WebSecurityConfig config = new WebSecurityConfig(null, null, null, null);
        ReflectionTestUtils.setField(config, "allowedOrigins", "https://englishcoach.io.vn,https://www.englishcoach.io.vn");

        CorsConfigurationSource source = config.corsConfigurationSource();
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/v1/auth/register");

        CorsConfiguration corsConfig = source.getCorsConfiguration(request);
        assertThat(corsConfig).isNotNull();

        assertThat(corsConfig.checkOrigin("https://englishcoach.io.vn")).isEqualTo("https://englishcoach.io.vn");
        assertThat(corsConfig.checkOrigin("https://www.englishcoach.io.vn")).isEqualTo("https://www.englishcoach.io.vn");
        assertThat(corsConfig.checkOrigin("https://evil-site.com")).isNull();
        assertThat(corsConfig.checkOrigin("http://localhost:3000")).isNull();
    }

    @Test
    @DisplayName("CORS: Default localhost origins allow localhost:3000 and 127.0.0.1:3000")
    void whenDefaultLocalhostOrigins_allowsLocalhost() {
        WebSecurityConfig config = new WebSecurityConfig(null, null, null, null);
        ReflectionTestUtils.setField(config, "allowedOrigins", "http://localhost:3000,http://127.0.0.1:3000");

        CorsConfigurationSource source = config.corsConfigurationSource();
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/v1/auth/register");

        CorsConfiguration corsConfig = source.getCorsConfiguration(request);
        assertThat(corsConfig).isNotNull();

        assertThat(corsConfig.checkOrigin("http://localhost:3000")).isEqualTo("http://localhost:3000");
        assertThat(corsConfig.checkOrigin("http://127.0.0.1:3000")).isEqualTo("http://127.0.0.1:3000");
        assertThat(corsConfig.checkOrigin("https://englishcoach.io.vn")).isNull();
    }
}
