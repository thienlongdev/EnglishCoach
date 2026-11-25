package com.englishcoach.auth.service;

import com.englishcoach.auth.dto.GoogleExchangeRequest;
import com.englishcoach.auth.entity.AuthIdentity;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthIdentityRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.security.AuthSecurityProperties;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPublicKey;
import java.util.Date;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

@ExtendWith(MockitoExtension.class)
class GoogleIdentityServiceTest {

    @Mock
    private AuthIdentityRepository identityRepository;
    @Mock
    private UserRepository userRepository;
    @Mock
    private AuthSessionService sessionService;
    @Mock
    private AuthActionTokenService actionTokenService;
    @Mock
    private PasswordEncoder passwordEncoder;
    @Mock
    private LoginThrottleService throttleService;
    @Mock
    private SecurityAuditService auditService;

    private AuthSecurityProperties securityProperties;
    private GoogleIdentityService googleIdentityService;

    private static final String SIGNING_SECRET = "01234567890123456789012345678901"; // 32 bytes
    /** Stands in for Google's signing key: the verifier under test trusts only this key pair's public half. */
    private static final KeyPair GOOGLE_KEY = rsaKeyPair();
    /** A key Google never published: what a forger has. */
    private static final KeyPair FORGER_KEY = rsaKeyPair();

    private static KeyPair rsaKeyPair() {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            return generator.generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private GoogleIdTokenVerifier verifier() {
        // signature only, as in production: every claim is the verifier's own check
        var signatureDecoder = org.springframework.security.oauth2.jwt.NimbusJwtDecoder
                .withPublicKey((RSAPublicKey) GOOGLE_KEY.getPublic())
                .build();
        signatureDecoder.setJwtValidator(jwt -> org.springframework.security.oauth2.core.OAuth2TokenValidatorResult.success());
        return new GoogleIdTokenVerifier(securityProperties, signatureDecoder);
    }
    private static final String CLIENT_ID = "expected-client-id.apps.googleusercontent.com";

    @BeforeEach
    void setUp() {
        securityProperties = new AuthSecurityProperties();
        securityProperties.setGoogleClientId(CLIENT_ID);

        googleIdentityService = new GoogleIdentityService(
                identityRepository,
                userRepository,
                sessionService,
                actionTokenService,
                passwordEncoder,
                throttleService,
                auditService,
                securityProperties,
                verifier()
        );

        when(throttleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt()))
                .thenReturn(true);
    }

    private String createToken(String issuer, String aud, String sub, String email, Boolean emailVerified, Date exp) throws Exception {
        return createToken(GOOGLE_KEY, issuer, aud, sub, email, emailVerified, exp);
    }

    private static JWTClaimsSet claims(String issuer, String aud, String sub, String email, Boolean emailVerified, Date exp) {
        JWTClaimsSet.Builder builder = new JWTClaimsSet.Builder();
        if (issuer != null) builder.issuer(issuer);
        if (aud != null) builder.audience(aud);
        if (sub != null) builder.subject(sub);
        if (email != null) builder.claim("email", email);
        if (emailVerified != null) builder.claim("email_verified", emailVerified);
        if (exp != null) builder.expirationTime(exp);
        return builder.build();
    }

    private String createToken(KeyPair signer, String issuer, String aud, String sub, String email, Boolean emailVerified, Date exp) throws Exception {
        SignedJWT signedJWT = new SignedJWT(new JWSHeader(JWSAlgorithm.RS256), claims(issuer, aud, sub, email, emailVerified, exp));
        signedJWT.sign(new RSASSASigner(signer.getPrivate()));
        return signedJWT.serialize();
    }

    private static Date inOneMinute() {
        return new Date(System.currentTimeMillis() + 60000);
    }

    @Test
    @DisplayName("Forgery: a token the caller signed with a shared secret (HS256) is refused and touches no account")
    void forgedSharedSecretTokenIsRefused() throws Exception {
        SignedJWT forged = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256),
                claims("https://accounts.google.com", CLIENT_ID, "victim-sub", "victim@example.com", true, inOneMinute()));
        forged.sign(new MACSigner(SIGNING_SECRET));
        String token = forged.serialize();

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("signature is not valid");
        verifyNoInteractions(identityRepository, userRepository, sessionService);
    }

    @Test
    @DisplayName("Forgery: a well-formed RS256 token signed by a key Google never published is refused")
    void tokenSignedByAnotherKeyIsRefused() throws Exception {
        String forged = createToken(FORGER_KEY, "https://accounts.google.com", CLIENT_ID, "victim-sub",
                "victim@example.com", true, inOneMinute());

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(forged, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("signature is not valid");
        verifyNoInteractions(identityRepository, userRepository, sessionService);
    }

    @Test
    @DisplayName("Forgery: a genuine token whose payload was changed afterwards is refused")
    void tamperedPayloadIsRefused() throws Exception {
        String[] genuine = createToken("https://accounts.google.com", CLIENT_ID, "sub-123", "user@example.com", true,
                inOneMinute()).split("\\.");
        String otherPayload = createToken(FORGER_KEY, "https://accounts.google.com", CLIENT_ID, "victim-sub",
                "victim@example.com", true, inOneMinute()).split("\\.")[1];
        String tampered = genuine[0] + "." + otherPayload + "." + genuine[2];

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(tampered, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("signature is not valid");
        verifyNoInteractions(identityRepository, userRepository, sessionService);
    }

    @Test
    @DisplayName("Fail closed: without a configured Google client id every token is refused, even a genuine one")
    void missingClientIdRefusesEverything() throws Exception {
        securityProperties.setGoogleClientId("");
        String genuine = createToken("https://accounts.google.com", CLIENT_ID, "sub-123", "user@example.com", true,
                inOneMinute());

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(genuine, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not configured");
        verifyNoInteractions(identityRepository, userRepository, sessionService);
    }

    @Test
    @DisplayName("Confused deputy: a genuine Google token issued to another application (azp) is refused")
    void tokenForAnotherAuthorizedPartyIsRefused() throws Exception {
        JWTClaimsSet other = new JWTClaimsSet.Builder(claims("https://accounts.google.com", CLIENT_ID, "sub-123",
                "user@example.com", true, inOneMinute()))
                .claim("azp", "another-app.apps.googleusercontent.com").build();
        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.RS256), other);
        jwt.sign(new RSASSASigner(GOOGLE_KEY.getPrivate()));
        String token = jwt.serialize();

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid Google token azp");
    }

    @Test
    @DisplayName("Negative Test: Reject Google token with wrong issuer")
    void testWrongIssuer() throws Exception {
        String token = createToken(
                "https://malicious-issuer.com",
                CLIENT_ID,
                "sub-123",
                "user@example.com",
                true,
                new Date(System.currentTimeMillis() + 60000)
        );

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid Google token issuer");
    }

    @Test
    @DisplayName("Negative Test: Reject expired Google token")
    void testExpiredToken() throws Exception {
        String token = createToken(
                "https://accounts.google.com",
                CLIENT_ID,
                "sub-123",
                "user@example.com",
                true,
                new Date(System.currentTimeMillis() - 300_000) // beyond the tolerated clock difference
        );

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Google token has expired");
    }

    @Test
    @DisplayName("Negative Test: Reject Google token with wrong audience")
    void testWrongAudience() throws Exception {
        String token = createToken(
                "https://accounts.google.com",
                "wrong-client-id.apps.googleusercontent.com",
                "sub-123",
                "user@example.com",
                true,
                new Date(System.currentTimeMillis() + 60000)
        );

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid Google token audience");
    }

    @Test
    @DisplayName("Negative Test: Reject Google token with missing/invalid subject")
    void testMissingSubject() throws Exception {
        String token = createToken(
                "https://accounts.google.com",
                CLIENT_ID,
                null,
                "user@example.com",
                true,
                new Date(System.currentTimeMillis() + 60000)
        );

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Missing subject in Google token");
    }

    @Test
    @DisplayName("Negative Test: Reject Google token with unverified email")
    void testUnverifiedEmail() throws Exception {
        String token = createToken(
                "https://accounts.google.com",
                CLIENT_ID,
                "sub-123",
                "user@example.com",
                false, // email NOT verified
                new Date(System.currentTimeMillis() + 60000)
        );

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unverified email in Google token");
    }

    @Test
    @DisplayName("Negative Test: Reject unsigned token")
    void testUnsignedToken() {
        JWTClaimsSet claims = new JWTClaimsSet.Builder()
                .issuer("https://accounts.google.com")
                .audience(CLIENT_ID)
                .subject("sub-123")
                .claim("email", "user@example.com")
                .claim("email_verified", true)
                .expirationTime(new Date(System.currentTimeMillis() + 60000))
                .build();

        com.nimbusds.jwt.PlainJWT plainJWT = new com.nimbusds.jwt.PlainJWT(claims);
        String token = plainJWT.serialize();

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("Positive Test: Valid Google token creates user or returns session grant")
    void testValidGoogleToken() throws Exception {
        String token = createToken(
                "https://accounts.google.com",
                CLIENT_ID,
                "sub-123",
                "user@example.com",
                true,
                new Date(System.currentTimeMillis() + 60000)
        );

        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "sub-123"))
                .thenReturn(Optional.empty());
        when(userRepository.findByEmailNormalized("user@example.com"))
                .thenReturn(Optional.empty());
        when(sessionService.createPendingSession(any(User.class), eq("GOOGLE")))
                .thenReturn(new AuthSessionService.PendingSessionResult(java.util.UUID.randomUUID(), "grant-123"));
        when(sessionService.activateSession("grant-123"))
                .thenReturn(new AuthSessionService.SessionActivationResult(java.util.UUID.randomUUID(), null, "access-token-123"));

        var result = googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");

        assertThat(result.status()).isEqualTo("SUCCESS");
        assertThat(result.sessionGrant()).isEqualTo("grant-123");
        assertThat(result.email()).isEqualTo("user@example.com");
    }

    @Test
    @DisplayName("Regression Test: Already-linked Google identity bypasses LINK_REQUIRED")
    void testAlreadyLinkedGoogleIdentityBypassesLinkRequired() throws Exception {
        String token = createToken(
                "https://accounts.google.com",
                CLIENT_ID,
                "sub-linked-123",
                "user@example.com",
                true,
                new Date(System.currentTimeMillis() + 60000)
        );

        User existingUser = User.builder()
                .id(1L)
                .email("user@example.com")
                .accountStatus("ACTIVE")
                .build();

        AuthIdentity existingIdentity = AuthIdentity.builder()
                .user(existingUser)
                .provider("GOOGLE")
                .providerSubject("sub-linked-123")
                .providerEmail("user@example.com")
                .build();

        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "sub-linked-123"))
                .thenReturn(Optional.of(existingIdentity));
        when(sessionService.createPendingSession(existingUser, "GOOGLE"))
                .thenReturn(new AuthSessionService.PendingSessionResult(java.util.UUID.randomUUID(), "grant-already-linked"));
        when(sessionService.activateSession("grant-already-linked"))
                .thenReturn(new AuthSessionService.SessionActivationResult(java.util.UUID.randomUUID(), null, "token-already-linked"));

        var result = googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");

        assertThat(result.status()).isEqualTo("SUCCESS");
        assertThat(result.sessionGrant()).isEqualTo("grant-already-linked");
        assertThat(result.user().getId()).isEqualTo(1L);
    }

    @Test
    @DisplayName("Existing account + Gmail address (Google is the authority): linked without a password screen")
    void testFirstTimeEmailMatchAutoLinksExistingUserWithoutPasswordPrompt() throws Exception {
        String token = createToken(
                "https://accounts.google.com",
                CLIENT_ID,
                "sub-new-456",
                "collision@gmail.com",
                true,
                new Date(System.currentTimeMillis() + 60000)
        );

        User existingUser = User.builder()
                .id(2L)
                .email("collision@gmail.com")
                .accountStatus("ACTIVE")
                .credentialVersion(1L)
                .build();

        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "sub-new-456"))
                .thenReturn(Optional.empty());
        when(userRepository.findByEmailNormalized("collision@gmail.com"))
                .thenReturn(Optional.of(existingUser));
        when(identityRepository.findByUserIdAndProvider(2L, "GOOGLE"))
                .thenReturn(Optional.empty());
        when(sessionService.createPendingSession(existingUser, "GOOGLE"))
                .thenReturn(new AuthSessionService.PendingSessionResult(java.util.UUID.randomUUID(), "grant-auto-linked"));
        when(sessionService.activateSession("grant-auto-linked"))
                .thenReturn(new AuthSessionService.SessionActivationResult(java.util.UUID.randomUUID(), null, "token-auto-linked"));

        var result = googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");

        assertThat(result.status()).isEqualTo("SUCCESS");
        assertThat(result.sessionGrant()).isEqualTo("grant-auto-linked");
        assertThat(result.accessToken()).isEqualTo("token-auto-linked");
        assertThat(result.user().getId()).isEqualTo(2L);
        assertThat(result.email()).isEqualTo("collision@gmail.com");

        // Verify identity was automatically persisted
        verify(identityRepository).save(any(AuthIdentity.class));
        // Verify actionTokenService was NOT called (no password prompt / ticket created)
        verifyNoInteractions(actionTokenService);
    }

    @Test
    @DisplayName("Case D2: User already linked to different Google account fails closed")
    void testUserAlreadyLinkedToDifferentGoogleSubjectFailsClosed() throws Exception {
        String token = createToken(
                "https://accounts.google.com",
                CLIENT_ID,
                "sub-new-456",
                "collision@gmail.com",
                true,
                new Date(System.currentTimeMillis() + 60000)
        );

        User existingUser = User.builder()
                .id(2L)
                .email("collision@gmail.com")
                .accountStatus("ACTIVE")
                .credentialVersion(1L)
                .build();

        AuthIdentity existingOtherGoogle = AuthIdentity.builder()
                .user(existingUser)
                .provider("GOOGLE")
                .providerSubject("different-sub-999")
                .providerEmail("collision@gmail.com")
                .build();

        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "sub-new-456"))
                .thenReturn(Optional.empty());
        when(userRepository.findByEmailNormalized("collision@gmail.com"))
                .thenReturn(Optional.of(existingUser));
        when(identityRepository.findByUserIdAndProvider(2L, "GOOGLE"))
                .thenReturn(Optional.of(existingOtherGoogle));

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Google token verification failed: Account is already linked to a different Google account.");
    }

    @Test
    @DisplayName("Case D3: Disabled user Google login fails closed")
    void testDisabledUserGoogleLoginThrowsIllegalStateException() throws Exception {
        String token = createToken(
                "https://accounts.google.com",
                CLIENT_ID,
                "sub-new-456",
                "disabled@example.com",
                true,
                new Date(System.currentTimeMillis() + 60000)
        );

        User disabledUser = User.builder()
                .id(99L)
                .email("disabled@example.com")
                .accountStatus("DISABLED")
                .build();

        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "sub-new-456"))
                .thenReturn(Optional.empty());
        when(userRepository.findByEmailNormalized("disabled@example.com"))
                .thenReturn(Optional.of(disabledUser));

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Google token verification failed: User account is disabled");
    }

    @Test
    @DisplayName("Regression Test: Successful linking persists when metadata has JSONB spaces")
    void testSuccessfulLinkPersistsWithFormattedMetadata() {
        User user = User.builder()
                .id(1L)
                .email("user@example.com")
                .password("$2a$10$hashedpassword")
                .accountStatus("ACTIVE")
                .build();

        com.englishcoach.auth.entity.AuthActionToken token = com.englishcoach.auth.entity.AuthActionToken.builder()
                .user(user)
                .purpose("GOOGLE_LINK")
                .metadata("{\"sub\": \"sub-123\", \"email\": \"user@example.com\"}")
                .build();

        when(actionTokenService.consumeActionToken("ticket-123", "GOOGLE_LINK"))
                .thenReturn(token);
        when(passwordEncoder.matches("mypassword", "$2a$10$hashedpassword"))
                .thenReturn(true);
        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "sub-123"))
                .thenReturn(Optional.empty());
        when(identityRepository.findByUserIdAndProvider(1L, "GOOGLE"))
                .thenReturn(Optional.empty());
        when(sessionService.createPendingSession(user, "GOOGLE"))
                .thenReturn(new AuthSessionService.PendingSessionResult(java.util.UUID.randomUUID(), "grant-linked"));
        when(sessionService.activateSession("grant-linked"))
                .thenReturn(new AuthSessionService.SessionActivationResult(java.util.UUID.randomUUID(), null, "token-linked"));

        var result = googleIdentityService.linkAccountWithPassword(
                new com.englishcoach.auth.dto.GoogleLinkRequest("ticket-123", "mypassword", null),
                "127.0.0.1",
                "test-agent"
        );

        assertThat(result.status()).isEqualTo("SUCCESS");
        assertThat(result.sessionGrant()).isEqualTo("grant-linked");
        org.mockito.Mockito.verify(identityRepository).save(any(AuthIdentity.class));
    }

    @Test
    @DisplayName("Regression Test: Subsequent Google sign-in after linking succeeds directly with NO second LINK_REQUIRED")
    void testSubsequentGoogleSignInAfterLinkSucceedsDirectly() throws Exception {
        String token = createToken(
                "https://accounts.google.com",
                CLIENT_ID,
                "sub-just-linked-789",
                "linkeduser@example.com",
                true,
                new Date(System.currentTimeMillis() + 60000)
        );

        User linkedUser = User.builder()
                .id(55L)
                .email("linkeduser@example.com")
                .accountStatus("ACTIVE")
                .build();

        AuthIdentity persistedIdentity = AuthIdentity.builder()
                .user(linkedUser)
                .provider("GOOGLE")
                .providerSubject("sub-just-linked-789")
                .providerEmail("linkeduser@example.com")
                .emailVerified(true)
                .build();

        // On subsequent login, findByProviderAndProviderSubject returns the persisted mapping
        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "sub-just-linked-789"))
                .thenReturn(Optional.of(persistedIdentity));
        when(sessionService.createPendingSession(linkedUser, "GOOGLE"))
                .thenReturn(new AuthSessionService.PendingSessionResult(java.util.UUID.randomUUID(), "grant-subsequent"));
        when(sessionService.activateSession("grant-subsequent"))
                .thenReturn(new AuthSessionService.SessionActivationResult(java.util.UUID.randomUUID(), null, "token-subsequent"));

        var result = googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");

        assertThat(result.status()).isEqualTo("SUCCESS");
        assertThat(result.sessionGrant()).isEqualTo("grant-subsequent");
        assertThat(result.user().getId()).isEqualTo(55L);
        // Verify actionTokenService was NOT called (no LINK_REQUIRED ticket created)
        org.mockito.Mockito.verifyNoInteractions(actionTokenService);
    }

    // ---- account selection: an e-mail match alone never opens an existing account ----

    private String signed(JWTClaimsSet claims) throws Exception {
        SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.RS256), claims);
        jwt.sign(new RSASSASigner(GOOGLE_KEY.getPrivate()));
        return jwt.serialize();
    }

    private User passwordAccount(long id, String email, String accountStatus, boolean verified) {
        return User.builder().id(id).email(email).password("$2a$10$hash").credentialStatus("ACTIVE")
                .accountStatus(accountStatus).credentialVersion(3L)
                .emailVerifiedAt(verified ? java.time.LocalDateTime.now().minusDays(30) : null).build();
    }

    private void stubSession(User user, String grant) {
        when(sessionService.createPendingSession(user, "GOOGLE"))
                .thenReturn(new AuthSessionService.PendingSessionResult(java.util.UUID.randomUUID(), grant));
        when(sessionService.activateSession(grant))
                .thenReturn(new AuthSessionService.SessionActivationResult(java.util.UUID.randomUUID(), null, "token-" + grant));
    }

    @Test
    @DisplayName("Linking: an address Google is not the authority for is linked only through the password step")
    void nonAuthoritativeEmailNeedsExplicitLink() throws Exception {
        String token = createToken("https://accounts.google.com", CLIENT_ID, "1099", "learner@outlook.example", true, inOneMinute());
        User existing = passwordAccount(9L, "learner@outlook.example", "ACTIVE", true);
        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "1099")).thenReturn(Optional.empty());
        when(userRepository.findByEmailNormalized("learner@outlook.example")).thenReturn(Optional.of(existing));
        when(identityRepository.findByUserIdAndProvider(9L, "GOOGLE")).thenReturn(Optional.empty());
        when(actionTokenService.createActionToken(eq(existing), eq("GOOGLE_LINK"), eq(10L), eq("learner@outlook.example"),
                any(), eq("{\"sub\":\"1099\"}"), any())).thenReturn("ticket-raw");

        var result = googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");

        assertThat(result.status()).isEqualTo("LINK_REQUIRED");
        assertThat(result.linkTicket()).isEqualTo("ticket-raw");
        assertThat(result.sessionGrant()).isNull();
        assertThat(result.accessToken()).isNull();
        verify(identityRepository, org.mockito.Mockito.never()).save(any(AuthIdentity.class));
        verifyNoInteractions(sessionService);
    }

    @Test
    @DisplayName("Linking: a non-authoritative address whose account has no usable password is refused, not opened")
    void nonAuthoritativeEmailWithoutPasswordIsRefused() throws Exception {
        String token = createToken("https://accounts.google.com", CLIENT_ID, "1100", "nopass@outlook.example", true, inOneMinute());
        User existing = User.builder().id(10L).email("nopass@outlook.example").credentialStatus("NONE").accountStatus("ACTIVE").build();
        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "1100")).thenReturn(Optional.empty());
        when(userRepository.findByEmailNormalized("nopass@outlook.example")).thenReturn(Optional.of(existing));
        when(identityRepository.findByUserIdAndProvider(10L, "GOOGLE")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class);
        verify(identityRepository, org.mockito.Mockito.never()).save(any(AuthIdentity.class));
        verifyNoInteractions(sessionService, actionTokenService);
    }

    @Test
    @DisplayName("Linking: a Workspace address (hosted-domain claim) is authoritative and links directly")
    void workspaceDomainLinksDirectly() throws Exception {
        String token = signed(new JWTClaimsSet.Builder(claims("https://accounts.google.com", CLIENT_ID, "1101",
                "student@university.example", true, inOneMinute())).claim("hd", "university.example").build());
        User existing = passwordAccount(11L, "student@university.example", "ACTIVE", true);
        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "1101")).thenReturn(Optional.empty());
        when(userRepository.findByEmailNormalized("student@university.example")).thenReturn(Optional.of(existing));
        when(identityRepository.findByUserIdAndProvider(11L, "GOOGLE")).thenReturn(Optional.empty());
        stubSession(existing, "grant-hd");

        var result = googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");

        assertThat(result.status()).isEqualTo("SUCCESS");
        assertThat(existing.getCredentialStatus()).isEqualTo("ACTIVE");
        verifyNoInteractions(actionTokenService);
    }

    @Test
    @DisplayName("Linking: a hosted-domain claim for ANOTHER domain does not make Google the authority")
    void foreignHostedDomainIsNotAuthoritative() throws Exception {
        String token = signed(new JWTClaimsSet.Builder(claims("https://accounts.google.com", CLIENT_ID, "1102",
                "victim@company.example", true, inOneMinute())).claim("hd", "attacker.example").build());
        User existing = passwordAccount(12L, "victim@company.example", "ACTIVE", true);
        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "1102")).thenReturn(Optional.empty());
        when(userRepository.findByEmailNormalized("victim@company.example")).thenReturn(Optional.of(existing));
        when(identityRepository.findByUserIdAndProvider(12L, "GOOGLE")).thenReturn(Optional.empty());
        when(actionTokenService.createActionToken(any(), anyString(), org.mockito.ArgumentMatchers.anyLong(), anyString(), any(), anyString(), any()))
                .thenReturn("ticket-raw");

        var result = googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");

        assertThat(result.status()).isEqualTo("LINK_REQUIRED");
        verifyNoInteractions(sessionService);
    }

    @Test
    @DisplayName("Pre-registration hijack: activating a never-verified account by Google does not activate its password")
    void pendingAccountPasswordIsNotActivatedByGoogle() throws Exception {
        String token = createToken("https://accounts.google.com", CLIENT_ID, "1103", "owner@gmail.com", true, inOneMinute());
        User planted = passwordAccount(13L, "owner@gmail.com", "PENDING_EMAIL", false);
        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "1103")).thenReturn(Optional.empty());
        when(userRepository.findByEmailNormalized("owner@gmail.com")).thenReturn(Optional.of(planted));
        when(identityRepository.findByUserIdAndProvider(13L, "GOOGLE")).thenReturn(Optional.empty());
        stubSession(planted, "grant-owner");

        var result = googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");

        assertThat(result.status()).isEqualTo("SUCCESS");
        assertThat(planted.getAccountStatus()).isEqualTo("ACTIVE");
        assertThat(planted.getEmailVerifiedAt()).isNotNull();
        assertThat(planted.getCredentialStatus()).isEqualTo("RESET_REQUIRED");
        assertThat(planted.getPassword()).isEqualTo("$2a$10$hash"); // untouched: it simply cannot be used until reset
    }

    @Test
    @DisplayName("A verified account keeps its password exactly as it was when Google is linked")
    void verifiedAccountPasswordIsUntouched() throws Exception {
        String token = createToken("https://accounts.google.com", CLIENT_ID, "1104", "regular@gmail.com", true, inOneMinute());
        User regular = passwordAccount(14L, "regular@gmail.com", "ACTIVE", true);
        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "1104")).thenReturn(Optional.empty());
        when(userRepository.findByEmailNormalized("regular@gmail.com")).thenReturn(Optional.of(regular));
        when(identityRepository.findByUserIdAndProvider(14L, "GOOGLE")).thenReturn(Optional.empty());
        stubSession(regular, "grant-regular");

        googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");

        assertThat(regular.getCredentialStatus()).isEqualTo("ACTIVE");
        assertThat(regular.getCredentialVersion()).isEqualTo(3L);
        verify(userRepository, org.mockito.Mockito.never()).save(regular);
    }

    @Test
    @DisplayName("The administrator's account cannot be reached by a forged token naming its e-mail or by an e-mail match")
    void adminAccountIsNotReachableByForgery() throws Exception {
        String forged = createToken(FORGER_KEY, "https://accounts.google.com", CLIENT_ID, "1105", "admin@gmail.com", true, inOneMinute());

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(forged, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("signature is not valid");
        verifyNoInteractions(identityRepository, userRepository, sessionService, actionTokenService);
    }

    // ---- claims ----

    @Test
    @DisplayName("Claims: issued in the future, not valid yet, malformed subject, several audiences without azp — all refused")
    void claimRulesAreEnforced() throws Exception {
        Date future = new Date(System.currentTimeMillis() + 10 * 60_000);
        // issued now, as every real Google token says (a token without the claim is given one derived from its expiry)
        JWTClaimsSet base = new JWTClaimsSet.Builder(claims("https://accounts.google.com", CLIENT_ID, "1106", "user@gmail.com", true,
                new Date(System.currentTimeMillis() + 20 * 60_000))).issueTime(new Date()).build();
        String issuedInFuture = signed(new JWTClaimsSet.Builder(base).issueTime(future).build());
        String notYetValid = signed(new JWTClaimsSet.Builder(base).notBeforeTime(future).build());
        String badSubject = signed(new JWTClaimsSet.Builder(base).subject("../7/attempt bin").build());
        String longSubject = signed(new JWTClaimsSet.Builder(base).subject("9".repeat(256)).build());
        String twoAudiences = signed(new JWTClaimsSet.Builder(base).audience(java.util.List.of(CLIENT_ID, "other-app")).build());

        for (String[] expectation : new String[][]{{issuedInFuture, "not valid yet"}, {notYetValid, "not valid yet"},
                {badSubject, "Invalid subject"}, {longSubject, "Invalid subject"}, {twoAudiences, "azp"}}) {
            assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(expectation[0], null, null), "127.0.0.1", "test-agent"))
                    .as(expectation[1]).isInstanceOf(IllegalArgumentException.class).hasMessageContaining(expectation[1]);
        }
        verifyNoInteractions(identityRepository, userRepository, sessionService);
    }

    @Test
    @DisplayName("Forgery: a token that names one of Google's key ids, or carries its own key, is still judged by Google's key only")
    void embeddedKeyAndBorrowedKeyIdAreIgnored() throws Exception {
        com.nimbusds.jose.jwk.RSAKey forgerJwk = new com.nimbusds.jose.jwk.RSAKey.Builder((RSAPublicKey) FORGER_KEY.getPublic()).keyID("google-key-1").build();
        JWSHeader header = new JWSHeader.Builder(JWSAlgorithm.RS256).keyID("google-key-1").jwk(forgerJwk)
                .jwkURL(java.net.URI.create("https://attacker.example/keys.json")).build();
        SignedJWT forged = new SignedJWT(header, claims("https://accounts.google.com", CLIENT_ID, "1107", "victim@gmail.com", true, inOneMinute()));
        forged.sign(new RSASSASigner(FORGER_KEY.getPrivate()));
        String token = forged.serialize();

        assertThatThrownBy(() -> googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("signature is not valid");
        verifyNoInteractions(identityRepository, userRepository, sessionService);
    }

    @Test
    @DisplayName("Replay: the same genuine token used twice resolves to the same identity and never creates a second binding")
    void replayDoesNotCreateSecondBinding() throws Exception {
        String token = createToken("https://accounts.google.com", CLIENT_ID, "1108", "repeat@gmail.com", true, inOneMinute());
        User user = User.builder().id(15L).email("repeat@gmail.com").accountStatus("ACTIVE").build();
        AuthIdentity identity = AuthIdentity.builder().user(user).provider("GOOGLE").providerSubject("1108").providerEmail("repeat@gmail.com").build();
        when(identityRepository.findByProviderAndProviderSubject("GOOGLE", "1108")).thenReturn(Optional.of(identity));
        stubSession(user, "grant-repeat");

        googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");
        googleIdentityService.exchangeGoogleToken(new GoogleExchangeRequest(token, null, null), "127.0.0.1", "test-agent");

        verify(identityRepository, org.mockito.Mockito.times(2)).save(identity); // timestamp only, same row
        verify(userRepository, org.mockito.Mockito.never()).save(any(User.class));
        verify(userRepository, org.mockito.Mockito.never()).findByEmailNormalized(anyString());
    }
}
