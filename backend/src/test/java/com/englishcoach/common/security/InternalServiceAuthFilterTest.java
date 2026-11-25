package com.englishcoach.common.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The token-issuing endpoints accept only the frontend server's signed calls: dedicated key, bound to path, time and
 * exact body, single-use. Production has no unsigned window at all; outside production an unsigned call is
 * tolerated until the configured instant (local development, tests).
 */
class InternalServiceAuthFilterTest {

    private static final String SECRET = "unit-test-application-signing-secret-0123456789";
    private static final String SERVICE_KEY = "unit-test-dedicated-internal-service-key-0123456789";
    private static final Instant NOW = Instant.parse("2026-10-15T10:00:00Z");
    private static final byte[] KEY = DerivedKeys.derive(SERVICE_KEY, DerivedKeys.INTERNAL_SERVICE);
    private static final byte[] BODY = "{\"sessionGrant\":\"g\"}".getBytes(StandardCharsets.UTF_8);

    private static AuthSecurityProperties properties(boolean production) {
        MockEnvironment env = new MockEnvironment();
        if (production) env.setActiveProfiles("prod");
        AuthSecurityProperties properties = new AuthSecurityProperties(env);
        properties.setJwtSecret(SECRET);
        properties.setInternalServiceKey(SERVICE_KEY);
        return properties;
    }

    private static InternalServiceAuthFilter filter(String enforceAfter) {
        AuthSecurityProperties properties = properties(false);
        properties.setInternalAuthEnforceAfter(enforceAfter);
        return new InternalServiceAuthFilter(properties, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static InternalServiceAuthFilter production() {
        return new InternalServiceAuthFilter(properties(true), Clock.fixed(NOW, ZoneOffset.UTC));
    }

    /** The status the chain ends with: 200 when the request reached the application (whose body is then checked). */
    private static int call(InternalServiceAuthFilter filter, String method, String uri, String header, byte[] body) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest(method, uri);
        request.setContent(body);
        if (header != null) request.addHeader(InternalServiceAuthFilter.HEADER, header);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter.doFilter(request, response, chain);
        if (chain.getRequest() == null) return response.getStatus();
        // the controller still reads the exact body the signature covered
        assertThat(chain.getRequest().getInputStream().readAllBytes()).isEqualTo(body);
        return 200;
    }

    private static int call(InternalServiceAuthFilter filter, String uri, String header) throws Exception {
        return call(filter, "POST", uri, header, BODY);
    }

    private static String nonce() {
        return UUID.randomUUID().toString().replace("-", "");
    }

    private static String signed(long epochSeconds, String path) {
        return InternalServiceAuthFilter.sign(KEY, epochSeconds, nonce(), "POST", path, BODY);
    }

    @Test
    @DisplayName("Production: an unsigned call is refused from the first second, whatever the configured window says")
    void productionHasNoUnsignedWindow() throws Exception {
        AuthSecurityProperties props = properties(true);
        props.setInternalAuthEnforceAfter("2099-01-01T00:00:00Z");
        InternalServiceAuthFilter prod = new InternalServiceAuthFilter(props, Clock.fixed(NOW, ZoneOffset.UTC));
        for (String path : new String[]{"/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/auth/session/refresh",
                "/api/v1/auth/session/exchange", "/api/v1/auth/google/exchange", "/api/v1/auth/google/link",
                "/api/auth/login", "/api/auth/refresh"}) {
            assertThat(call(prod, path, null)).as(path).isEqualTo(401);
            assertThat(call(prod, path, signed(NOW.getEpochSecond(), path))).as(path).isEqualTo(200);
        }
    }

    @Test
    @DisplayName("Outside production an unsigned call is tolerated before the cut-off only; a presented signature is always checked")
    void developmentWindow() throws Exception {
        assertThat(call(filter("2026-10-17T00:00:00Z"), "/api/v1/auth/refresh", null)).isEqualTo(200);
        assertThat(call(filter(""), "/api/v1/auth/login", null)).isEqualTo(200);
        assertThat(call(filter("2026-10-15T00:00:00Z"), "/api/v1/auth/login", null)).isEqualTo(401);
        assertThat(call(filter("2026-10-17T00:00:00Z"), "/api/v1/auth/refresh", "v2.1.00.deadbeef")).isEqualTo(401);
    }

    @Test
    @DisplayName("A signature is bound to its endpoint, its time and its exact body")
    void signatureIsBoundToPathTimeAndBody() throws Exception {
        InternalServiceAuthFilter prod = production();
        long now = NOW.getEpochSecond();
        String path = "/api/v1/auth/refresh";
        assertThat(call(prod, path, signed(now - 100, path))).isEqualTo(200);
        assertThat(call(prod, path, signed(now - 121, path))).as("older than two minutes").isEqualTo(401);
        assertThat(call(prod, path, signed(now + 121, path))).as("from the future").isEqualTo(401);
        assertThat(call(prod, path, signed(now, "/api/v1/auth/login"))).as("signed for another endpoint").isEqualTo(401);
        byte[] other = "{\"sessionGrant\":\"another\"}".getBytes(StandardCharsets.UTF_8);
        assertThat(call(prod, "POST", path, signed(now, path), other)).as("body swapped under a valid header").isEqualTo(401);
        assertThat(call(prod, "POST", path, InternalServiceAuthFilter.sign(KEY, now, nonce(), "POST", path, other), other))
                .isEqualTo(200);
    }

    @Test
    @DisplayName("A signature works once: the same header replayed (even within two minutes) is refused")
    void signatureIsSingleUse() throws Exception {
        InternalServiceAuthFilter prod = production();
        String path = "/api/v1/auth/session/refresh";
        String header = signed(NOW.getEpochSecond(), path);
        assertThat(call(prod, path, header)).isEqualTo(200);
        assertThat(call(prod, path, header)).as("replay").isEqualTo(401);
    }

    @Test
    @DisplayName("Keys are independent: the token-signing secret, its derived keys and the old v1 format sign nothing")
    void keysAreIndependent() throws Exception {
        InternalServiceAuthFilter prod = production();
        long now = NOW.getEpochSecond();
        String path = "/api/v1/auth/login";
        byte[] fromJwtSecret = DerivedKeys.derive(SECRET, DerivedKeys.INTERNAL_SERVICE);
        assertThat(call(prod, path, InternalServiceAuthFilter.sign(fromJwtSecret, now, nonce(), "POST", path, BODY))).isEqualTo(401);
        byte[] csrfKey = DerivedKeys.derive(SERVICE_KEY, DerivedKeys.CSRF);
        assertThat(call(prod, path, InternalServiceAuthFilter.sign(csrfKey, now, nonce(), "POST", path, BODY))).isEqualTo(401);
        String v1 = "v1." + now + "." + DerivedKeys.hmacHex(fromJwtSecret, now + "\nPOST\n" + path);
        assertThat(call(prod, path, v1)).as("the first V3 header format").isEqualTo(401);
        for (String malformed : new String[]{"", "v2", "v2.abc.def.ghi", "v2." + now + ".00.00", "v2." + now + "." + "Z".repeat(32) + ".00",
                "v2.99999999999999999999." + nonce() + ".00"}) {
            assertThat(call(prod, path, malformed)).as(malformed).isEqualTo(401);
        }
    }

    @Test
    @DisplayName("An oversized body is refused before any parsing")
    void oversizedBody() throws Exception {
        byte[] big = new byte[InternalServiceAuthFilter.MAX_BODY_BYTES + 1];
        String path = "/api/v1/auth/login";
        String header = InternalServiceAuthFilter.sign(KEY, NOW.getEpochSecond(), nonce(), "POST", path, big);
        assertThat(call(production(), "POST", path, header, big)).isEqualTo(401);
    }

    @Test
    @DisplayName("Only the token-issuing endpoints are concerned: the browser's own account endpoints stay reachable")
    void otherEndpointsAreNotConcerned() throws Exception {
        InternalServiceAuthFilter prod = production();
        for (String path : new String[]{"/api/v1/auth/register", "/api/v1/auth/forgot-password", "/api/v1/auth/reset-password",
                "/api/v1/auth/verify-email", "/api/v1/auth/resend-verification", "/api/v1/auth/logout",
                "/api/v1/auth/change-password", "/api/v1/flashcards", "/api/v1/payments/webhooks/sepay",
                "/api/v1/auth/login/extra", "/api/v1/authx/login"}) {
            assertThat(call(prod, path, null)).as(path).isEqualTo(200);
        }
        assertThat(call(prod, "GET", "/api/v1/auth/me", null, new byte[0])).isEqualTo(200);
        assertThat(call(prod, "GET", "/api/v1/auth/login", null, new byte[0])).as("the rule is on the POST that issues tokens").isEqualTo(200);
    }

    @Test
    @DisplayName("A malformed cut-off stops the application from starting rather than silently never enforcing")
    void malformedCutOffFailsClosed() {
        org.junit.jupiter.api.Assertions.assertThrows(RuntimeException.class, () -> filter("next tuesday"));
    }

    @Test
    @DisplayName("Production refuses to start without independent purpose keys")
    void productionNeedsIndependentKeys() {
        AuthSecurityProperties p = properties(true);
        p.setTurnstileEnabled(true);
        p.setTurnstileRequired(true);
        p.setTurnstileSecretKey("0x4AAAAAAAreal-looking-secret-for-test");
        p.setMfaEncryptionKey("unit-test-dedicated-mfa-encryption-key-0123456789");
        p.validateProductionSecurity();
        p.setInternalServiceKey("");
        org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, p::validateProductionSecurity);
        p.setInternalServiceKey(SECRET);
        org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, p::validateProductionSecurity);
        p.setInternalServiceKey(SERVICE_KEY);
        p.setMfaEncryptionKey(SERVICE_KEY);
        org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, p::validateProductionSecurity);
    }
}
