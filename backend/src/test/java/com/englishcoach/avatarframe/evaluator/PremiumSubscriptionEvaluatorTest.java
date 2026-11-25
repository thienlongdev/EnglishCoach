package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.premium.entity.PremiumPlan;
import com.englishcoach.premium.entity.PremiumSubscription;
import com.englishcoach.premium.repository.PremiumSubscriptionRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class PremiumSubscriptionEvaluatorTest {

    @Mock
    private PremiumSubscriptionRepository subscriptionRepository;

    @InjectMocks
    private PremiumSubscriptionEvaluator evaluator;

    @Test
    @DisplayName("supports PREMIUM_PLAN and PREMIUM_SUBSCRIPTION")
    void testSupports() {
        assertThat(evaluator.supports("PREMIUM_PLAN")).isTrue();
        assertThat(evaluator.supports("premium_subscription")).isTrue();
        assertThat(evaluator.supports("STREAK_DAYS")).isFalse();
    }

    @Test
    @DisplayName("evaluate: user with 3-month plan qualifies for 1 and 3 month frames, but not 12 month")
    void testEvaluate_tiers() {
        PremiumPlan plan3 = PremiumPlan.builder()
                .id(2L)
                .code("PLAN_3_MONTHS")
                .name("Gói 3 Tháng")
                .durationMonths(3)
                .priceVnd(159000L)
                .build();

        PremiumSubscription sub = PremiumSubscription.builder()
                .id(10L)
                .plan(plan3)
                .status("ACTIVE")
                .startsAt(Instant.now().minusSeconds(86400))
                .expiresAt(Instant.now().plusSeconds(86400 * 60))
                .build();

        when(subscriptionRepository.findActiveSubscriptions(eq(1L), any(Instant.class)))
                .thenReturn(List.of(sub));

        AvatarFrameRequirement req1 = AvatarFrameRequirement.builder()
                .metricType("PREMIUM_PLAN")
                .operator("GTE")
                .targetValue("1")
                .build();

        AvatarFrameRequirement req3 = AvatarFrameRequirement.builder()
                .metricType("PREMIUM_PLAN")
                .operator("GTE")
                .targetValue("3")
                .build();

        AvatarFrameRequirement req12 = AvatarFrameRequirement.builder()
                .metricType("PREMIUM_PLAN")
                .operator("GTE")
                .targetValue("12")
                .build();

        MetricEvaluationResult res1 = evaluator.evaluate(1L, req1);
        assertThat(res1.eligible()).isTrue();
        assertThat(res1.percent()).isEqualTo(100.0);

        MetricEvaluationResult res3 = evaluator.evaluate(1L, req3);
        assertThat(res3.eligible()).isTrue();
        assertThat(res3.percent()).isEqualTo(100.0);

        MetricEvaluationResult res12 = evaluator.evaluate(1L, req12);
        assertThat(res12.eligible()).isFalse();
        assertThat(res12.percent()).isEqualTo(25.0);
    }

    @Test
    @DisplayName("evaluate: non-subscribed user has 0% progress and ineligible")
    void testEvaluate_freeUser() {
        when(subscriptionRepository.findActiveSubscriptions(eq(2L), any(Instant.class)))
                .thenReturn(Collections.emptyList());

        AvatarFrameRequirement req1 = AvatarFrameRequirement.builder()
                .metricType("PREMIUM_PLAN")
                .operator("GTE")
                .targetValue("1")
                .build();

        MetricEvaluationResult res = evaluator.evaluate(2L, req1);
        assertThat(res.eligible()).isFalse();
        assertThat(res.percent()).isEqualTo(0.0);
        assertThat(res.displayCurrent()).isEqualTo("Chưa kích hoạt");
    }
}
