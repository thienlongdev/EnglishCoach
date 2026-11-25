package com.englishcoach.auth.service;

import com.englishcoach.auth.entity.AuthActionToken;
import com.englishcoach.auth.entity.AuthSecurityState;
import com.englishcoach.auth.entity.AuthSession;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthActionTokenRepository;
import com.englishcoach.auth.repository.AuthRateLimitBucketRepository;
import com.englishcoach.auth.repository.AuthSecurityStateRepository;
import com.englishcoach.auth.repository.AuthSessionRepository;
import com.englishcoach.common.security.AppJwtService;
import com.englishcoach.common.security.AuthSecurityProperties;
import io.jsonwebtoken.Claims;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AuthSecurityServicesTest {

    @Mock
    private AuthSessionRepository sessionRepository;
    @Mock
    private AuthRateLimitBucketRepository rateLimitBucketRepository;
    @Mock
    private AuthSecurityStateRepository securityStateRepository;
    @Mock
    private AuthActionTokenRepository actionTokenRepository;
    @Mock
    private SecurityAuditService auditService;

    private AuthSecurityProperties securityProperties;
    private AppJwtService appJwtService;
    private AuthSessionService sessionService;
    private LoginThrottleService throttleService;
    private PasswordPolicyService passwordPolicyService;
    private AuthActionTokenService actionTokenService;

    private User testUser;

    @BeforeEach
    void setUp() {
        securityProperties = new AuthSecurityProperties();
        securityProperties.setJwtSecret("a-very-secure-test-secret-at-least-32-chars-long!");
        securityProperties.setJwtLifetimeMinutes(15);
        securityProperties.setSessionPendingLifetimeMinutes(5);
        securityProperties.setSessionIdleLifetimeHours(4);
        securityProperties.setSessionAbsoluteLifetimeDays(30);
        securityProperties.setMaxFailedLogins(5);
        securityProperties.setLockoutDurationMinutes(15);

        appJwtService = new AppJwtService(securityProperties);
        sessionService = new AuthSessionService(sessionRepository, appJwtService, securityProperties);
        throttleService = new LoginThrottleService(rateLimitBucketRepository, securityStateRepository, auditService, securityProperties);
        passwordPolicyService = new PasswordPolicyService();
        actionTokenService = new AuthActionTokenService(actionTokenRepository);

        testUser = User.builder()
                .id(100L)
                .email("test@example.com")
                .name("Test User")
                .role(Role.ROLE_USER)
                .accountStatus("ACTIVE")
                .credentialStatus("ACTIVE")
                .credentialVersion(0L)
                .build();
    }

    @Test
    @DisplayName("PasswordPolicyService validates secure passwords and rejects weak ones")
    void testPasswordPolicy() {
        // Valid 15+ character passphrase (no arbitrary character classes required)
        assertThatNoException().isThrownBy(() ->
                passwordPolicyService.validatePassword("correct horse battery staple", "test@example.com", "Test User"));

        // Too short (< 15 code points)
        assertThatThrownBy(() ->
                passwordPolicyService.validatePassword("Sh0rt!P@ss123", "test@example.com", "Test User"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("at least 15 characters");

        // Exceeds 72 UTF-8 bytes
        String tooLongUtf8 = "a".repeat(73);
        assertThatThrownBy(() ->
                passwordPolicyService.validatePassword(tooLongUtf8, "test@example.com", "Test User"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("not exceed 72 UTF-8 bytes");

        // Common weak passwords
        assertThatThrownBy(() ->
                passwordPolicyService.validatePassword("password1234567", "test@example.com", "Test User"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("too common");

        // Contains user email local part
        assertThatThrownBy(() ->
                passwordPolicyService.validatePassword("my-test-password-12345", "test@example.com", "Test User"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("email username");
    }

    @Test
    @DisplayName("AppJwtService generates and parses valid tokens with sid and sub claims")
    void testAppJwtGenerationAndValidation() {
        UUID sid = UUID.randomUUID();
        String token = appJwtService.generateAccessToken(testUser, sid);
        assertThat(token).isNotBlank();

        Claims claims = appJwtService.parseAndValidateToken(token);
        assertThat(claims.getSubject()).isEqualTo("100");
        assertThat(claims.get("sid", String.class)).isEqualTo(sid.toString());
        assertThat(claims.get("email", String.class)).isEqualTo("test@example.com");
    }

    @Test
    @DisplayName("LoginThrottleService locks account after 5 consecutive failures")
    void testLoginThrottleLockout() {
        AuthSecurityState state = AuthSecurityState.builder()
                .userId(testUser.getId())
                .failedLoginCount(4)
                .build();

        when(securityStateRepository.findByUserIdForUpdate(testUser.getId())).thenReturn(Optional.of(state));

        // 5th failure triggers lockout
        throttleService.recordFailedLogin(testUser.getId(), "127.0.0.1");
        assertThat(state.getLockedUntil()).isNotNull();
        assertThat(state.getLockedUntil()).isAfter(Instant.now());
        assertThat(state.getFailedLoginCount()).isEqualTo(5);
    }

    @Test
    @DisplayName("A first failed sign-in creates the counter row instead of saving a detached entity")
    void testFirstFailedLoginEnsuresRow() {
        AuthSecurityState created = AuthSecurityState.builder().userId(testUser.getId()).failedLoginCount(0).build();
        when(securityStateRepository.findByUserIdForUpdate(testUser.getId())).thenReturn(Optional.of(created));

        throttleService.recordFailedLogin(testUser.getId(), "127.0.0.1");

        org.mockito.InOrder order = org.mockito.Mockito.inOrder(securityStateRepository);
        order.verify(securityStateRepository).ensureRow(testUser.getId());
        order.verify(securityStateRepository).findByUserIdForUpdate(testUser.getId());
        assertThat(created.getFailedLoginCount()).isEqualTo(1);
    }

    @Test
    @DisplayName("AuthActionTokenService generates and single-use consumes action tokens")
    void testActionTokenSingleUse() {
        UUID tokenId = UUID.randomUUID();
        String rawToken = actionTokenService.createActionToken(
                testUser, "EMAIL_VERIFICATION", 60, "test@example.com", null, null, 0L
        );

        assertThat(rawToken).isNotBlank();

        AuthActionToken entity = AuthActionToken.builder()
                .id(tokenId)
                .user(testUser)
                .purpose("EMAIL_VERIFICATION")
                .tokenDigest(AuthActionTokenService.digest(rawToken))
                .expiresAt(Instant.now().plus(1, ChronoUnit.HOURS))
                .build();

        when(actionTokenRepository.findByTokenDigest(eq(AuthActionTokenService.digest(rawToken))))
                .thenReturn(Optional.of(entity));
        when(actionTokenRepository.markUsedIfUnused(eq(tokenId), any(Instant.class))).thenReturn(1);

        // Valid consumption
        AuthActionToken consumed = actionTokenService.consumeActionToken(rawToken, "EMAIL_VERIFICATION");
        assertThat(consumed.getUsedAt()).isNotNull();

        // Replay attempt fails because usedAt is set
        assertThatThrownBy(() -> actionTokenService.consumeActionToken(rawToken, "EMAIL_VERIFICATION"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("already been used");
    }

    @Test
    @DisplayName("AuthSessionService creates pending session and activates with grant")
    void testSessionCreationAndActivation() {
        when(sessionRepository.save(any(AuthSession.class))).thenAnswer(i -> {
            AuthSession s = i.getArgument(0);
            if (s.getId() == null) {
                s.setId(UUID.randomUUID());
            }
            return s;
        });

        var pending = sessionService.createPendingSession(testUser, "CREDENTIALS");
        assertThat(pending.sessionGrant()).isNotBlank();

        AuthSession dbSession = AuthSession.builder()
                .id(pending.sessionId())
                .user(testUser)
                .sessionGrantDigest(AuthSessionService.digest(pending.sessionGrant()))
                .state("PENDING")
                .pendingExpiresAt(Instant.now().plus(5, ChronoUnit.MINUTES))
                .idleExpiresAt(Instant.now().plus(4, ChronoUnit.HOURS))
                .absoluteExpiresAt(Instant.now().plus(30, ChronoUnit.DAYS))
                .build();

        when(sessionRepository.findBySessionGrantDigest(eq(AuthSessionService.digest(pending.sessionGrant()))))
                .thenReturn(Optional.of(dbSession));

        var activated = sessionService.activateSession(pending.sessionGrant());
        assertThat(activated.accessToken()).isNotBlank();
        assertThat(dbSession.getState()).isEqualTo("ACTIVE");
    }
}
