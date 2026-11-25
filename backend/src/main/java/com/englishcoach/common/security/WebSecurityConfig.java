package com.englishcoach.common.security;

import lombok.RequiredArgsConstructor;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;

@Configuration
@EnableWebSecurity
@EnableMethodSecurity
@RequiredArgsConstructor
public class WebSecurityConfig {

    private final CustomJwtAuthenticationConverter customJwtAuthenticationConverter;
    private final TestUserAuthenticationFilter testUserAuthenticationFilter;
    private final AuthSecurityProperties authSecurityProperties;
    private final CsrfTokenService csrfTokenService;

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    public JwtDecoder jwtDecoder() {
        SecretKey hmacKey = new SecretKeySpec(
                // ONE secret signs (AppJwtService) and verifies: the value AuthSecurityProperties validated at start-up
                // (security release 2026-11-16, SEC-03; this decoder used to read its own property chain with a default).
                authSecurityProperties.getJwtSecret().getBytes(StandardCharsets.UTF_8),
                "HmacSHA256"
        );
        // Only tokens this application signed are bearer tokens. A Google ID token is never one: it is exchanged once,
        // after full verification, at /api/v1/auth/google/exchange (GoogleIdTokenVerifier).
        return NimbusJwtDecoder.withSecretKey(hmacKey).build();
    }

    /** Prevents Spring Boot from auto-registering this @Component filter a second time outside the security chain. */
    @Bean
    public FilterRegistrationBean<TestUserAuthenticationFilter> testUserAuthenticationFilterRegistration(
            TestUserAuthenticationFilter filter) {
        FilterRegistrationBean<TestUserAuthenticationFilter> registration = new FilterRegistrationBean<>(filter);
        registration.setEnabled(false);
        return registration;
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        Class<org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter> bearerFilter =
                org.springframework.security.oauth2.server.resource.web.authentication.BearerTokenAuthenticationFilter.class;
        // Built here, not as beans: a Filter bean would also be registered outside the security chain.
        var internalServiceAuthFilter = new InternalServiceAuthFilter(authSecurityProperties, java.time.Clock.systemUTC());
        var sessionCookieFilter = new SessionCookieAuthenticationFilter(
                jwtDecoder(), customJwtAuthenticationConverter, authSecurityProperties);
        var cookieCsrfFilter = new CookieCsrfProtectionFilter(
                csrfTokenService, allowedOrigins, authSecurityProperties.isProduction());
        http
                // Spring's own CSRF support is session-based; this application is stateless. Requests authenticated
                // by the session cookie are protected by CookieCsrfProtectionFilter (origin + per-session token);
                // requests authenticated by an Authorization header cannot be forged by another site.
                .csrf(csrf -> csrf.disable())
                .cors(cors -> cors.configurationSource(corsConfigurationSource()))
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        .requestMatchers("/ws-card-blast/**", "/ws-card-blast").permitAll()
                        .requestMatchers("/api/v1/auth/**", "/api/auth/**").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/v1/premium/plans").permitAll()
                        // Echo Anywhere: the extension redeems a pairing code / refreshes its own grant (no cookie,
                        // PKCE-bound, rate-limited) and reads which extension ids may pair.
                        .requestMatchers(HttpMethod.POST, "/api/v1/extension/token").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/v1/extension/config").permitAll()
                        // Phase E: Public provider webhook callback (authenticated by SePay HMAC-SHA256 signature)
                        .requestMatchers(HttpMethod.POST, "/api/v1/payments/webhooks/sepay").permitAll()
                        // Public exam catalog and read-only media
                        .requestMatchers(HttpMethod.GET,
                                "/api/v1/exams/capabilities", "/api/v1/exams/catalog", "/api/v1/exams/catalog/**",
                                "/api/v1/exams/forms/*", "/api/v1/exams/forms/**", "/api/v1/exams/media/**",
                                "/api/v1/exams/mock-test/**")
                        .permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/mocktests", "/api/mocktests/").permitAll()
                        .requestMatchers(HttpMethod.POST, "/api/mocktests/*/submit").permitAll()
                        .requestMatchers("/api/mocktests/**").authenticated()
                        // Public learning content catalogs (read-only)
                        .requestMatchers(HttpMethod.GET, "/api/v1/content/**").permitAll()
                        // Speech synthesis, cached audio and pronunciation analysis need a signed-in learner (an
                        // anonymous audio upload is refused here, before the file is received); only the voice list and
                        // the four fixed voice previews are public. Shadowing has no anonymous use.
                        .requestMatchers(HttpMethod.GET, "/api/v1/speaking/tts/voices", "/api/v1/speaking/tts/preview")
                        .permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/v1/writing/capabilities", "/api/v1/writing/tasks")
                        .permitAll()
                        // Own user profile / avatar routes must require authentication before the public avatar rule.
                        .requestMatchers("/api/v1/users/me/**").authenticated()
                        // Public lexical dictionary lookup and user avatars for PvP and profiles
                        .requestMatchers(HttpMethod.GET, "/api/dictionary/**", "/api/v1/dictionary/**", "/api/v1/users/*/avatar").permitAll()
                        // Public community read endpoints
                        .requestMatchers(HttpMethod.GET, "/api/v1/community/feed", "/api/v1/community/feed/**", "/api/v1/community/media/**", "/api/v1/community/posts/*", "/api/v1/community/posts/*/comments", "/api/v1/community/posts/*/reactions", "/api/v1/community/users/*/profile").permitAll()
                        .requestMatchers(HttpMethod.HEAD, "/api/v1/community/media/**").permitAll()
                        // Private operator / admin endpoints
                        .requestMatchers("/api/v1/admin/**", "/api/v1/feedback/admin/**").hasRole("ADMIN")
                        // Administrator routes that live under a learner module's prefix: the role is decided here,
                        // before the body is read or validated (their handlers check it again).
                        .requestMatchers("/api/v1/listening/admin/**", "/api/v1/listening/system/**",
                                "/api/v1/reading/admin/**").hasRole("ADMIN")
                        // All user-owned learning modules and exam attempts require authentication
                        .requestMatchers("/api/v1/flashcards/**", "/api/flashcards/**").authenticated()
                        .requestMatchers("/api/v1/reading/**").authenticated()
                        .requestMatchers("/api/v1/listening/**").authenticated()
                        .requestMatchers("/api/v1/speaking/**").authenticated()
                        .requestMatchers("/api/v1/writing/**").authenticated()
                        .requestMatchers("/api/v1/exams/**").authenticated()
                        .anyRequest().authenticated())
                // Order: signature of server-to-server token calls, test identity (never in production), the session
                // cookie, then the Authorization header (BearerTokenAuthenticationFilter), then the CSRF rules for
                // whatever the cookie authenticated.
                .addFilterBefore(internalServiceAuthFilter, bearerFilter)
                .addFilterBefore(testUserAuthenticationFilter, bearerFilter)
                .addFilterBefore(sessionCookieFilter, bearerFilter)
                .addFilterAfter(cookieCsrfFilter, bearerFilter)
                // An Echo Anywhere session reaches only its allow-list (EchoAnywhereScopeFilter).
                .addFilterAfter(new com.englishcoach.extension.EchoAnywhereScopeFilter(), cookieCsrfFilter.getClass())
                .oauth2ResourceServer(oauth2 -> oauth2
                        .jwt(jwt -> jwt.jwtAuthenticationConverter(customJwtAuthenticationConverter)));

        return http.build();
    }

    @org.springframework.beans.factory.annotation.Value("${app.security.cors-allowed-origins:http://localhost:3000,http://127.0.0.1:3000}")
    private String allowedOrigins;

    @org.springframework.beans.factory.annotation.Value("${app.echo-anywhere.extension-ids:}")
    private String echoAnywhereIds;

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        java.util.List<String> webOrigins = allowedOrigins == null ? java.util.List.of()
                : java.util.Arrays.stream(allowedOrigins.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .toList();

        CorsConfiguration webConfiguration = new CorsConfiguration();
        webConfiguration.setAllowedOrigins(webOrigins);
        webConfiguration.setAllowedMethods(Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        webConfiguration.setAllowedHeaders(Arrays.asList("*"));
        webConfiguration.setAllowCredentials(true);

        // Echo Anywhere extensions authenticate strictly via Authorization header (never browser cookies),
        // so chrome-extension:// origins must NEVER be granted Access-Control-Allow-Credentials: true.
        java.util.List<String> extensionOrigins = com.englishcoach.extension.EchoAnywhereConfig.parseIds(echoAnywhereIds).stream()
                .map(id -> "chrome-extension://" + id)
                .toList();
        CorsConfiguration extensionConfiguration = new CorsConfiguration();
        extensionConfiguration.setAllowedOrigins(extensionOrigins);
        extensionConfiguration.setAllowedMethods(Arrays.asList("GET", "POST", "DELETE", "OPTIONS"));
        extensionConfiguration.setAllowedHeaders(Arrays.asList("*"));
        extensionConfiguration.setAllowCredentials(false);

        return request -> {
            String origin = request.getHeader("Origin");
            if (origin != null && origin.startsWith("chrome-extension://")) {
                return extensionOrigins.isEmpty() ? null : extensionConfiguration;
            }
            return webConfiguration;
        };
    }
}
