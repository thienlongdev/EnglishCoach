package com.englishcoach.auth.service;

import com.englishcoach.auth.entity.AuthSession;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthSessionRepository;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.security.AppJwtService;
import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.UserDetailsImpl;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * The request path of an authenticated call (Phase 5): the session and its account are read in one statement, and the
 * decision is the one the step-by-step path makes. Every refusal the original path gives is still given; the only
 * difference is that the idle window is written at most once a minute.
 */
class SessionRequestPathTest {

    static final long USER = 77L;

    AuthSessionRepository sessions;
    UserRepository users;
    AuthSessionService service;
    CustomJwtAuthenticationConverter converter;
    UUID sid;
    User user;

    @BeforeEach
    void setUp() {
        sessions = mock(AuthSessionRepository.class);
        users = mock(UserRepository.class);
        AuthSecurityProperties properties = new AuthSecurityProperties();
        properties.setSessionIdleLifetimeHours(4);
        service = new AuthSessionService(sessions, mock(AppJwtService.class), properties);
        converter = new CustomJwtAuthenticationConverter(users, service);
        sid = UUID.randomUUID();
        user = new User();
        user.setId(USER);
        user.setEmail("learner@example.test");
        user.setPassword("x");
        user.setRole(Role.ROLE_USER);
        user.setAccountStatus("ACTIVE");
    }

    AuthSession session(String state, Duration sinceSeen, Duration idleLeft, Duration absoluteLeft) {
        Instant now = Instant.now();
        AuthSession s = new AuthSession();
        s.setId(sid);
        s.setUser(user);
        s.setState(state);
        s.setLastSeenAt(sinceSeen == null ? null : now.minus(sinceSeen));
        s.setIdleExpiresAt(now.plus(idleLeft));
        s.setAbsoluteExpiresAt(now.plus(absoluteLeft));
        return s;
    }

    Jwt token(Object userId, String sessionId) {
        Jwt.Builder b = Jwt.withTokenValue("t").header("alg", "none").subject(String.valueOf(USER)).claim("email", "learner@example.test");
        if (userId != null) b.claim("userId", userId);
        if (sessionId != null) b.claim("sid", sessionId);
        return b.build();
    }

    @Test
    void anOrdinaryRequestReadsOnceAndWritesNothing() {
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("ACTIVE", Duration.ofSeconds(5), Duration.ofHours(3), Duration.ofDays(9))));
        var auth = converter.convert(token(USER, sid.toString()));
        assertEquals(USER, ((UserDetailsImpl) auth.getPrincipal()).getId());
        assertEquals("ROLE_USER", auth.getAuthorities().iterator().next().getAuthority());
        verify(sessions).findWithUserById(sid);
        verify(sessions, never()).touchActive(any(), any(), any(), any());
        verify(sessions, never()).save(any());
        verifyNoInteractions(users);
    }

    @Test
    void theAccountClaimMayBeAString() {
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("ACTIVE", Duration.ofSeconds(5), Duration.ofHours(3), Duration.ofDays(9))));
        assertEquals(USER, ((UserDetailsImpl) converter.convert(token(String.valueOf(USER), sid.toString())).getPrincipal()).getId());
        verifyNoInteractions(users);
    }

    @Test
    void theIdleWindowSlidesOnceTheStoredTimeIsOlderThanTheInterval() {
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("ACTIVE", AuthSessionService.TOUCH_INTERVAL.plusSeconds(30), Duration.ofHours(3), Duration.ofDays(9))));
        when(sessions.touchActive(eq(sid), any(), any(), any())).thenReturn(1);
        Instant before = Instant.now();
        converter.convert(token(USER, sid.toString()));
        ArgumentCaptor<Instant> seen = ArgumentCaptor.forClass(Instant.class);
        ArgumentCaptor<Instant> idle = ArgumentCaptor.forClass(Instant.class);
        verify(sessions).touchActive(eq(sid), seen.capture(), idle.capture(), any());
        assertTrue(!seen.getValue().isBefore(before));
        assertEquals(Duration.ofHours(4), Duration.between(seen.getValue(), idle.getValue()), "the configured idle lifetime, as before");
    }

    @Test
    void missingDeviceLabelTouchesImmediatelyWhenCurrentRequestHasUserAgent() {
        AuthSession fresh = session("ACTIVE", Duration.ofSeconds(5), Duration.ofHours(3), Duration.ofDays(9));
        fresh.setDeviceLabel(null);
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(fresh));
        when(sessions.touchActive(eq(sid), any(), any(), eq("Chrome · Windows"))).thenReturn(1);

        org.springframework.mock.web.MockHttpServletRequest req = new org.springframework.mock.web.MockHttpServletRequest();
        req.addHeader("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0");
        org.springframework.web.context.request.RequestContextHolder.setRequestAttributes(
                new org.springframework.web.context.request.ServletRequestAttributes(req));
        try {
            converter.convert(token(USER, sid.toString()));
            verify(sessions).touchActive(eq(sid), any(), any(), eq("Chrome · Windows"));
        } finally {
            org.springframework.web.context.request.RequestContextHolder.resetRequestAttributes();
        }
    }

    @Test
    void aSessionNeverSeenIsTouchedAtOnce() {
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("ACTIVE", null, Duration.ofHours(3), Duration.ofDays(9))));
        when(sessions.touchActive(eq(sid), any(), any(), any())).thenReturn(1);
        converter.convert(token(USER, sid.toString()));
        verify(sessions).touchActive(eq(sid), any(), any(), any());
    }

    @Test
    void aSessionRevokedBetweenTheReadAndTheTouchIsRefused() {
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("ACTIVE", Duration.ofMinutes(10), Duration.ofHours(3), Duration.ofDays(9))));
        when(sessions.touchActive(eq(sid), any(), any(), any())).thenReturn(0);
        assertThrows(InvalidBearerTokenException.class, () -> converter.convert(token(USER, sid.toString())));
    }

    @Test
    void aRevokedSessionIsRefusedOnTheVeryNextRequest() {
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("REVOKED", Duration.ofSeconds(1), Duration.ofHours(3), Duration.ofDays(9))));
        assertThrows(InvalidBearerTokenException.class, () -> converter.convert(token(USER, sid.toString())));
        verify(sessions, never()).touchActive(any(), any(), any(), any());
        verify(sessions, never()).expireActive(any(), any(), any());
    }

    @Test
    void aPendingSessionIsRefused() {
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("PENDING", null, Duration.ofHours(3), Duration.ofDays(9))));
        assertThrows(InvalidBearerTokenException.class, () -> converter.convert(token(USER, sid.toString())));
    }

    @Test
    void anIdleExpiredSessionIsRevokedAndRefused() {
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("ACTIVE", Duration.ofHours(5), Duration.ofMinutes(-1), Duration.ofDays(9))));
        assertThrows(InvalidBearerTokenException.class, () -> converter.convert(token(USER, sid.toString())));
        verify(sessions).expireActive(eq(sid), any(), eq("IDLE_TIMEOUT_EXPIRED"));
        verify(sessions, never()).touchActive(any(), any(), any(), any());
    }

    @Test
    void anAbsolutelyExpiredSessionIsRevokedAndRefused() {
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("ACTIVE", Duration.ofSeconds(5), Duration.ofHours(3), Duration.ofMinutes(-1))));
        assertThrows(InvalidBearerTokenException.class, () -> converter.convert(token(USER, sid.toString())));
        verify(sessions).expireActive(eq(sid), any(), eq("ABSOLUTE_LIFETIME_EXPIRED"));
    }

    @Test
    void aDisabledAccountIsRefusedBeforeItsSessionIsLookedAt() {
        user.setAccountStatus("DISABLED");
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("ACTIVE", Duration.ofMinutes(10), Duration.ofHours(3), Duration.ofDays(9))));
        var ex = assertThrows(InvalidBearerTokenException.class, () -> converter.convert(token(USER, sid.toString())));
        assertTrue(ex.getMessage().contains("disabled"));
        verify(sessions, never()).touchActive(any(), any(), any(), any());
    }

    @Test
    void aSessionOfAnotherAccountIsDecidedByTheOriginalPathAndRefused() {
        // the token claims account 78 but names a session of account 77
        when(sessions.findWithUserById(sid)).thenReturn(Optional.of(session("ACTIVE", Duration.ofSeconds(5), Duration.ofHours(3), Duration.ofDays(9))));
        User other = new User();
        other.setId(78L);
        other.setEmail("other@example.test");
        other.setRole(Role.ROLE_USER);
        other.setAccountStatus("ACTIVE");
        when(users.findById(78L)).thenReturn(Optional.of(other));
        when(sessions.findById(sid)).thenReturn(Optional.of(session("ACTIVE", Duration.ofSeconds(5), Duration.ofHours(3), Duration.ofDays(9))));
        assertThrows(InvalidBearerTokenException.class, () -> converter.convert(token(78L, sid.toString())));
        verify(users).findById(78L);
        verify(sessions, never()).touchActive(any(), any(), any(), any());
        verify(sessions, never()).save(any());
    }

    @Test
    void anUnknownSessionIsDecidedByTheOriginalPathAndRefused() {
        when(sessions.findWithUserById(sid)).thenReturn(Optional.empty());
        when(users.findById(USER)).thenReturn(Optional.of(user));
        when(sessions.findById(sid)).thenReturn(Optional.empty());
        assertThrows(InvalidBearerTokenException.class, () -> converter.convert(token(USER, sid.toString())));
        verify(users).findById(USER);
    }

    @Test
    void aTokenWithoutASessionClaimTakesTheOriginalPath() {
        when(users.findById(USER)).thenReturn(Optional.of(user));
        var auth = converter.convert(token(USER, null));
        assertEquals(USER, ((UserDetailsImpl) auth.getPrincipal()).getId());
        verify(sessions, never()).findWithUserById(any());
        verify(users).findById(anyLong());
    }

    @Test
    void aMalformedSessionClaimIsRefusedByTheOriginalPath() {
        when(users.findById(USER)).thenReturn(Optional.of(user));
        assertThrows(InvalidBearerTokenException.class, () -> converter.convert(token(USER, "not-a-uuid")));
        verify(sessions, never()).findWithUserById(any());
    }
}
