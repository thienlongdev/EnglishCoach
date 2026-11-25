package com.englishcoach.auth.controller;

import com.englishcoach.auth.dto.*;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthIdentityRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.*;
import com.englishcoach.common.security.AppJwtService;
import com.englishcoach.common.security.UserDetailsImpl;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AuthControllerFlowsTest {

    @Mock
    private UserRepository userRepository;
    @Mock
    private AuthIdentityRepository identityRepository;
    @Mock
    private AuthSessionService authSessionService;
    @Mock
    private LoginThrottleService loginThrottleService;
    @Mock
    private RegistrationService registrationService;
    @Mock
    private PasswordRecoveryService passwordRecoveryService;
    @Mock
    private GoogleIdentityService googleIdentityService;
    @Mock
    private SecurityAuditService auditService;
    @Mock
    private AppJwtService appJwtService;
    @Mock
    private TurnstileVerificationService turnstileVerificationService;

    private PasswordEncoder passwordEncoder = new BCryptPasswordEncoder();
    private AuthController authController;
    private HttpServletRequest httpRequest;

    private User testUser;

    @Test
    void wrongPasswordStaysAnAnswerWhenTheCounterCannotBeWritten() {
        when(userRepository.findByEmailNormalized(anyString())).thenReturn(Optional.of(testUser));
        when(loginThrottleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        when(loginThrottleService.isAccountLocked(any())).thenReturn(false);
        doThrow(new org.springframework.dao.DataIntegrityViolationException("race")).when(loginThrottleService).recordFailedLogin(any(), anyString());

        var response = authController.login(new com.englishcoach.auth.dto.LoginRequest(testUser.getEmail(), "not the password at all", "token"), httpRequest);

        // A 500 here made the sign-in proxy send the same Turnstile token again, and the learner read a false anti-bot error.
        org.junit.jupiter.api.Assertions.assertEquals(org.springframework.http.HttpStatus.UNAUTHORIZED, response.getStatusCode());
    }

    @BeforeEach
    void setUp() {
        httpRequest = mock(HttpServletRequest.class);
        lenient().when(httpRequest.getRemoteAddr()).thenReturn("127.0.0.1");

        authController = new AuthController(
                userRepository,
                identityRepository,
                passwordEncoder,
                authSessionService,
                loginThrottleService,
                registrationService,
                passwordRecoveryService,
                googleIdentityService,
                auditService,
                appJwtService,
                turnstileVerificationService
        );

        testUser = User.builder()
                .id(10L)
                .email("user10@example.com")
                .name("User Ten")
                .role(Role.ROLE_USER)
                .accountStatus("ACTIVE")
                .credentialStatus("ACTIVE")
                .credentialVersion(1L)
                .build();
    }

    @Test
    @DisplayName("Phase 5: Session exchange validates grant and returns accessToken")
    void testSessionExchange() {
        String grant = "test-grant-token-12345";
        UUID sid = UUID.randomUUID();
        when(authSessionService.activateSession(grant))
                .thenReturn(new AuthSessionService.SessionActivationResult(sid, testUser, "jwt.access.token"));

        ResponseEntity<?> response = authController.exchangeSession(new SessionExchangeRequest(grant));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isInstanceOf(SessionExchangeResponse.class);
        SessionExchangeResponse exchangeResponse = (SessionExchangeResponse) response.getBody();
        assertThat(exchangeResponse.accessToken()).isEqualTo("jwt.access.token");
        assertThat(exchangeResponse.user().email()).isEqualTo("user10@example.com");
    }

    @Test
    @DisplayName("Phase 5: Logout revokes session and returns 204")
    void testLogout() {
        String grant = "grant-to-revoke";
        ResponseEntity<Void> response = authController.logout(new LogoutRequest(grant), httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        verify(authSessionService).revokeSession(grant, "USER_LOGOUT");
    }

    @Test
    @DisplayName("Phase 5: /me returns canonical user summary without secrets")
    void testGetCurrentUser() {
        UserDetailsImpl principal = UserDetailsImpl.build(testUser);
        when(userRepository.findById(10L)).thenReturn(Optional.of(testUser));
        when(identityRepository.existsByUserIdAndProvider(10L, "GOOGLE")).thenReturn(true);

        ResponseEntity<?> response = authController.getCurrentUser(principal);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        UserSummaryDto dto = (UserSummaryDto) response.getBody();
        assertThat(dto.id()).isEqualTo(10L);
        assertThat(dto.authenticationMethods()).contains("GOOGLE");
    }

    @Test
    @DisplayName("Phase 6: Lockout triggers 401 when account is locked")
    void testLockedAccountRejected() {
        when(loginThrottleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        when(userRepository.findByEmailNormalized("user10@example.com")).thenReturn(Optional.of(testUser));
        when(loginThrottleService.isAccountLocked(10L)).thenReturn(true);

        ResponseEntity<?> response = authController.login(new LoginRequest("user10@example.com", "Password123!"), httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertThat(body.get("code")).isEqualTo("ACCOUNT_LOCKED");
    }

    @Test
    @DisplayName("Phase 7: Register returns generic 202 accepted")
    void testRegisterEndpoint() {
        RegisterRequest req = new RegisterRequest("New User", "new@example.com", "SecureP@ssphrase123!");
        ResponseEntity<?> response = authController.register(req, httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        verify(registrationService).register(eq(req), anyString(), any());
    }

    @Test
    @DisplayName("Phase 7: Verify email returns 204 on success")
    void testVerifyEmailEndpoint() {
        VerifyEmailRequest req = new VerifyEmailRequest("valid-token", null);
        ResponseEntity<?> response = authController.verifyEmail(req, httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        verify(registrationService).verifyEmail(eq(req), anyString());
    }

    @Test
    @DisplayName("Register: the provider's answer is delivered AFTER the transactional step and reported")
    void testRegisterReportsDelivery() {
        RegisterRequest req = new RegisterRequest("New User", "new@example.com", "SecureP@ssphrase123!");
        var mail = new AuthMailService.PreparedMail(UUID.randomUUID(), "EMAIL_VERIFICATION", "new@example.com", null);
        when(registrationService.register(eq(req), anyString(), any())).thenReturn(mail);
        when(registrationService.deliver(mail)).thenReturn(AuthMailService.DeliveryOutcome.FAILED);

        ResponseEntity<?> response = authController.register(req, httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertThat(body.get("delivery")).isEqualTo("FAILED");
        assertThat(body.get("code")).isEqualTo("MAIL_DELIVERY_FAILED");
        var order = inOrder(registrationService);
        order.verify(registrationService).register(eq(req), anyString(), any());
        order.verify(registrationService).deliver(mail);
    }

    @Test
    @DisplayName("Resend: generic 202 when nothing was prepared, 503 only when a prepared mail failed")
    void testResendResponses() {
        var req = new ResendVerificationRequest("someone@example.com");
        when(registrationService.resendVerification(eq(req), anyString())).thenReturn(Optional.empty());
        assertThat(authController.resendVerification(req, httpRequest).getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        var mail = new AuthMailService.PreparedMail(UUID.randomUUID(), "EMAIL_VERIFICATION", "someone@example.com", null);
        when(registrationService.resendVerification(eq(req), anyString())).thenReturn(Optional.of(mail));
        when(registrationService.deliver(mail)).thenReturn(AuthMailService.DeliveryOutcome.SENT);
        assertThat(authController.resendVerification(req, httpRequest).getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        when(registrationService.deliver(mail)).thenReturn(AuthMailService.DeliveryOutcome.FAILED);
        ResponseEntity<?> failed = authController.resendVerification(req, httpRequest);
        assertThat(failed.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(((Map<?, ?>) failed.getBody()).get("code")).isEqualTo("MAIL_DELIVERY_FAILED");
    }

    @Test
    @DisplayName("Verify email: an old link of a verified account answers 200 ALREADY_VERIFIED")
    void testVerifyEmailAlreadyVerified() {
        VerifyEmailRequest req = new VerifyEmailRequest("old-token", null);
        when(registrationService.verifyEmail(eq(req), anyString())).thenReturn(RegistrationService.VerifyOutcome.ALREADY_VERIFIED);
        ResponseEntity<?> response = authController.verifyEmail(req, httpRequest);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Map<?, ?>) response.getBody()).get("status")).isEqualTo("ALREADY_VERIFIED");
    }

    @Test
    @DisplayName("Phase 8: Forgot password returns 202 accepted")
    void testForgotPasswordEndpoint() {
        ForgotPasswordRequest req = new ForgotPasswordRequest("user10@example.com");
        ResponseEntity<?> response = authController.forgotPassword(req, httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        verify(passwordRecoveryService).forgotPassword(eq(req), anyString(), any());
    }

    @Test
    @DisplayName("Phase 8: Reset password returns 204 on success")
    void testResetPasswordEndpoint() {
        ResetPasswordRequest req = new ResetPasswordRequest("reset-token", "NewP@ssw0rd999!Longer");
        ResponseEntity<?> response = authController.resetPassword(req, httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        verify(passwordRecoveryService).resetPassword(eq(req), anyString());
    }

    @Test
    @DisplayName("Phase 9: Google collision triggers LINK_REQUIRED with ticket")
    void testGoogleCollisionLinkRequired() {
        GoogleExchangeRequest req = new GoogleExchangeRequest("mock.google.id.token", null, null);
        when(googleIdentityService.exchangeGoogleToken(eq(req), anyString(), any()))
                .thenReturn(new GoogleIdentityService.GoogleExchangeResult(
                        "LINK_REQUIRED", null, null, null, null, "link-ticket-xyz", "user10@example.com"
                ));

        ResponseEntity<?> response = authController.googleExchange(req, httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertThat(body.get("status")).isEqualTo("LINK_REQUIRED");
        assertThat(body.get("ticket")).isEqualTo("link-ticket-xyz");
    }

    @Test
    @DisplayName("Phase 9: Google link confirms password and returns session grant")
    void testGoogleLinkAccount() {
        GoogleLinkRequest req = new GoogleLinkRequest("link-ticket-xyz", "CurrentP@ss123!", null);
        when(googleIdentityService.linkAccountWithPassword(eq(req), anyString(), any()))
                .thenReturn(new GoogleIdentityService.GoogleExchangeResult(
                        "SUCCESS", "new-session-grant", "new-access-token", Instant.now().plusSeconds(300), testUser, null, "user10@example.com"
                ));

        ResponseEntity<?> response = authController.googleLink(req, httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertThat(body.get("status")).isEqualTo("SUCCESS");
        assertThat(body.get("sessionGrant")).isEqualTo("new-session-grant");
    }

    @Test
    @DisplayName("Turnstile: Registration fails when Turnstile verification rejects token")
    void testRegistrationFailsOnTurnstileRejection() {
        RegisterRequest req = new RegisterRequest("Test User", "turnstile_fail@example.com", "valid_password_15_chars_long", "invalid_token");
        doThrow(new IllegalArgumentException("Anti-bot verification failed."))
                .when(turnstileVerificationService).verifyToken(eq("invalid_token"), any(), eq("register"));

        ResponseEntity<?> response = authController.register(req, httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertThat(body.get("code")).isEqualTo("CAPTCHA_FAILED");
        assertThat(body.get("message")).isEqualTo("Anti-bot verification failed.");
    }

    @Test
    @DisplayName("Auth: /refresh validates token and returns fresh accessToken with extended expiration")
    void testRefreshTokenValid() {
        String token = "valid-refresh-token-12345";
        UUID sid = UUID.randomUUID();
        when(authSessionService.activateSession(token))
                .thenReturn(new AuthSessionService.SessionActivationResult(sid, testUser, "fresh.access.token"));

        ResponseEntity<?> response = authController.refreshToken(new RefreshTokenRequest(token, null), httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertThat(body.get("accessToken")).isEqualTo("fresh.access.token");
        assertThat(body.get("sessionGrant")).isEqualTo(token);
        assertThat(body.get("expiresIn")).isEqualTo(1800L);
    }

    @Test
    @DisplayName("Auth: /refresh returns 401 when token is invalid or expired")
    void testRefreshTokenInvalid() {
        String token = "expired-token";
        when(authSessionService.activateSession(token))
                .thenThrow(new IllegalStateException("Session absolute lifetime expired"));

        ResponseEntity<?> response = authController.refreshToken(new RefreshTokenRequest(token, null), httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertThat(body.get("code")).isEqualTo("INVALID_REFRESH_TOKEN");
    }

    @Test
    @DisplayName("Auth: /refresh returns 401 when no token is provided")
    void testRefreshTokenMissing() {
        ResponseEntity<?> response = authController.refreshToken(null, httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertThat(body.get("code")).isEqualTo("MISSING_REFRESH_TOKEN");
    }
}
