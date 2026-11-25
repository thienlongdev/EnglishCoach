package com.englishcoach.common.security;

import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import jakarta.servlet.Filter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.junit.jupiter.SpringExtension;
import org.springframework.test.context.web.WebAppConfiguration;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;

import java.security.KeyPairGenerator;
import java.util.Date;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The real security filter chain in front of a stub that answers 200 to everything: what an anonymous caller, and a
 * caller holding a token this application did not sign, can and cannot reach.
 */
@ExtendWith(SpringExtension.class)
@WebAppConfiguration
@ContextConfiguration(classes = {WebSecurityConfig.class, PublicSurfaceSecurityTest.Stub.class})
@TestPropertySource(properties = "AUTH_JWT_SECRET=" + PublicSurfaceSecurityTest.APP_SECRET)
class PublicSurfaceSecurityTest {

    static final String APP_SECRET = "unit-test-application-signing-secret-0123456789";

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
            return new CustomJwtAuthenticationConverter(users, sessions);
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
        String ok() {
            return "ok";
        }
    }

    @Autowired
    private WebApplicationContext context;

    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        Filter chain = context.getBean("springSecurityFilterChain", Filter.class);
        mvc = MockMvcBuilders.webAppContextSetup(context).addFilters(chain).build();
    }

    @Test
    @DisplayName("SEC-01: anonymous speech synthesis (GET and POST) is refused before any handler runs")
    void anonymousSynthesisIsRefused() throws Exception {
        mvc.perform(get("/api/v1/speaking/tts/synthesize").param("text", "hello"))
                .andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/speaking/tts/synthesize").param("text", "hello"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("Stored audio by reference and shadowing generation need a signed-in learner")
    void anonymousAudioRefAndShadowingAreRefused() throws Exception {
        mvc.perform(get("/api/v1/speaking/tts/audio").param("ref", "7/attempt.bin"))
                .andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/speaking/shadowing/units/1/ipa"))
                .andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/speaking/shadowing/units/1/translation"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("Pronunciation analysis (an audio upload) needs a signed-in learner")
    void anonymousPronunciationUploadIsRefused() throws Exception {
        mvc.perform(post("/api/v1/speaking/analyze")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/speaking/v2/pronunciation/analyze")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/flashcards/card-blast/start-run")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/flashcards/card-blast/finish-run")).andExpect(status().isUnauthorized());
        mvc.perform(post("/api/v1/flashcards/upload-apkg")).andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("The voice list and the fixed voice previews stay public")
    void voicesAndPreviewStayPublic() throws Exception {
        mvc.perform(get("/api/v1/speaking/tts/voices")).andExpect(status().isOk());
        mvc.perform(get("/api/v1/speaking/tts/preview").param("voiceId", "us_female")).andExpect(status().isOk());
    }

    @Test
    @DisplayName("Public surfaces that must not regress: auth, plans, payment webhook, exam catalog, dictionary")
    void intendedPublicSurfaceStaysPublic() throws Exception {
        mvc.perform(post("/api/v1/auth/login")).andExpect(status().isOk());
        mvc.perform(get("/api/v1/premium/plans")).andExpect(status().isOk());
        mvc.perform(post("/api/v1/payments/webhooks/sepay")).andExpect(status().isOk());
        mvc.perform(get("/api/v1/exams/capabilities")).andExpect(status().isOk());
        mvc.perform(get("/api/v1/dictionary/lookup")).andExpect(status().isOk());
    }

    @Test
    @DisplayName("Learner modules and admin stay closed to anonymous callers")
    void learnerAndAdminSurfaceIsClosed() throws Exception {
        for (String path : new String[]{"/api/v1/flashcards/decks", "/api/v1/reading/materials", "/api/v1/listening/materials",
                "/api/v1/speaking/history", "/api/v1/writing/sessions", "/api/v1/garden/state", "/api/v1/admin/users",
                "/api/v1/users/me"}) {
            mvc.perform(get(path)).andExpect(status().isUnauthorized());
        }
    }

    @Test
    @DisplayName("Hình nền: the account's saved YouTube videos are closed to anonymous callers (every method)")
    void wallpaperLibraryIsClosed() throws Exception {
        String base = "/api/v1/wallpaper/youtube-videos";
        String entry = base + "/00000000-0000-0000-0000-000000000001";
        mvc.perform(get(base)).andExpect(status().isUnauthorized());
        mvc.perform(get(entry)).andExpect(status().isUnauthorized());
        mvc.perform(post(base)).andExpect(status().isUnauthorized());
        mvc.perform(post(base + "/import")).andExpect(status().isUnauthorized());
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(entry + "/background"))
                .andExpect(status().isUnauthorized());
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete(entry))
                .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("A Google-style RS256 token is not a bearer token here, whatever it claims")
    void foreignRs256TokenIsNotABearerToken() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.RS256), new JWTClaimsSet.Builder()
                .issuer("https://accounts.google.com").subject("1").claim("email", "victim@example.com")
                .claim("userId", 1).expirationTime(new Date(System.currentTimeMillis() + 60000)).build());
        jwt.sign(new RSASSASigner(generator.generateKeyPair().getPrivate()));

        mvc.perform(get("/api/v1/users/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + jwt.serialize()))
                .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("A token signed with another secret (the published development default) is refused")
    void tokenSignedWithAnotherSecretIsRefused() throws Exception {
        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), new JWTClaimsSet.Builder()
                .subject("1").claim("userId", 1).claim("email", "victim@example.com")
                .expirationTime(new Date(System.currentTimeMillis() + 60000)).build());
        jwt.sign(new MACSigner(AuthSecurityProperties.DEFAULT_DEV_SECRET));

        mvc.perform(get("/api/v1/users/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + jwt.serialize()))
                .andExpect(status().isUnauthorized());
    }
}
