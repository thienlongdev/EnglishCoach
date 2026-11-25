package com.englishcoach.auth.service;

import com.englishcoach.auth.entity.AuthSession;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.AuthSessionRepository;
import com.englishcoach.auth.repository.UserRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** ASVS 5.0 V7.5.2 (a user manages their own sessions) and V7.4.5 (an administrator ends another user's sessions). */
class AccountSessionServiceTest {

    private final AuthSessionRepository sessions = mock(AuthSessionRepository.class);
    private final UserRepository users = mock(UserRepository.class);
    private final SecurityAuditService audit = mock(SecurityAuditService.class);
    private final AccountSessionService service = new AccountSessionService(sessions, users, audit);

    private final UUID current = UUID.randomUUID(), other = UUID.randomUUID();

    private AccountSessionService.Caller caller(long userId, Duration signedInAgo) {
        return new AccountSessionService.Caller(userId, current, Instant.now().minus(signedInAgo), "203.0.113.5", "JUnit");
    }

    @Test
    @DisplayName("The list shows only the caller's live sessions, marks the current one and never carries a grant digest")
    void listIsOwnerScopedAndMinimal() {
        AuthSession mine = AuthSession.builder().id(current).sessionGrantDigest("d".repeat(64)).authMethod("GOOGLE")
                .deviceLabel("Chrome · Windows").authenticatedAt(Instant.now()).build();
        when(sessions.findLiveForUser(eq(7L), any())).thenReturn(List.of(mine));
        List<Map<String, Object>> list = service.list(caller(7L, Duration.ZERO));
        assertThat(list).hasSize(1);
        assertThat(list.get(0)).containsEntry("current", true).containsEntry("device", "Chrome · Windows")
                .doesNotContainKeys("sessionGrantDigest", "ip", "userAgent");
        assertThat(list.toString()).doesNotContain("dddd");
    }

    @Test
    @DisplayName("Another account's session id answers 404 and changes nothing (the update is scoped by owner)")
    void foreignSessionIsNotFound() {
        when(sessions.revokeOwned(eq(other), eq(7L), any(), anyString())).thenReturn(0);
        assertThatThrownBy(() -> service.revokeOne(caller(7L, Duration.ZERO), other))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        verify(audit, never()).recordEvent(anyString(), anyString(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    @DisplayName("Ending OTHER sessions needs a recent sign-in; ending the current one is plain sign-out")
    void othersNeedRecentSignIn() {
        assertThatThrownBy(() -> service.revokeOthers(caller(7L, Duration.ofHours(2))))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
        assertThatThrownBy(() -> service.revokeOne(caller(7L, Duration.ofHours(2)), other))
                .isInstanceOf(ResponseStatusException.class);
        verify(sessions, never()).revokeOthers(any(), any(), any(), anyString());

        when(sessions.revokeOwned(eq(current), eq(7L), any(), eq("USER_LOGOUT"))).thenReturn(1);
        assertThat(service.revokeOne(caller(7L, Duration.ofHours(2)), current)).containsEntry("currentEnded", true);

        when(sessions.revokeOthers(eq(7L), eq(current), any(), anyString())).thenReturn(3);
        assertThat(service.revokeOthers(caller(7L, Duration.ofMinutes(5)))).containsEntry("revoked", 3);
        verify(audit).recordEvent(eq("SESSIONS_REVOKED_BY_USER"), eq("SUCCESS"), eq(7L), eq(7L), any(), any(), any(), eq("OTHERS"), any());
    }

    @Test
    @DisplayName("The administrator ends every session of another account (audited); on their own account the current session stays")
    void administratorRevokesAnotherUsersSessions() {
        when(users.findById(42L)).thenReturn(Optional.of(User.builder().id(42L).email("learner@example.test").build()));
        when(users.findById(1L)).thenReturn(Optional.of(User.builder().id(1L).email("owner@example.test").build()));
        when(sessions.revokeAllActiveSessionsForUser(eq(42L), any(), anyString())).thenReturn(2);
        assertThat(service.adminRevokeAll(caller(1L, Duration.ZERO), 42L)).containsEntry("revoked", 2);
        verify(audit).recordEvent(eq("ADMIN_SESSIONS_REVOKED"), eq("SUCCESS"), eq(1L), eq(42L), any(), any(), any(), eq("ALL"), any());

        service.adminRevokeAll(caller(1L, Duration.ZERO), 1L);
        verify(sessions).revokeOthers(eq(1L), eq(current), any(), anyString());
        verify(sessions, never()).revokeAllActiveSessionsForUser(eq(1L), any(), anyString());
    }

    @Test
    @DisplayName("Device labels keep only browser and OS family")
    void deviceLabels() {
        assertThat(DeviceLabels.of("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"))
                .isEqualTo("Chrome · Windows");
        assertThat(DeviceLabels.of("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"))
                .isEqualTo("Safari · iOS");
        assertThat(DeviceLabels.of(null)).isNull();
        assertThat(DeviceLabels.of("x".repeat(500))).hasSizeLessThanOrEqualTo(80);
    }
}
