package com.englishcoach.common.security;

import com.englishcoach.auth.entity.AuthSession;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.policy.OfficialAdminPolicy;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import jakarta.servlet.Filter;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.junit.jupiter.SpringExtension;
import org.springframework.test.context.web.WebAppConfiguration;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;

import java.time.Instant;
import java.util.Date;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The real security filter chain with a browser that authenticates by the session cookie: what the cookie admits,
 * what a forged cross-site request can and cannot do with it, and that the administrator's authority depends on the
 * second factor. The stub controller answers "ok:&lt;authorities&gt;" to everything it is allowed to receive.
 */
@ExtendWith(SpringExtension.class)
@WebAppConfiguration
@ContextConfiguration(classes = {WebSecurityConfig.class, CookieSessionSecurityTest.Stub.class})
@TestPropertySource(properties = {
        "AUTH_JWT_SECRET=" + CookieSessionSecurityTest.APP_SECRET,
        "app.security.cors-allowed-origins=https://englishcoach.io.vn,https://www.englishcoach.io.vn"})
class CookieSessionSecurityTest {

    static final String APP_SECRET = "unit-test-application-signing-secret-0123456789";
    static final String ORIGIN = "https://englishcoach.io.vn";
    static final UUID LEARNER_SESSION = UUID.fromString("11111111-1111-1111-1111-111111111111");
    static final UUID OTHER_SESSION = UUID.fromString("22222222-2222-2222-2222-222222222222");
    static final UUID ADMIN_SESSION = UUID.fromString("33333333-3333-3333-3333-333333333333");
    static final UUID REVOKED_SESSION = UUID.fromString("44444444-4444-4444-4444-444444444444");

    /** What the second-factor policy answers for the administrator in the current test. */
    static final AtomicReference<AuthSessionContext.AdminAccess> ADMIN_ACCESS =
            new AtomicReference<>(AuthSessionContext.AdminAccess.GRANTED);

    @Configuration
    @EnableWebMvc
    static class Stub {
        @Bean
        UserRepository userRepository() {
            return Mockito.mock(UserRepository.class);
        }

        @Bean
        AuthSessionService authSessionService() {
            return Mockito.mock(AuthSessionService.class);
        }

        @Bean
        CustomJwtAuthenticationConverter customJwtAuthenticationConverter(UserRepository users, AuthSessionService sessions) {
            CustomJwtAuthenticationConverter converter = new CustomJwtAuthenticationConverter(users, sessions);
            converter.setAdminSecondFactorPolicy((userId, mfaVerifiedAt) -> ADMIN_ACCESS.get());
            return converter;
        }

        @Bean
        TestUserAuthenticationFilter testUserAuthenticationFilter(UserRepository users) {
            return new TestUserAuthenticationFilter(users);
        }

        @Bean
        AuthSecurityProperties authSecurityProperties() {
            AuthSecurityProperties properties = new AuthSecurityProperties();
            properties.setJwtSecret(APP_SECRET);
            return properties;
        }

        @Bean
        CsrfTokenService csrfTokenService(AuthSecurityProperties properties) {
            return new CsrfTokenService(properties);
        }

        @Bean
        Everything everything() {
            return new Everything();
        }
    }

    @RestController
    static class Everything {
        @RequestMapping("/**")
        String ok(Authentication authentication) {
            return "ok:" + (authentication == null ? "anonymous" : authentication.getAuthorities());
        }
    }

    @Autowired
    private WebApplicationContext context;
    @Autowired
    private AuthSessionService sessions;
    @Autowired
    private CsrfTokenService csrf;

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        Filter chain = context.getBean("springSecurityFilterChain", Filter.class);
        mvc = MockMvcBuilders.webAppContextSetup(context).addFilters(chain).build();
        ADMIN_ACCESS.set(AuthSessionContext.AdminAccess.GRANTED);
        Mockito.reset(sessions);
        session(LEARNER_SESSION, user(7L, "learner@example.test", Role.ROLE_USER), true);
        session(OTHER_SESSION, user(8L, "other@example.test", Role.ROLE_USER), true);
        session(ADMIN_SESSION, user(1L, OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL, Role.ROLE_ADMIN), true);
        session(REVOKED_SESSION, user(9L, "gone@example.test", Role.ROLE_USER), false);
    }

    private static User user(long id, String email, Role role) {
        return User.builder().id(id).email(email).name("Test").password("x").role(role).build();
    }

    private void session(UUID id, User user, boolean valid) {
        AuthSession session = AuthSession.builder().id(id).user(user).state(valid ? "ACTIVE" : "REVOKED")
                .authMethod("CREDENTIALS").authenticatedAt(Instant.now()).build();
        var loaded = new AuthSessionService.RequestSession(session, user);
        when(sessions.loadForRequest(eq(id), eq(user.getId()))).thenReturn(loaded);
        when(sessions.validateLoaded(loaded)).thenReturn(valid);
    }

    private static String token(long userId, UUID sessionId, String secret, long lifetimeMillis) throws Exception {
        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), new JWTClaimsSet.Builder()
                .subject(String.valueOf(userId)).claim("userId", userId).claim("sid", sessionId.toString())
                .expirationTime(new Date(System.currentTimeMillis() + lifetimeMillis)).build());
        jwt.sign(new MACSigner(secret));
        return jwt.serialize();
    }

    private static Cookie sessionCookie(long userId, UUID sessionId) throws Exception {
        return new Cookie(SessionCookies.ACCESS, token(userId, sessionId, APP_SECRET, 60_000));
    }

    /** A write as this site's own page sends it: the cookie, its origin, same-origin fetch metadata, the token. */
    private MockHttpServletRequestBuilder ownPage(MockHttpServletRequestBuilder request, long userId, UUID sessionId)
            throws Exception {
        return request.cookie(sessionCookie(userId, sessionId)).header("Origin", ORIGIN)
                .header("Sec-Fetch-Site", "same-origin")
                .header(CookieCsrfProtectionFilter.HEADER, csrf.tokenFor(sessionId));
    }

    // ---------------------------------------------------------------- the cookie authenticates

    @Test
    @DisplayName("The session cookie authenticates a read exactly as a header token would; no cookie, no access")
    void cookieAuthenticatesReads() throws Exception {
        mvc.perform(get("/api/v1/users/me")).andExpect(status().isUnauthorized());
        mvc.perform(get("/api/v1/users/me").cookie(sessionCookie(7L, LEARNER_SESSION)))
                .andExpect(status().isOk()).andExpect(content().string("ok:[ROLE_USER]"));
        mvc.perform(get("/api/v1/users/me").header(HttpHeaders.AUTHORIZATION,
                        "Bearer " + token(7L, LEARNER_SESSION, APP_SECRET, 60_000)))
                .andExpect(status().isOk());
    }

    @Test
    @DisplayName("The unprefixed development cookie name is honoured outside production only; other names never")
    void onlyTheSessionCookieNameCounts() throws Exception {
        String token = token(7L, LEARNER_SESSION, APP_SECRET, 60_000);
        mvc.perform(get("/api/v1/users/me").cookie(new Cookie("ec_at", token))).andExpect(status().isOk());
        for (String name : new String[]{"auth_token", "ec_session_grant", "access_token", "__Secure-ec_at", "token"}) {
            mvc.perform(get("/api/v1/users/me").cookie(new Cookie(name, token))).andExpect(status().isUnauthorized());
        }
        assertThat(SessionCookies.accessToken(new org.springframework.mock.web.MockHttpServletRequest() {{
            setCookies(new Cookie("ec_at", token));
        }}, true)).as("production reads the __Host- cookie only").isNull();
    }

    @Test
    @DisplayName("A cookie that no longer authenticates is dropped: public endpoints still answer, protected ones answer 401")
    void deadCookieIsDroppedNotFatal() throws Exception {
        Cookie[] dead = {
                new Cookie(SessionCookies.ACCESS, token(7L, LEARNER_SESSION, APP_SECRET, -60_000)),            // expired
                new Cookie(SessionCookies.ACCESS, token(7L, LEARNER_SESSION, "another-secret-another-secret-0123456789", 60_000)),
                new Cookie(SessionCookies.ACCESS, "not-a-token"),
                sessionCookie(9L, REVOKED_SESSION),                                                            // revoked session
        };
        for (Cookie cookie : dead) {
            MockHttpServletResponse publicAnswer = mvc.perform(get("/api/v1/exams/capabilities").cookie(cookie))
                    .andExpect(status().isOk()).andExpect(content().string("ok:anonymous")).andReturn().getResponse();
            assertThat(publicAnswer.getHeaders("Set-Cookie")).anyMatch(h -> h.startsWith(SessionCookies.ACCESS + "=;") && h.contains("Max-Age=0"));
            mvc.perform(get("/api/v1/flashcards/decks").cookie(cookie)).andExpect(status().isUnauthorized());
        }
    }

    @Test
    @DisplayName("A session cookie of one learner never becomes another: the token names its own session and account")
    void cookieCannotBeRetargeted() throws Exception {
        // learner 7's session id claimed by account 8: no such (session, account) pair exists
        mvc.perform(get("/api/v1/users/me").cookie(sessionCookie(8L, LEARNER_SESSION))).andExpect(status().isUnauthorized());
    }

    // ---------------------------------------------------------------- cross-site request forgery

    @Test
    @DisplayName("CSRF: a write with the cookie needs this site's origin AND the session's token; the page's own write passes")
    void writesNeedOriginAndToken() throws Exception {
        mvc.perform(ownPage(post("/api/v1/flashcards"), 7L, LEARNER_SESSION)).andExpect(status().isOk());
        mvc.perform(ownPage(put("/api/v1/users/me/profile"), 7L, LEARNER_SESSION)).andExpect(status().isOk());
        mvc.perform(ownPage(delete("/api/v1/flashcards/5"), 7L, LEARNER_SESSION)).andExpect(status().isOk());

        // what a hostile page can make the browser send: the cookie, and nothing it cannot know or set
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION)))
                .andExpect(status().isForbidden()).andExpect(content().string(org.hamcrest.Matchers.containsString("CSRF_REJECTED")));
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION))
                        .header("Origin", "https://evil.example").header("Sec-Fetch-Site", "cross-site"))
                .andExpect(status().isForbidden());
        // right token, wrong origin (token leaked some other way): still refused
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION))
                        .header("Origin", "https://evil.example")
                        .header(CookieCsrfProtectionFilter.HEADER, csrf.tokenFor(LEARNER_SESSION)))
                .andExpect(status().isForbidden());
        // right origin, no token (a same-site sibling page, an old client)
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION))
                        .header("Origin", ORIGIN).header("Sec-Fetch-Site", "same-origin"))
                .andExpect(status().isForbidden());
        // origin and token right, but the browser says the request came from another site
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION))
                        .header("Origin", ORIGIN).header("Sec-Fetch-Site", "cross-site")
                        .header(CookieCsrfProtectionFilter.HEADER, csrf.tokenFor(LEARNER_SESSION)))
                .andExpect(status().isForbidden());
        // no Origin and no Referer at all
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION))
                        .header(CookieCsrfProtectionFilter.HEADER, csrf.tokenFor(LEARNER_SESSION)))
                .andExpect(status().isForbidden());
        // "null" origin (sandboxed frame, data: URL)
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION)).header("Origin", "null")
                        .header(CookieCsrfProtectionFilter.HEADER, csrf.tokenFor(LEARNER_SESSION)))
                .andExpect(status().isForbidden());
    }

    @Test
    @DisplayName("CSRF: the token is bound to its session; another learner's token, or a look-alike origin, does not pass")
    void tokenIsBoundToTheSession() throws Exception {
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION)).header("Origin", ORIGIN)
                        .header(CookieCsrfProtectionFilter.HEADER, csrf.tokenFor(OTHER_SESSION)))
                .andExpect(status().isForbidden());
        assertThat(csrf.tokenFor(LEARNER_SESSION)).isNotEqualTo(csrf.tokenFor(OTHER_SESSION)).hasSizeGreaterThanOrEqualTo(43);
        for (String lookAlike : new String[]{"https://englishcoach.io.vn.evil.example", "http://englishcoach.io.vn",
                "https://evil.example/https://englishcoach.io.vn", "https://sub.englishcoach.io.vn", "https://englishcoach.io.vn:8443"}) {
            mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION)).header("Origin", lookAlike)
                            .header(CookieCsrfProtectionFilter.HEADER, csrf.tokenFor(LEARNER_SESSION)))
                    .andExpect(status().isForbidden());
        }
        // Referer is the fallback when a browser sends no Origin
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION))
                        .header("Referer", ORIGIN + "/reading?x=1")
                        .header(CookieCsrfProtectionFilter.HEADER, csrf.tokenFor(LEARNER_SESSION)))
                .andExpect(status().isOk());
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(7L, LEARNER_SESSION))
                        .header("Referer", "https://evil.example/" )
                        .header(CookieCsrfProtectionFilter.HEADER, csrf.tokenFor(LEARNER_SESSION)))
                .andExpect(status().isForbidden());
    }

    @Test
    @DisplayName("CSRF rules do not touch what another site cannot forge: header tokens, safe methods, signed webhooks")
    void whatIsNotCookieAuthenticatedIsUnaffected() throws Exception {
        mvc.perform(post("/api/v1/flashcards").header(HttpHeaders.AUTHORIZATION,
                "Bearer " + token(7L, LEARNER_SESSION, APP_SECRET, 60_000))).andExpect(status().isOk());
        // a safe method needs no token; from this site's own origin it simply works
        mvc.perform(get("/api/v1/flashcards/decks").cookie(sessionCookie(7L, LEARNER_SESSION))
                .header("Origin", ORIGIN)).andExpect(status().isOk());
        // from another origin even a read is refused (CORS admits this application's origins only), so a hostile
        // page can neither change nor read anything with the learner's cookie
        mvc.perform(get("/api/v1/flashcards/decks").cookie(sessionCookie(7L, LEARNER_SESSION))
                .header("Origin", "https://evil.example")).andExpect(status().isForbidden());
        mvc.perform(get("/api/v1/auth/csrf").cookie(sessionCookie(7L, LEARNER_SESSION))
                .header("Origin", "https://evil.example")).andExpect(status().isForbidden());
        mvc.perform(post("/api/v1/payments/webhooks/sepay")).andExpect(status().isOk());
        // with both a header and a cookie the header decides (and the cookie's CSRF rules do not apply)
        mvc.perform(post("/api/v1/flashcards").cookie(sessionCookie(8L, OTHER_SESSION)).header(HttpHeaders.AUTHORIZATION,
                "Bearer " + token(7L, LEARNER_SESSION, APP_SECRET, 60_000))).andExpect(status().isOk());
    }

    @Test
    @DisplayName("Account endpoints that never act on the session ignore the cookie; those that do are protected")
    void identityLessAccountEndpoints() throws Exception {
        for (String path : new String[]{"register", "verify-email", "resend-verification", "forgot-password",
                "reset-password", "login", "refresh", "logout", "google/exchange", "google/link"}) {
            // a signed-in browser (cookie attached by itself) posting without a CSRF token: handled as anonymous
            mvc.perform(post("/api/v1/auth/" + path).cookie(sessionCookie(7L, LEARNER_SESSION)))
                    .andExpect(status().isOk()).andExpect(content().string("ok:anonymous"));
        }
        mvc.perform(post("/api/v1/auth/change-password").cookie(sessionCookie(7L, LEARNER_SESSION)))
                .andExpect(status().isForbidden());
        mvc.perform(ownPage(post("/api/v1/auth/change-password"), 7L, LEARNER_SESSION))
                .andExpect(status().isOk()).andExpect(content().string("ok:[ROLE_USER]"));
        mvc.perform(get("/api/v1/auth/me").cookie(sessionCookie(7L, LEARNER_SESSION)))
                .andExpect(content().string("ok:[ROLE_USER]"));
    }

    // ---------------------------------------------------------------- administrator second factor

    @Test
    @DisplayName("Administrator authority exists only for a session the second-factor policy admits")
    void administratorAuthorityDependsOnSecondFactor() throws Exception {
        // including the administrator routes that live under a learner module's prefix
        String[] adminPaths = {"/api/v1/admin/premium/users", "/api/v1/admin/garden/commerce", "/api/v1/feedback/admin/inbox",
                "/api/v1/admin/exams/operations/summary", "/api/v1/admin/community/reports",
                "/api/v1/listening/admin/import", "/api/v1/listening/system/import", "/api/v1/reading/admin/corpus",
                "/api/v1/reading/admin/bilingual"};

        ADMIN_ACCESS.set(AuthSessionContext.AdminAccess.GRANTED);
        for (String path : adminPaths) {
            mvc.perform(get(path).cookie(sessionCookie(1L, ADMIN_SESSION)))
                    .andExpect(status().isOk()).andExpect(content().string("ok:[ROLE_ADMIN]"));
        }
        for (var withheld : new AuthSessionContext.AdminAccess[]{AuthSessionContext.AdminAccess.MFA_REQUIRED,
                AuthSessionContext.AdminAccess.ENROLLMENT_REQUIRED}) {
            ADMIN_ACCESS.set(withheld);
            for (String path : adminPaths) {
                mvc.perform(get(path).cookie(sessionCookie(1L, ADMIN_SESSION))).andExpect(status().isForbidden());
                mvc.perform(get(path).header(HttpHeaders.AUTHORIZATION, "Bearer " + token(1L, ADMIN_SESSION, APP_SECRET, 60_000)))
                        .andExpect(status().isForbidden());
            }
            // the account itself still works, as an ordinary learner, and can reach the second-factor endpoints
            mvc.perform(get("/api/v1/mfa/status").cookie(sessionCookie(1L, ADMIN_SESSION)))
                    .andExpect(status().isOk()).andExpect(content().string("ok:[ROLE_USER]"));
        }
        // a learner is never an administrator, whatever the policy says about the administrator
        ADMIN_ACCESS.set(AuthSessionContext.AdminAccess.GRANTED);
        for (String path : adminPaths) {
            mvc.perform(get(path).cookie(sessionCookie(7L, LEARNER_SESSION))).andExpect(status().isForbidden());
            // the role is decided before the body is read: a learner's write with no usable body is 403, not 400
            mvc.perform(ownPage(post(path), 7L, LEARNER_SESSION)).andExpect(status().isForbidden());
            mvc.perform(get(path)).andExpect(status().isUnauthorized());
        }
        // the learner's own routes of those modules are untouched
        mvc.perform(get("/api/v1/listening/materials").cookie(sessionCookie(7L, LEARNER_SESSION))).andExpect(status().isOk());
        mvc.perform(get("/api/v1/reading/materials").cookie(sessionCookie(7L, LEARNER_SESSION))).andExpect(status().isOk());
        mvc.perform(get("/api/v1/mfa/status")).andExpect(status().isUnauthorized());
    }
}
