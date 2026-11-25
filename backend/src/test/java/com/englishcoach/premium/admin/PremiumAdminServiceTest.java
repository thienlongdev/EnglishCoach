package com.englishcoach.premium.admin;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.premium.config.PremiumProperties;
import com.englishcoach.premium.entity.PremiumPlan;
import com.englishcoach.premium.entity.PremiumSubscription;
import com.englishcoach.premium.repository.PremiumPlanRepository;
import com.englishcoach.premium.repository.PremiumSubscriptionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.lang.reflect.Field;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Manual Premium entitlement: official admin only (403 otherwise, nothing written), grant = ADMIN_GRANT subscription
 * (never a payment), revoke cancels only ADMIN_GRANT rows (a paid subscription survives), every action is audited.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class PremiumAdminServiceTest {

    static final long ADMIN = 1L;
    static final long LEARNER = 676L;
    static final Instant NOW = Instant.parse("2026-10-02T09:00:00Z");

    @Mock AdminIdentityService adminIdentity;
    @Mock UserRepository userRepository;
    @Mock PremiumSubscriptionRepository subscriptionRepository;
    @Mock PremiumPlanRepository planRepository;
    @Mock PremiumProperties premiumProperties;
    @Mock NamedParameterJdbcTemplate jdbc;
    @InjectMocks PremiumAdminService service;

    User learner;
    PremiumPlan adminPlan;
    List<PremiumSubscription> active;

    @BeforeEach
    void setUp() {
        doNothing().when(adminIdentity).requireOfficialAdmin(ADMIN);
        doThrow(new ResponseStatusException(HttpStatus.FORBIDDEN)).when(adminIdentity).requireOfficialAdmin(LEARNER);
        learner = User.builder().id(LEARNER).email("learner@gmail.com").name("Learner").role(Role.ROLE_USER).build();
        adminPlan = PremiumPlan.builder().id(9L).code("ADMIN_GRANT").name("Premium do quản trị viên cấp").durationMonths(1).priceVnd(0L).active(false).build();
        when(userRepository.findById(LEARNER)).thenReturn(Optional.of(learner));
        when(planRepository.findByCode("ADMIN_GRANT")).thenReturn(Optional.of(adminPlan));
        when(premiumProperties.getZoneId()).thenReturn(ZoneId.of("Asia/Ho_Chi_Minh"));
        active = new ArrayList<>();
        when(subscriptionRepository.findActiveSubscriptions(eq(LEARNER), any())).thenAnswer(i -> List.copyOf(active));
        when(subscriptionRepository.findFirstActiveSubscription(eq(LEARNER), any()))
                .thenAnswer(i -> active.isEmpty() ? Optional.empty() : Optional.of(active.get(0)));
        when(subscriptionRepository.saveAndFlush(any(PremiumSubscription.class))).thenAnswer(i -> {
            PremiumSubscription s = i.getArgument(0);
            s.setId(100L + active.size());
            active.add(s);
            return s;
        });
        when(jdbc.query(anyString(), any(MapSqlParameterSource.class), any(org.springframework.jdbc.core.RowMapper.class))).thenReturn(List.of());
    }

    @Test
    @DisplayName("Non-admin caller: 403 on grant / revoke / search, nothing saved or audited")
    void nonAdminForbidden() {
        PremiumAdminDtos.GrantRequest req = new PremiumAdminDtos.GrantRequest(1, false, "promo");
        assertThatThrownBy(() -> service.grant(LEARNER, LEARNER, req, NOW)).isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
        assertThatThrownBy(() -> service.revoke(LEARNER, LEARNER, new PremiumAdminDtos.RevokeRequest("x"), NOW))
                .isInstanceOf(ResponseStatusException.class);
        assertThatThrownBy(() -> service.search(LEARNER, "a", NOW)).isInstanceOf(ResponseStatusException.class);
        verify(subscriptionRepository, never()).saveAndFlush(any());
        verify(jdbc, never()).update(anyString(), any(MapSqlParameterSource.class));
    }

    @Test
    @DisplayName("Grant 3 months: ADMIN_GRANT subscription on the ADMIN_GRANT plan + one GRANT audit row")
    void grant() {
        PremiumAdminDtos.UserEntitlement r = service.grant(ADMIN, LEARNER, new PremiumAdminDtos.GrantRequest(3, false, "Học bổng"), NOW);
        ArgumentCaptor<PremiumSubscription> sub = ArgumentCaptor.forClass(PremiumSubscription.class);
        verify(subscriptionRepository).saveAndFlush(sub.capture());
        assertThat(sub.getValue().getSource()).isEqualTo("ADMIN_GRANT");
        assertThat(sub.getValue().getPlan().getCode()).isEqualTo("ADMIN_GRANT");
        assertThat(sub.getValue().getStartsAt()).isEqualTo(NOW);
        assertThat(sub.getValue().getExpiresAt()).isEqualTo(Instant.parse("2027-01-02T09:00:00Z"));
        assertThat(r.premium()).isTrue();
        assertThat(r.adminGrantActive()).isTrue();
        ArgumentCaptor<MapSqlParameterSource> audit = ArgumentCaptor.forClass(MapSqlParameterSource.class);
        verify(jdbc).update(contains("premium_admin_entitlement_events"), audit.capture());
        assertThat(audit.getValue().getValue("action")).isEqualTo("GRANT");
        assertThat(audit.getValue().getValue("a")).isEqualTo(ADMIN);
        assertThat(audit.getValue().getValue("t")).isEqualTo(LEARNER);
        assertThat(audit.getValue().getValue("reason")).isEqualTo("Học bổng");
        assertThat(audit.getValue().getValue("pp")).isEqualTo(false);
        assertThat(audit.getValue().getValue("np")).isEqualTo(true);
    }

    @Test
    @DisplayName("Permanent grant ends at the fixed far-future date")
    void permanent() {
        service.grant(ADMIN, LEARNER, new PremiumAdminDtos.GrantRequest(null, true, "Đối tác"), NOW);
        assertThat(active.get(0).getExpiresAt()).isEqualTo(PremiumAdminService.PERMANENT_UNTIL);
    }

    @Test
    @DisplayName("Revoke cancels only ADMIN_GRANT subscriptions; a paid subscription stays active; REVOKE audited")
    void revokeKeepsPaid() {
        PremiumSubscription paid = PremiumSubscription.builder().id(50L).user(learner).plan(adminPlan).startsAt(NOW.minusSeconds(86400))
                .expiresAt(NOW.plusSeconds(86400 * 60)).status("ACTIVE").source("SEPAY").build();
        PremiumSubscription granted = PremiumSubscription.builder().id(51L).user(learner).plan(adminPlan).startsAt(NOW.minusSeconds(60))
                .expiresAt(NOW.plusSeconds(86400 * 30)).status("ACTIVE").source("ADMIN_GRANT").build();
        active.add(paid);
        active.add(granted);
        when(subscriptionRepository.saveAllAndFlush(anyList())).thenAnswer(i -> {
            active.removeIf(s -> !"ACTIVE".equals(s.getStatus()));
            return i.getArgument(0);
        });
        PremiumAdminDtos.UserEntitlement r = service.revoke(ADMIN, LEARNER, new PremiumAdminDtos.RevokeRequest("Hết hạn tài trợ"), NOW);
        assertThat(granted.getStatus()).isEqualTo("CANCELLED");
        assertThat(paid.getStatus()).isEqualTo("ACTIVE");
        assertThat(r.premium()).isTrue();
        assertThat(r.paidActive()).isTrue();
        assertThat(r.adminGrantActive()).isFalse();
        ArgumentCaptor<MapSqlParameterSource> audit = ArgumentCaptor.forClass(MapSqlParameterSource.class);
        verify(jdbc).update(contains("premium_admin_entitlement_events"), audit.capture());
        assertThat(audit.getValue().getValue("action")).isEqualTo("REVOKE");
        assertThat(audit.getValue().getValue("ids")).isEqualTo("{51}");
    }

    @Test
    @DisplayName("Revoke without an admin grant: 409; validation: reason required, months 1–36")
    void validation() {
        assertThatThrownBy(() -> service.revoke(ADMIN, LEARNER, new PremiumAdminDtos.RevokeRequest("x"), NOW))
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThatThrownBy(() -> service.grant(ADMIN, LEARNER, new PremiumAdminDtos.GrantRequest(1, false, "  "), NOW))
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        assertThatThrownBy(() -> service.grant(ADMIN, LEARNER, new PremiumAdminDtos.GrantRequest(0, false, "r"), NOW))
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        assertThatThrownBy(() -> service.grant(ADMIN, LEARNER, new PremiumAdminDtos.GrantRequest(37, false, "r"), NOW))
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        verify(subscriptionRepository, never()).saveAndFlush(any());
    }

    @Test
    @DisplayName("The service has no payment dependency (a grant can never create a payment order / transaction)")
    void noPaymentDependency() {
        for (Field f : PremiumAdminService.class.getDeclaredFields()) {
            assertThat(f.getType().getName()).doesNotContain(".payment.");
        }
    }
}
