package com.englishcoach.auth.containment;

import com.englishcoach.auth.controller.AuthController;
import com.englishcoach.auth.dto.LoginRequest;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.TestUserAuthenticationFilter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AuthenticationContainmentTest {

    @Mock
    private UserRepository userRepository;

    private PasswordEncoder passwordEncoder = new BCryptPasswordEncoder();

    private AuthController authController;
    private TestUserAuthenticationFilter testUserAuthenticationFilter;
    private CustomJwtAuthenticationConverter customJwtAuthenticationConverter;

    @Mock
    private com.englishcoach.auth.repository.AuthIdentityRepository identityRepository;
    @Mock
    private com.englishcoach.auth.service.AuthSessionService authSessionService;
    @Mock
    private com.englishcoach.auth.service.LoginThrottleService loginThrottleService;
    @Mock
    private com.englishcoach.auth.service.RegistrationService registrationService;
    @Mock
    private com.englishcoach.auth.service.PasswordRecoveryService passwordRecoveryService;
    @Mock
    private com.englishcoach.auth.service.GoogleIdentityService googleIdentityService;
    @Mock
    private com.englishcoach.auth.service.SecurityAuditService auditService;
    @Mock
    private com.englishcoach.common.security.AppJwtService appJwtService;
    @Mock
    private com.englishcoach.auth.service.TurnstileVerificationService turnstileVerificationService;

    private jakarta.servlet.http.HttpServletRequest httpRequest;

    @BeforeEach
    void setUp() {
        SecurityContextHolder.clearContext();
        httpRequest = mock(jakarta.servlet.http.HttpServletRequest.class);
        lenient().when(httpRequest.getRemoteAddr()).thenReturn("127.0.0.1");
        lenient().when(loginThrottleService.checkAndIncrementRateLimit(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        lenient().when(authSessionService.createPendingSession(any(), anyString()))
                .thenReturn(new com.englishcoach.auth.service.AuthSessionService.PendingSessionResult(java.util.UUID.randomUUID(), "mock-grant"));
        lenient().when(authSessionService.activateSession(anyString()))
                .thenReturn(new com.englishcoach.auth.service.AuthSessionService.SessionActivationResult(java.util.UUID.randomUUID(), null, "mock.jwt.token"));
        lenient().when(appJwtService.generateAccessToken(any(), any())).thenReturn("mock.jwt.token");

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

        testUserAuthenticationFilter = new TestUserAuthenticationFilter(userRepository);
        ReflectionTestUtils.setField(testUserAuthenticationFilter, "testFilterEnabled", false);

        customJwtAuthenticationConverter = new CustomJwtAuthenticationConverter(userRepository, authSessionService);
    }

    @Test
    @DisplayName("AuthController: Rejects non-BCrypt plaintext passwords without upgrading or authenticating")
    void testPlaintextPasswordRejected() {
        User user = new User();
        user.setId(100L);
        user.setEmail("plain@example.com");
        user.setName("Plain User");
        user.setPassword("myPlaintextSecret123");
        user.setRole(Role.ROLE_USER);

        when(userRepository.findByEmail("plain@example.com")).thenReturn(Optional.of(user));

        ResponseEntity<?> response = authController.login(new LoginRequest("plain@example.com", "myPlaintextSecret123"), httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        verify(userRepository, never()).save(any());
    }

    @Test
    @DisplayName("AuthController: Rejects DEV_TEST placeholder passwords even if stored in database")
    void testDevTestPlaceholderRejected() {
        User user = new User();
        user.setId(101L);
        user.setEmail("testuser@example.com");
        user.setName("Test User");
        user.setPassword("DEV_TEST");
        user.setRole(Role.ROLE_USER);

        when(userRepository.findByEmail("testuser@example.com")).thenReturn(Optional.of(user));

        ResponseEntity<?> response = authController.login(new LoginRequest("testuser@example.com", "DEV_TEST"), httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        verify(userRepository, never()).save(any());
    }

    @Test
    @DisplayName("AuthController: Rejects BCrypt hash of DEV_TEST placeholder")
    void testDevTestHashedPlaceholderRejected() {
        User user = new User();
        user.setId(102L);
        user.setEmail("testuser2@example.com");
        user.setName("Test User 2");
        user.setPassword(passwordEncoder.encode("DEV_TEST"));
        user.setRole(Role.ROLE_USER);

        when(userRepository.findByEmail("testuser2@example.com")).thenReturn(Optional.of(user));

        ResponseEntity<?> response = authController.login(new LoginRequest("testuser2@example.com", "DEV_TEST"), httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        verify(userRepository, never()).save(any());
    }

    @Test
    @DisplayName("AuthController: Rejects OAUTH2 placeholder credentials")
    void testOAuth2PlaceholderRejected() {
        User user = new User();
        user.setId(103L);
        user.setEmail("oauth@example.com");
        user.setName("OAuth User");
        user.setPassword("OAUTH2");
        user.setRole(Role.ROLE_USER);

        when(userRepository.findByEmail("oauth@example.com")).thenReturn(Optional.of(user));

        ResponseEntity<?> response = authController.login(new LoginRequest("oauth@example.com", "OAUTH2"), httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    @DisplayName("AuthController: Allows login with genuine BCrypt password and binds canonical userId to JWT")
    void testValidBcryptLoginSucceeds() {
        String rawPassword = "CorrectHorseBatteryStaple!123";
        User user = new User();
        user.setId(1L);
        user.setEmail("learner@englishcoach.app");
        user.setName("Learner");
        user.setPassword(passwordEncoder.encode(rawPassword));
        user.setRole(Role.ROLE_USER);

        when(userRepository.findByEmail("learner@englishcoach.app")).thenReturn(Optional.of(user));

        ResponseEntity<?> response = authController.login(new LoginRequest("learner@englishcoach.app", rawPassword), httpRequest);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
    }

    @Test
    @DisplayName("TestUserAuthenticationFilter: Ignores X-Test-User when testFilterEnabled is false")
    void testUserFilterDisabledByDefault() throws Exception {
        HttpServletRequest request = mock(HttpServletRequest.class);
        HttpServletResponse response = mock(HttpServletResponse.class);
        FilterChain chain = mock(FilterChain.class);

        when(request.getHeader("X-Test-User")).thenReturn("admin@englishcoach.app");
        when(request.getRequestURI()).thenReturn("/api/v1/writing/sessions");

        testUserAuthenticationFilter.doFilter(request, response, chain);

        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
        verify(userRepository, never()).findByEmail(anyString());
        verify(userRepository, never()).save(any());
        verify(chain).doFilter(request, response);
    }

    @Test
    @DisplayName("CustomJwtAuthenticationConverter: Throws InvalidBearerTokenException for unknown user without auto-creating records")
    void testJwtConverterNeverAutoCreatesUser() {
        Jwt jwt = Jwt.withTokenValue("mock-jwt-token")
                .header("alg", "HS256")
                .subject("unknown@example.com")
                .claim("email", "unknown@example.com")
                .issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(3600))
                .build();

        when(userRepository.findByEmail("unknown@example.com")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> customJwtAuthenticationConverter.convert(jwt))
                .isInstanceOf(InvalidBearerTokenException.class)
                .hasMessageContaining("User account does not exist");

        verify(userRepository, never()).save(any());
    }
}
