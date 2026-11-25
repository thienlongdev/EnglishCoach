package com.englishcoach.premium.service;

import com.englishcoach.auth.entity.User;
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
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class PremiumSubscriptionServiceTest {

    @Mock
    private PremiumPlanRepository planRepository;

    @Mock
    private PremiumSubscriptionRepository subscriptionRepository;

    @Mock
    private UserRepository userRepository;

    @Mock
    private PremiumProperties properties;

    @InjectMocks
    private PremiumSubscriptionService subscriptionService;

    private final ZoneId zoneId = ZoneId.of("Asia/Ho_Chi_Minh");
    private PremiumPlan plan1Month;
    private PremiumPlan plan3Months;
    private PremiumPlan plan12Months;
    private User testUser;

    @BeforeEach
    void setUp() {
        lenient().when(properties.getZoneId()).thenReturn(zoneId);

        testUser = new User();
        testUser.setId(100L);
        testUser.setEmail("test@example.com");

        plan1Month = PremiumPlan.builder()
                .id(1L)
                .code("PLAN_1_MONTH")
                .name("Gói 1 tháng")
                .durationMonths(1)
                .priceVnd(89000L)
                .displayOrder(1)
                .active(true)
                .build();

        plan3Months = PremiumPlan.builder()
                .id(2L)
                .code("PLAN_3_MONTHS")
                .name("Gói 3 tháng")
                .durationMonths(3)
                .priceVnd(239000L)
                .displayOrder(2)
                .badge("PHỔ BIẾN NHẤT")
                .active(true)
                .build();

        plan12Months = PremiumPlan.builder()
                .id(3L)
                .code("PLAN_12_MONTHS")
                .name("Gói 12 tháng")
                .durationMonths(12)
                .priceVnd(749000L)
                .displayOrder(3)
                .badge("TIẾT KIỆM NHẤT")
                .active(true)
                .build();
    }

    @Test
    @DisplayName("getActivePlans returns 3 active plans sorted by displayOrder")
    void testGetActivePlans() {
        when(planRepository.findByActiveTrueOrderByDisplayOrderAsc())
                .thenReturn(List.of(plan1Month, plan3Months, plan12Months));

        List<PremiumPlan> plans = subscriptionService.getActivePlans();

        assertThat(plans).hasSize(3);
        assertThat(plans.get(0).getCode()).isEqualTo("PLAN_1_MONTH");
        assertThat(plans.get(0).getPriceVnd()).isEqualTo(89000L);
        assertThat(plans.get(1).getCode()).isEqualTo("PLAN_3_MONTHS");
        assertThat(plans.get(1).getPriceVnd()).isEqualTo(239000L);
        assertThat(plans.get(2).getCode()).isEqualTo("PLAN_12_MONTHS");
        assertThat(plans.get(2).getPriceVnd()).isEqualTo(749000L);
    }

    @Test
    @DisplayName("extendOrActivateSubscription creates new subscription from now when no active subscription exists")
    void testGrantNewSubscriptionFromNow() {
        Long userId = 100L;
        when(userRepository.findById(userId)).thenReturn(Optional.of(testUser));
        when(planRepository.findById(2L)).thenReturn(Optional.of(plan3Months));
        when(subscriptionRepository.findFirstByUserIdAndStatusAndExpiresAtAfterOrderByExpiresAtDesc(eq(userId), eq("ACTIVE"), any(Instant.class)))
                .thenReturn(Optional.empty());
        when(subscriptionRepository.save(any(PremiumSubscription.class)))
                .thenAnswer(inv -> inv.getArgument(0));

        Instant before = Instant.now();
        PremiumSubscription sub = subscriptionService.extendOrActivateSubscription(userId, 2L, "TEST_GRANT", 3);
        Instant after = Instant.now();

        assertThat(sub.getUser()).isEqualTo(testUser);
        assertThat(sub.getPlan()).isEqualTo(plan3Months);
        assertThat(sub.getStatus()).isEqualTo("ACTIVE");
        assertThat(sub.getSource()).isEqualTo("TEST_GRANT");
        assertThat(sub.getStartsAt()).isAfterOrEqualTo(before.minusSeconds(1));
        assertThat(sub.getStartsAt()).isBeforeOrEqualTo(after.plusSeconds(1));

        // Check calendar-month extension arithmetic
        ZonedDateTime startZoned = sub.getStartsAt().atZone(zoneId);
        ZonedDateTime expectedExpiry = startZoned.plusMonths(3);
        assertThat(sub.getExpiresAt()).isEqualTo(expectedExpiry.toInstant());
    }

    @Test
    @DisplayName("extendOrActivateSubscription extends from existing expiry when an active subscription exists")
    void testExtendFromExistingExpiry() {
        Long userId = 100L;
        Instant currentStarts = Instant.now().minusSeconds(86400 * 10);
        ZonedDateTime startZoned = currentStarts.atZone(zoneId);
        Instant currentExpires = startZoned.plusMonths(1).toInstant();

        PremiumSubscription activeSub = PremiumSubscription.builder()
                .id(999L)
                .user(testUser)
                .plan(plan1Month)
                .startsAt(currentStarts)
                .expiresAt(currentExpires)
                .status("ACTIVE")
                .build();

        when(userRepository.findById(userId)).thenReturn(Optional.of(testUser));
        when(planRepository.findById(3L)).thenReturn(Optional.of(plan12Months));
        when(subscriptionRepository.findFirstByUserIdAndStatusAndExpiresAtAfterOrderByExpiresAtDesc(eq(userId), eq("ACTIVE"), any(Instant.class)))
                .thenReturn(Optional.of(activeSub));
        when(subscriptionRepository.save(any(PremiumSubscription.class)))
                .thenAnswer(inv -> inv.getArgument(0));

        PremiumSubscription extended = subscriptionService.extendOrActivateSubscription(userId, 3L, "PAYMENT_EXTEND", 12);

        // Starts at previous expiry
        assertThat(extended.getStartsAt()).isEqualTo(currentExpires);
        // Calendar-month arithmetic: exactly 12 months after current expiry
        ZonedDateTime expiryZoned = currentExpires.atZone(zoneId).plusMonths(12);
        assertThat(extended.getExpiresAt()).isEqualTo(expiryZoned.toInstant());
        assertThat(extended.getPlan()).isEqualTo(plan12Months);
        assertThat(extended.getStatus()).isEqualTo("ACTIVE");
    }

    @Test
    @DisplayName("extendOrActivateSubscription starts from now if previous subscription is already expired")
    void testStartFromNowIfPreviousExpired() {
        Long userId = 100L;
        when(userRepository.findById(userId)).thenReturn(Optional.of(testUser));
        when(planRepository.findById(1L)).thenReturn(Optional.of(plan1Month));
        when(subscriptionRepository.findFirstByUserIdAndStatusAndExpiresAtAfterOrderByExpiresAtDesc(eq(userId), eq("ACTIVE"), any(Instant.class)))
                .thenReturn(Optional.empty());
        when(subscriptionRepository.save(any(PremiumSubscription.class)))
                .thenAnswer(inv -> inv.getArgument(0));

        PremiumSubscription sub = subscriptionService.extendOrActivateSubscription(userId, 1L, "RENEWAL", 1);

        assertThat(sub.getStartsAt()).isNotNull();
        ZonedDateTime startZoned = sub.getStartsAt().atZone(zoneId);
        assertThat(sub.getExpiresAt()).isEqualTo(startZoned.plusMonths(1).toInstant());
    }
}
