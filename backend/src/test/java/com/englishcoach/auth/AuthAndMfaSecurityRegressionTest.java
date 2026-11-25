package com.englishcoach.auth;

import com.englishcoach.auth.controller.AccountSessionController;
import com.englishcoach.auth.controller.AuthController;
import com.englishcoach.auth.dto.ChangePasswordRequest;
import com.englishcoach.auth.dto.GoogleExchangeRequest;
import com.englishcoach.auth.dto.GoogleLinkRequest;
import com.englishcoach.auth.dto.ResendVerificationRequest;
import com.englishcoach.auth.entity.AuthActionToken;
import com.englishcoach.auth.entity.AuthRateLimitBucket;
import com.englishcoach.auth.entity.AuthSession;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.mfa.AdminMfaGate;
import com.englishcoach.auth.mfa.AdminMfaService;
import com.englishcoach.auth.mfa.MfaAttemptLimiter;
import com.englishcoach.auth.mfa.MfaSecretCipher;
import com.englishcoach.auth.mfa.MfaStore;
import com.englishcoach.auth.mfa.WebAuthnVerifier;
import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.auth.policy.OfficialAdminPolicy;
import com.englishcoach.auth.repository.AuthActionTokenRepository;
import com.englishcoach.auth.repository.AuthIdentityRepository;
import com.englishcoach.auth.repository.AuthRateLimitBucketRepository;
import com.englishcoach.auth.repository.AuthSecurityStateRepository;
import com.englishcoach.auth.repository.AuthSessionRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AccountSessionService;
import com.englishcoach.auth.service.AuthActionTokenService;
import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.auth.service.GoogleIdTokenVerifier;
import com.englishcoach.auth.service.GoogleIdentityService;
import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.auth.service.PasswordRecoveryService;
import com.englishcoach.auth.service.RegistrationService;
import com.englishcoach.auth.service.SecurityAuditService;
import com.englishcoach.auth.service.TurnstileVerificationService;
import com.englishcoach.common.security.AppJwtService;
import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.ClientIpResolver;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.TestUserAuthenticationFilter;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.common.security.WebSecurityConfig;
import com.englishcoach.extension.EchoAnywhereAiService;
import com.englishcoach.extension.EchoAnywhereConfig;
import com.englishcoach.extension.EchoAnywhereController;
import com.englishcoach.extension.EchoAnywhereSessionService;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import com.englishcoach.proficiency.ProficiencyLevelQuery;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.data.jpa.repository.Query;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.server.ResponseStatusException;

import java.lang.reflect.Method;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * Security regression tests for Auth, MFA, session isolation, throttling, CORS, and production config guards.
 * Covers EC-SEC-2026-006, EC-SEC-2026-015, EC-SEC-2026-017, EC-SEC-2026-033, EC-SEC-2026-034,
 * AUTH-06, AUTH-07, AUTH-12, and AUTH-13.
 */
class AuthAndMfaSecurityRegressionTest {

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("EC-SEC-2026-006: LoginThrottleService aligns windowStart to windowMinutes buckets instead of 1-minute truncation")
    void loginThrottleBucketAlignsToFullWindowMinutesAndDoesNotResetAfterSixtySeconds() {
        AuthRateLimitBucketRepository bucketRepo = mock(AuthRateLimitBucketRepository.class);
        AuthSecurityStateRepository stateRepo = mock(AuthSecurityStateRepository.class);
        SecurityAuditService auditService = mock(SecurityAuditService.class);
        AuthSecurityProperties props = new AuthSecurityProperties();

        Map<String, AuthRateLimitBucket> store = new HashMap<>();
        when(bucketRepo.findByKindAndBucketKeyAndWindowStart(anyString(), anyString(), any(Instant.class)))
                .thenAnswer(inv -> {
                    String k = inv.getArgument(0) + "|" + inv.getArgument(1) + "|" + inv.getArgument(2);
                    return Optional.ofNullable(store.get(k));
                });
        when(bucketRepo.save(any(AuthRateLimitBucket.class))).thenAnswer(inv -> {
            AuthRateLimitBucket b = inv.getArgument(0);
            String k = b.getKind() + "|" + b.getBucketKey() + "|" + b.getWindowStart();
            store.put(k, b);
            return b;
        });

        LoginThrottleService throttle = new LoginThrottleService(bucketRepo, stateRepo, auditService, props);
        AtomicReference<Instant> currentTime = new AtomicReference<>(Instant.parse("2026-11-22T00:01:00Z"));
        Clock mutableClock = new Clock() {
            @Override public java.time.ZoneId getZone() { return ZoneOffset.UTC; }
            @Override public Clock withZone(java.time.ZoneId zone) { return this; }
            @Override public Instant instant() { return currentTime.get(); }
        };
        ReflectionTestUtils.setField(throttle, "clock", mutableClock);

        for (int i = 0; i < 5; i++) {
            assertThat(throttle.countRequest("LOGIN_IP", "203.0.113.7", 5, 15)).isTrue();
        }
        assertThat(throttle.countRequest("LOGIN_IP", "203.0.113.7", 5, 15)).isFalse();

        // Advance 61 seconds and 10 minutes: still inside the same 15-minute bucket (00:00:00Z..00:15:00Z).
        currentTime.set(Instant.parse("2026-11-22T00:02:01Z"));
        assertThat(throttle.countRequest("LOGIN_IP", "203.0.113.7", 5, 15)).isFalse();

        currentTime.set(Instant.parse("2026-11-22T00:11:01Z"));
        assertThat(throttle.countRequest("LOGIN_IP", "203.0.113.7", 5, 15)).isFalse();

        // Advance past the 15-minute bucket boundary (00:15:00Z): counter resets in the new bucket.
        currentTime.set(Instant.parse("2026-11-22T00:15:01Z"));
        assertThat(throttle.countRequest("LOGIN_IP", "203.0.113.7", 5, 15)).isTrue();
        assertThat(store).hasSize(2);
    }

    @Test
    @DisplayName("EC-SEC-2026-015: /resend-verification enforces Turnstile before calling RegistrationService")
    void resendVerificationEnforcesTurnstileBeforeCallingRegistrationService() {
        RegistrationService registrationService = mock(RegistrationService.class);
        TurnstileVerificationService turnstileService = mock(TurnstileVerificationService.class);
        AuthController controller = buildAuthController(registrationService, mock(PasswordRecoveryService.class),
                mock(GoogleIdentityService.class), mock(LoginThrottleService.class), turnstileService, null);

        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/v1/auth/resend-verification");
        request.setRemoteAddr("203.0.113.10");

        doThrow(new IllegalArgumentException("Anti-bot verification failed."))
                .when(turnstileService).verifyToken("bad-token", "203.0.113.10", "resend-verification");

        ResponseEntity<?> response = controller.resendVerification(
                new ResendVerificationRequest("victim@example.com", "bad-token"), request);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(((Map<?, ?>) response.getBody()).get("code")).isEqualTo("CAPTCHA_FAILED");
        verifyNoInteractions(registrationService);

        // Backwards-compatible 1-arg constructor preserves null turnstileToken.
        ResendVerificationRequest legacy = new ResendVerificationRequest("victim@example.com");
        assertThat(legacy.email()).isEqualTo("victim@example.com");
        assertThat(legacy.turnstileToken()).isNull();
    }

    @Test
    @DisplayName("EC-SEC-2026-017: Google link does not roll back token consumption on wrong password and records failed login")
    void googleLinkDoesNotRollBackOnWrongPasswordAndEnforcesLockoutAndActiveStatus() throws Exception {
        Method method = GoogleIdentityService.class.getMethod(
                "linkAccountWithPassword", GoogleLinkRequest.class, String.class, String.class);
        Transactional tx = method.getAnnotation(Transactional.class);
        assertThat(tx).isNotNull();
        assertThat(tx.noRollbackFor()).contains(IllegalArgumentException.class);

        AuthIdentityRepository identityRepo = mock(AuthIdentityRepository.class);
        UserRepository userRepo = mock(UserRepository.class);
        AuthSessionService sessionService = mock(AuthSessionService.class);
        AuthActionTokenService tokenService = mock(AuthActionTokenService.class);
        PasswordEncoder encoder = new BCryptPasswordEncoder();
        LoginThrottleService throttleService = mock(LoginThrottleService.class);
        SecurityAuditService auditService = mock(SecurityAuditService.class);
        AuthSecurityProperties props = new AuthSecurityProperties();
        GoogleIdTokenVerifier verifier = mock(GoogleIdTokenVerifier.class);

        GoogleIdentityService service = new GoogleIdentityService(
                identityRepo, userRepo, sessionService, tokenService, encoder,
                throttleService, auditService, props, verifier);

        when(throttleService.checkAndIncrementRateLimit(eq("GOOGLE_LINK_IP"), anyString(), anyInt(), anyInt()))
                .thenReturn(true);

        User activeUser = User.builder()
                .id(42L)
                .email("learner@example.com")
                .password(encoder.encode("CorrectPassphrase#2026"))
                .role(Role.ROLE_USER)
                .accountStatus("ACTIVE")
                .credentialStatus("ACTIVE")
                .credentialVersion(1L)
                .build();
        AuthActionToken linkToken = AuthActionToken.builder()
                .user(activeUser)
                .purpose("GOOGLE_LINK")
                .metadata("{\"sub\":\"google-sub-42\"}")
                .generation(1L)
                .expiresAt(Instant.now().plus(10, ChronoUnit.MINUTES))
                .build();

        // 1) Wrong password spends token and records failed login.
        when(tokenService.consumeActionToken("raw-ticket", "GOOGLE_LINK")).thenReturn(linkToken);
        when(throttleService.isAccountLocked(42L)).thenReturn(false);

        assertThatThrownBy(() -> service.linkAccountWithPassword(
                new GoogleLinkRequest("raw-ticket", "wrong-password", null), "198.51.100.10", "JUnit"))
                .isInstanceOf(IllegalArgumentException.class);
        verify(tokenService).consumeActionToken("raw-ticket", "GOOGLE_LINK");
        verify(throttleService).recordFailedLogin(42L, "198.51.100.10");

        // 2) Locked account is rejected before password check.
        when(throttleService.isAccountLocked(42L)).thenReturn(true);
        assertThatThrownBy(() -> service.linkAccountWithPassword(
                new GoogleLinkRequest("raw-ticket", "CorrectPassphrase#2026", null), "198.51.100.10", "JUnit"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("locked");

        // 3) Disabled account is rejected before password check.
        User disabledUser = User.builder()
                .id(43L)
                .email("disabled@example.com")
                .password(encoder.encode("CorrectPassphrase#2026"))
                .role(Role.ROLE_USER)
                .accountStatus("DISABLED")
                .credentialStatus("ACTIVE")
                .build();
        AuthActionToken disabledToken = AuthActionToken.builder()
                .user(disabledUser)
                .purpose("GOOGLE_LINK")
                .metadata("{\"sub\":\"google-sub-43\"}")
                .expiresAt(Instant.now().plus(10, ChronoUnit.MINUTES))
                .build();
        when(tokenService.consumeActionToken("disabled-ticket", "GOOGLE_LINK")).thenReturn(disabledToken);

        assertThatThrownBy(() -> service.linkAccountWithPassword(
                new GoogleLinkRequest("disabled-ticket", "CorrectPassphrase#2026", null), "198.51.100.10", "JUnit"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("AUTH-07: Action tokens reject stale credential generation / disabled accounts, and changePassword revokes them")
    void actionTokenChecksGenerationAndDisabledStatusAndChangePasswordRevokesTokens() {
        AuthActionTokenRepository repo = mock(AuthActionTokenRepository.class);
        AuthActionTokenService tokenService = new AuthActionTokenService(repo);

        User activeRotated = User.builder()
                .id(10L)
                .email("user10@example.com")
                .role(Role.ROLE_USER)
                .accountStatus("ACTIVE")
                .credentialVersion(2L)
                .build();
        String staleRaw = "stale-reset-token";
        AuthActionToken staleToken = AuthActionToken.builder()
                .tokenDigest(AuthActionTokenService.digest(staleRaw))
                .user(activeRotated)
                .purpose("PASSWORD_RESET")
                .generation(1L)
                .expiresAt(Instant.now().plus(10, ChronoUnit.MINUTES))
                .build();
        when(repo.findByTokenDigest(AuthActionTokenService.digest(staleRaw))).thenReturn(Optional.of(staleToken));

        assertThatThrownBy(() -> tokenService.consumeActionToken(staleRaw, "PASSWORD_RESET"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("superseded");

        User disabledUser = User.builder()
                .id(11L)
                .email("disabled11@example.com")
                .accountStatus("DISABLED")
                .credentialVersion(1L)
                .build();
        String disabledRaw = "disabled-reset-token";
        AuthActionToken disabledToken = AuthActionToken.builder()
                .tokenDigest(AuthActionTokenService.digest(disabledRaw))
                .user(disabledUser)
                .purpose("PASSWORD_RESET")
                .generation(1L)
                .expiresAt(Instant.now().plus(10, ChronoUnit.MINUTES))
                .build();
        when(repo.findByTokenDigest(AuthActionTokenService.digest(disabledRaw))).thenReturn(Optional.of(disabledToken));

        assertThatThrownBy(() -> tokenService.consumeActionToken(disabledRaw, "PASSWORD_RESET"))
                .isInstanceOf(IllegalArgumentException.class);

        // Concurrent atomic race: markUsedIfUnused returning 0 rejects duplicate consumption.
        UUID raceId = UUID.randomUUID();
        String raceRaw = "race-reset-token";
        AuthActionToken raceToken = AuthActionToken.builder()
                .id(raceId)
                .tokenDigest(AuthActionTokenService.digest(raceRaw))
                .user(activeRotated)
                .purpose("PASSWORD_RESET")
                .generation(2L)
                .expiresAt(Instant.now().plus(10, ChronoUnit.MINUTES))
                .build();
        when(repo.findByTokenDigest(AuthActionTokenService.digest(raceRaw))).thenReturn(Optional.of(raceToken));
        when(repo.markUsedIfUnused(eq(raceId), any(Instant.class))).thenReturn(0);
        assertThatThrownBy(() -> tokenService.consumeActionToken(raceRaw, "PASSWORD_RESET"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("already been used");

        // changePassword revokes active PASSWORD_RESET and GOOGLE_LINK tokens.
        PasswordRecoveryService recoveryService = mock(PasswordRecoveryService.class);
        LoginThrottleService throttleService = mock(LoginThrottleService.class);
        AuthActionTokenService mockActionTokenService = mock(AuthActionTokenService.class);
        when(throttleService.checkAndIncrementRateLimit(eq("CHANGE_PASSWORD_USER"), eq("u:10"), eq(5), eq(1)))
                .thenReturn(true);

        AuthController controller = buildAuthController(
                mock(RegistrationService.class), recoveryService, mock(GoogleIdentityService.class),
                throttleService, mock(TurnstileVerificationService.class), mockActionTokenService);

        UserDetailsImpl principal = UserDetailsImpl.build(activeRotated);
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/v1/auth/change-password");
        req.setRemoteAddr("127.0.0.1");

        ResponseEntity<?> res = controller.changePassword(
                principal, new ChangePasswordRequest("OldPassphrase#2025", "NewPassphrase#2026!"), req);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        verify(mockActionTokenService).revokeActiveTokens(10L, List.of("PASSWORD_RESET", "GOOGLE_LINK"));
    }

    @Test
    @DisplayName("AUTH-06: Pre-MFA official admin is blocked (403 MFA_REQUIRED) on password change, revoking other sessions, and extension pairing")
    void preMfaOfficialAdminBlockedOnChangePasswordSessionRevocationAndExtensionPairing() {
        UUID currentSid = UUID.randomUUID();
        UUID otherSid = UUID.randomUUID();
        User officialAdmin = User.builder()
                .id(1L)
                .email(OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL)
                .name("Owner")
                .role(Role.ROLE_ADMIN)
                .accountStatus("ACTIVE")
                .credentialStatus("ACTIVE")
                .build();
        UserDetailsImpl principal = UserDetailsImpl.build(officialAdmin);

        UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(
                principal, null, principal.getAuthorities());
        auth.setDetails(new AuthSessionContext(
                currentSid, 1L, "PASSWORD", Instant.now(), null, null, AuthSessionContext.AdminAccess.MFA_REQUIRED));
        SecurityContextHolder.getContext().setAuthentication(auth);

        MockHttpServletRequest req = new MockHttpServletRequest();
        req.setRemoteAddr("127.0.0.1");

        // 1) AuthController#changePassword -> 403 MFA_REQUIRED
        PasswordRecoveryService recoveryService = mock(PasswordRecoveryService.class);
        AuthController authController = buildAuthController(
                mock(RegistrationService.class), recoveryService, mock(GoogleIdentityService.class),
                mock(LoginThrottleService.class), mock(TurnstileVerificationService.class), mock(AuthActionTokenService.class));
        ResponseEntity<?> changeRes = authController.changePassword(
                principal, new ChangePasswordRequest("OldPass#123456", "NewPass#1234567"), req);
        assertThat(changeRes.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(((Map<?, ?>) changeRes.getBody()).get("code")).isEqualTo("MFA_REQUIRED");
        verifyNoInteractions(recoveryService);

        // 2) AccountSessionController#endOthers and #endOne(otherSid) -> 403 MFA_REQUIRED; own session allowed
        AccountSessionService accountSessionService = mock(AccountSessionService.class);
        AdminIdentityService adminIdentityService = mock(AdminIdentityService.class);
        AccountSessionController sessionController = new AccountSessionController(accountSessionService, adminIdentityService);

        assertThatThrownBy(() -> sessionController.endOthers(principal, req))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
                    assertThat(rse.getReason()).isEqualTo("MFA_REQUIRED");
                });
        verify(accountSessionService, never()).revokeOthers(any());

        assertThatThrownBy(() -> sessionController.endOne(principal, otherSid.toString(), req))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
                    assertThat(rse.getReason()).isEqualTo("MFA_REQUIRED");
                });
        verify(accountSessionService, never()).revokeOne(any(), eq(otherSid));

        when(accountSessionService.revokeOne(any(), eq(currentSid))).thenReturn(Map.of("revoked", true));
        ResponseEntity<?> ownSignOut = sessionController.endOne(principal, currentSid.toString(), req);
        assertThat(ownSignOut.getStatusCode()).isEqualTo(HttpStatus.OK);
        verify(accountSessionService).revokeOne(any(), eq(currentSid));

        // 3) EchoAnywhereController#pair -> 403 MFA_REQUIRED
        EchoAnywhereSessionService extSessionService = mock(EchoAnywhereSessionService.class);
        @SuppressWarnings("unchecked")
        ObjectProvider<ProficiencyLevelQuery> levelsProvider = mock(ObjectProvider.class);
        EchoAnywhereController extController = new EchoAnywhereController(
                extSessionService,
                mock(EchoAnywhereAiService.class),
                mock(PremiumEntitlementService.class),
                mock(PremiumUsageService.class),
                mock(LoginThrottleService.class),
                levelsProvider,
                new EchoAnywhereConfig("gohhmbiobjnfnkagkklffajggkmgegod", 14, 30, 20));

        assertThatThrownBy(() -> extController.pair(
                principal, new EchoAnywhereController.PairingRequest("gohhmbiobjnfnkagkklffajggkmgegod", "challenge", "Chrome")))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
                    assertThat(rse.getReason()).isEqualTo("MFA_REQUIRED");
                });
        verifyNoInteractions(extSessionService);
    }

    @Test
    @DisplayName("EC-SEC-2026-034: Disabled and non-ACTIVE accounts are rejected across AuthSessionService, JWT converter, and pending revocation queries")
    void disabledAccountRejectedInAuthSessionServiceAndJwtConverter() throws Exception {
        AuthSessionRepository sessionRepo = mock(AuthSessionRepository.class);
        AppJwtService jwtService = mock(AppJwtService.class);
        AuthSecurityProperties props = new AuthSecurityProperties();
        AuthSessionService sessionService = new AuthSessionService(sessionRepo, jwtService, props);

        UUID sid = UUID.randomUUID();
        User disabledUser = User.builder()
                .id(77L)
                .email("disabled77@example.com")
                .role(Role.ROLE_USER)
                .accountStatus("DISABLED")
                .build();
        AuthSession activeSessionOfDisabled = AuthSession.builder()
                .id(sid)
                .user(disabledUser)
                .state("ACTIVE")
                .idleExpiresAt(Instant.now().plus(2, ChronoUnit.HOURS))
                .absoluteExpiresAt(Instant.now().plus(2, ChronoUnit.DAYS))
                .build();

        String grant = "grant-disabled-user";
        when(sessionRepo.findBySessionGrantDigest(AuthSessionService.digest(grant)))
                .thenReturn(Optional.of(activeSessionOfDisabled));
        assertThatThrownBy(() -> sessionService.activateSession(grant))
                .isInstanceOf(IllegalStateException.class);

        when(sessionRepo.findById(sid)).thenReturn(Optional.of(activeSessionOfDisabled));
        assertThat(sessionService.validateAndTouchActiveSession(sid, 77L)).isFalse();
        assertThat(sessionService.validateLoaded(new AuthSessionService.RequestSession(activeSessionOfDisabled, disabledUser)))
                .isFalse();

        // CustomJwtAuthenticationConverter rejects DISABLED and PENDING_EMAIL users.
        UserRepository userRepo = mock(UserRepository.class);
        CustomJwtAuthenticationConverter converter = new CustomJwtAuthenticationConverter(userRepo, sessionService);
        when(sessionRepo.findWithUserById(sid)).thenReturn(Optional.of(activeSessionOfDisabled));

        Jwt jwt = Jwt.withTokenValue("tok")
                .header("alg", "HS256")
                .subject("77")
                .claim("userId", 77L)
                .claim("sid", sid.toString())
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(300))
                .build();
        assertThatThrownBy(() -> converter.convert(jwt))
                .isInstanceOf(InvalidBearerTokenException.class)
                .hasMessageContaining("disabled");

        User pendingUser = User.builder().id(78L).email("pending@example.com").role(Role.ROLE_USER)
                .accountStatus("PENDING_EMAIL").build();
        when(userRepo.findById(78L)).thenReturn(Optional.of(pendingUser));
        Jwt pendingJwt = Jwt.withTokenValue("tok2")
                .header("alg", "HS256")
                .subject("78")
                .claim("userId", 78L)
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(300))
                .build();
        assertThatThrownBy(() -> converter.convert(pendingJwt))
                .isInstanceOf(InvalidBearerTokenException.class);

        // AuthSessionRepository revocation queries include PENDING sessions as well as ACTIVE.
        Query revokeAllQuery = AuthSessionRepository.class
                .getMethod("revokeAllActiveSessionsForUser", Long.class, Instant.class, String.class)
                .getAnnotation(Query.class);
        Query revokeOthersQuery = AuthSessionRepository.class
                .getMethod("revokeOthers", Long.class, UUID.class, Instant.class, String.class)
                .getAnnotation(Query.class);
        assertThat(revokeAllQuery.value()).contains("IN ('ACTIVE', 'PENDING')");
        assertThat(revokeOthersQuery.value()).contains("IN ('ACTIVE', 'PENDING')");
    }

    @Test
    @DisplayName("EC-SEC-2026-033: Prod fails closed on dev extension ID, CORS denies credentials to extensions, and TestUserAuthenticationFilter is not double-registered")
    void prodRejectsDevExtensionIdAndCorsDeniesExtensionCredentials() {
        MockEnvironment devIdEnv = new MockEnvironment();
        devIdEnv.setActiveProfiles("prod");
        devIdEnv.setProperty("app.echo-anywhere.extension-ids", AuthSecurityProperties.DEV_EXTENSION_ID);

        AuthSecurityProperties badProdProps = validProdProperties(devIdEnv);
        assertThatThrownBy(badProdProps::validateProductionSecurity)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("development extension ID");

        MockEnvironment storeIdEnv = new MockEnvironment();
        storeIdEnv.setActiveProfiles("prod");
        storeIdEnv.setProperty("app.echo-anywhere.extension-ids", "gohhmbiobjnfnkagkklffajggkmgegod");

        AuthSecurityProperties goodProdProps = validProdProperties(storeIdEnv);
        goodProdProps.validateProductionSecurity();

        // CORS split: chrome-extension:// gets allowCredentials=false, web origin gets allowCredentials=true.
        WebSecurityConfig securityConfig = new WebSecurityConfig(null, null, null, null);
        ReflectionTestUtils.setField(securityConfig, "allowedOrigins", "https://englishcoach.io.vn");
        ReflectionTestUtils.setField(securityConfig, "echoAnywhereIds", "gohhmbiobjnfnkagkklffajggkmgegod");
        CorsConfigurationSource corsSource = securityConfig.corsConfigurationSource();

        MockHttpServletRequest extReq = new MockHttpServletRequest("POST", "/api/v1/extension/ai");
        extReq.addHeader("Origin", "chrome-extension://gohhmbiobjnfnkagkklffajggkmgegod");
        CorsConfiguration extCors = corsSource.getCorsConfiguration(extReq);
        assertThat(extCors).isNotNull();
        assertThat(extCors.getAllowCredentials()).isEqualTo(Boolean.FALSE);
        assertThat(extCors.checkOrigin("chrome-extension://gohhmbiobjnfnkagkklffajggkmgegod"))
                .isEqualTo("chrome-extension://gohhmbiobjnfnkagkklffajggkmgegod");

        MockHttpServletRequest webReq = new MockHttpServletRequest("POST", "/api/v1/auth/login");
        webReq.addHeader("Origin", "https://englishcoach.io.vn");
        CorsConfiguration webCors = corsSource.getCorsConfiguration(webReq);
        assertThat(webCors).isNotNull();
        assertThat(webCors.getAllowCredentials()).isEqualTo(Boolean.TRUE);
        assertThat(webCors.checkOrigin("https://englishcoach.io.vn")).isEqualTo("https://englishcoach.io.vn");
        assertThat(webCors.checkOrigin("chrome-extension://gohhmbiobjnfnkagkklffajggkmgegod")).isNull();

        // Servlet double-registration guard on TestUserAuthenticationFilter.
        FilterRegistrationBean<TestUserAuthenticationFilter> registration =
                securityConfig.testUserAuthenticationFilterRegistration(mock(TestUserAuthenticationFilter.class));
        assertThat(registration.isEnabled()).isFalse();
    }

    @Test
    @DisplayName("AUTH-12 & AUTH-13: Strict IPv6 literal parsing, sanitized Google auth HTTP errors, and transactional MFA last-factor guard")
    void clientIpResolverSanitizedGoogleErrorsAndMfaLastFactorGuard() throws Exception {
        // 1) ClientIpResolver rejects malformed IPv6 values from internal proxy and accepts valid IPv4/IPv6.
        for (String malformed : List.of(":::", "1::2::3", ":1", "1:", "1:2:3:4:5:6:7:8:9", "gggg::1", "2001:db8::1:2:3:4:5:6:7")) {
            MockHttpServletRequest req = new MockHttpServletRequest();
            req.setRemoteAddr("127.0.0.1");
            req.addHeader("X-Real-IP", malformed);
            assertThat(ClientIpResolver.resolve(req)).as("malformed IP %s", malformed).isEqualTo("127.0.0.1");
        }
        for (String valid : List.of("203.0.113.42", "2001:db8::1", "::1", "::ffff:203.0.113.42")) {
            MockHttpServletRequest req = new MockHttpServletRequest();
            req.setRemoteAddr("127.0.0.1");
            req.addHeader("X-Real-IP", valid);
            assertThat(ClientIpResolver.resolve(req)).as("valid IP %s", valid).isEqualTo(valid);
        }

        // 2) AuthController#googleExchange and #googleLink do not leak internal account state strings.
        GoogleIdentityService googleService = mock(GoogleIdentityService.class);
        AuthController controller = buildAuthController(
                mock(RegistrationService.class), mock(PasswordRecoveryService.class),
                googleService, mock(LoginThrottleService.class), mock(TurnstileVerificationService.class), null);

        MockHttpServletRequest httpReq = new MockHttpServletRequest();
        httpReq.setRemoteAddr("127.0.0.1");

        when(googleService.exchangeGoogleToken(any(), anyString(), any()))
                .thenThrow(new IllegalArgumentException("Google token verification failed: User account is disabled"));
        ResponseEntity<?> exchangeResp = controller.googleExchange(new GoogleExchangeRequest("id-tok", null, null), httpReq);
        assertThat(exchangeResp.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(exchangeResp.getBody().toString()).doesNotContainIgnoringCase("disabled");

        when(googleService.linkAccountWithPassword(any(), anyString(), any()))
                .thenThrow(new IllegalStateException("Account is already linked to a different Google account."));
        ResponseEntity<?> linkResp = controller.googleLink(new GoogleLinkRequest("ticket", "pass", null), httpReq);
        assertThat(linkResp.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(linkResp.getBody().toString()).doesNotContainIgnoringCase("already linked");

        // 3) AdminMfaService#removeTotp & #removeWebAuthnCredential are @Transactional and refuse removing the last factor.
        assertThat(AdminMfaService.class.getMethod("removeTotp", AdminMfaService.Caller.class)
                .isAnnotationPresent(Transactional.class)).isTrue();
        assertThat(AdminMfaService.class.getMethod("removeWebAuthnCredential", AdminMfaService.Caller.class, String.class)
                .isAnnotationPresent(Transactional.class)).isTrue();

        MfaStore mfaStore = mock(MfaStore.class);
        AuthSecurityProperties mfaProps = new AuthSecurityProperties();
        mfaProps.setJwtSecret("unit-test-application-signing-secret-0123456789");
        mfaProps.setAdminMfaRequired(true);
        UserRepository users = mock(UserRepository.class);
        User admin = User.builder()
                .id(1L)
                .email(OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL)
                .role(Role.ROLE_ADMIN)
                .accountStatus("ACTIVE")
                .build();
        when(users.findById(1L)).thenReturn(Optional.of(admin));
        when(mfaStore.webAuthnCredentials(1L)).thenReturn(List.of());

        AdminMfaService mfaService = new AdminMfaService(
                mfaStore,
                new AdminMfaGate(mfaStore, mfaProps),
                mock(MfaAttemptLimiter.class),
                new MfaSecretCipher(mfaProps),
                mock(WebAuthnVerifier.class),
                users,
                mock(SecurityAuditService.class),
                mfaProps);

        Instant now = Instant.now();
        AdminMfaService.Caller caller = new AdminMfaService.Caller(
                1L, UUID.randomUUID(), now.minusSeconds(30), now.minusSeconds(20), now.minusSeconds(5), "127.0.0.1", "JUnit");

        assertThatThrownBy(() -> mfaService.removeTotp(caller))
                .isInstanceOf(AdminMfaService.MfaException.class)
                .satisfies(ex -> {
                    AdminMfaService.MfaException me = (AdminMfaService.MfaException) ex;
                    assertThat(me.status()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(me.code()).isEqualTo("LAST_FACTOR");
                });
        verify(mfaStore, never()).deleteTotp(1L);
    }

    private AuthController buildAuthController(
            RegistrationService registrationService,
            PasswordRecoveryService passwordRecoveryService,
            GoogleIdentityService googleIdentityService,
            LoginThrottleService loginThrottleService,
            TurnstileVerificationService turnstileVerificationService,
            AuthActionTokenService authActionTokenService
    ) {
        AuthController controller = new AuthController(
                mock(UserRepository.class),
                mock(AuthIdentityRepository.class),
                new BCryptPasswordEncoder(),
                mock(AuthSessionService.class),
                loginThrottleService,
                registrationService,
                passwordRecoveryService,
                googleIdentityService,
                mock(SecurityAuditService.class),
                mock(AppJwtService.class),
                turnstileVerificationService
        );
        if (authActionTokenService != null) {
            ReflectionTestUtils.setField(controller, "authActionTokenService", authActionTokenService);
        }
        return controller;
    }

    private AuthSecurityProperties validProdProperties(MockEnvironment env) {
        AuthSecurityProperties props = new AuthSecurityProperties(env);
        props.setJwtSecret("prod-jwt-signing-secret-with-more-than-32-chars-aaa");
        props.setInternalServiceKey("prod-internal-service-key-more-than-32-chars-bbb");
        props.setMfaEncryptionKey("prod-mfa-encryption-key-more-than-32-chars-ccc");
        props.setTurnstileEnabled(true);
        props.setTurnstileRequired(true);
        props.setTurnstileSecretKey("0x4AAAAAArealCloudflareSecretKeyValue999");
        props.setMailMode("simulated");
        props.setTestFilterEnabled(false);
        return props;
    }
}
