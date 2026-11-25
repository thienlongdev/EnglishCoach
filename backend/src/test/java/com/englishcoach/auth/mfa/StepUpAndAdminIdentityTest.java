package com.englishcoach.auth.mfa;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.auth.policy.OfficialAdminPolicy;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.AuthSessionContext.AdminAccess;
import com.englishcoach.common.security.UserDetailsImpl;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.method.HandlerMethod;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The two places a session's second-factor state decides an administrator action after the URL rule: freshness for
 * actions marked {@link RequireStepUp}, and the service-level "is this the official administrator, now" re-check.
 */
class StepUpAndAdminIdentityTest {

    private static final long ADMIN = 1L;

    static class Handlers {
        @RequireStepUp
        public void sensitive() {
        }

        public void ordinary() {
        }
    }

    private final InMemoryMfaStore store = new InMemoryMfaStore();
    private final AuthSecurityProperties properties = new AuthSecurityProperties();
    private AdminMfaGate gate;
    private StepUpInterceptor interceptor;

    @BeforeEach
    void setUp() {
        gate = new AdminMfaGate(store, properties);
        interceptor = new StepUpInterceptor(gate, properties);
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    private static void signedIn(Instant mfaVerifiedAt, Instant stepUpAt, AdminAccess access) {
        UserDetailsImpl details = new UserDetailsImpl(ADMIN, OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL, "x",
                List.of(new SimpleGrantedAuthority(access == AdminAccess.GRANTED ? "ROLE_ADMIN" : "ROLE_USER")));
        var authentication = new UsernamePasswordAuthenticationToken(details, null, details.getAuthorities());
        authentication.setDetails(new AuthSessionContext(UUID.randomUUID(), ADMIN, "GOOGLE", Instant.now(),
                mfaVerifiedAt, stepUpAt, access));
        SecurityContextHolder.getContext().setAuthentication(authentication);
    }

    private boolean allowed(String method) throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        boolean proceed = interceptor.preHandle(new MockHttpServletRequest("POST", "/api/v1/admin/x"), response,
                new HandlerMethod(new Handlers(), Handlers.class.getMethod(method)));
        if (!proceed) {
            assertThat(response.getStatus()).isEqualTo(403);
            assertThat(response.getContentAsString()).contains("STEP_UP_REQUIRED");
        }
        return proceed;
    }

    private void enrol() {
        store.upsertPendingTotp(ADMIN, new byte[]{1}, (short) 1);
        store.confirmTotp(ADMIN, 1, Instant.now());
        gate.evict(ADMIN);
    }

    @Test
    @DisplayName("A marked action needs a second-factor proof younger than the freshness window; other actions do not")
    void stepUpFreshness() throws Exception {
        enrol();
        signedIn(Instant.now(), Instant.now().minusSeconds(60), AdminAccess.GRANTED);
        assertThat(allowed("sensitive")).isTrue();
        signedIn(Instant.now().minusSeconds(3600), Instant.now().minusSeconds(11 * 60), AdminAccess.GRANTED);
        assertThat(allowed("sensitive")).as("proof is 11 minutes old").isFalse();
        assertThat(allowed("ordinary")).isTrue();
        signedIn(Instant.now().minusSeconds(3600), null, AdminAccess.GRANTED);
        assertThat(allowed("sensitive")).as("never stepped up").isFalse();
        properties.setAdminStepUpMinutes(30);
        signedIn(Instant.now().minusSeconds(3600), Instant.now().minusSeconds(11 * 60), AdminAccess.GRANTED);
        assertThat(allowed("sensitive")).as("the window is configuration").isTrue();
    }

    @Test
    @DisplayName("While no factor is enrolled (enrolment phase) there is nothing to step up with: the action proceeds")
    void nothingToStepUpWithBeforeEnrolment() throws Exception {
        signedIn(null, null, AdminAccess.GRANTED);
        assertThat(allowed("sensitive")).isTrue();
        enrol();
        assertThat(allowed("sensitive")).as("from the first enrolled factor on, the proof is demanded").isFalse();
    }

    @Test
    @DisplayName("The service-level administrator re-check follows the session: withheld authority is no administrator")
    void adminIdentityFollowsTheSession() {
        UserRepository users = mock(UserRepository.class);
        when(users.findById(ADMIN)).thenReturn(Optional.of(User.builder().id(ADMIN)
                .email(OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL).name("Owner").password("x").role(Role.ROLE_ADMIN).build()));
        when(users.findById(7L)).thenReturn(Optional.of(User.builder().id(7L).email("learner@example.test")
                .name("L").password("x").role(Role.ROLE_USER).build()));
        AdminIdentityService identity = new AdminIdentityService(users);

        signedIn(Instant.now(), Instant.now(), AdminAccess.GRANTED);
        assertThat(identity.isOfficialAdmin(ADMIN)).isTrue();
        for (AdminAccess withheld : new AdminAccess[]{AdminAccess.MFA_REQUIRED, AdminAccess.ENROLLMENT_REQUIRED}) {
            signedIn(null, null, withheld);
            assertThat(identity.isOfficialAdmin(ADMIN)).as(withheld.name()).isFalse();
            assertThat(identity.isOfficialAdminAccount(ADMIN)).as("the stored facts are unchanged").isTrue();
            org.junit.jupiter.api.Assertions.assertThrows(org.springframework.web.server.ResponseStatusException.class,
                    () -> identity.requireOfficialAdmin(ADMIN));
        }
        assertThat(identity.isOfficialAdmin(7L)).isFalse();
        // outside a request (a scheduler, a start-up runner) only the stored facts exist
        SecurityContextHolder.clearContext();
        assertThat(identity.isOfficialAdmin(ADMIN)).isTrue();
    }
}
