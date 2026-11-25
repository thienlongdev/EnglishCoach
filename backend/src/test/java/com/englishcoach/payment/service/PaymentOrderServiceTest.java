package com.englishcoach.payment.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.payment.config.PaymentProperties;
import com.englishcoach.payment.dto.CreatePaymentOrderRequest;
import com.englishcoach.payment.dto.PaymentOrderResponse;
import com.englishcoach.payment.entity.PaymentOrder;
import com.englishcoach.payment.entity.PaymentOrderStatus;
import com.englishcoach.payment.repository.PaymentOrderRepository;
import com.englishcoach.premium.entity.PremiumPlan;
import com.englishcoach.premium.repository.PremiumPlanRepository;
import com.englishcoach.premium.service.PremiumSubscriptionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class PaymentOrderServiceTest {

    @Mock
    private PaymentOrderRepository paymentOrderRepository;

    @Mock
    private PremiumPlanRepository premiumPlanRepository;

    @Mock
    private UserRepository userRepository;

    @Mock
    private PaymentProperties paymentProperties;

    @Mock
    private VietQrService vietQrService;

    @Mock
    private PremiumSubscriptionService premiumSubscriptionService;

    @InjectMocks
    private PaymentOrderService paymentOrderService;

    private User testUser;
    private PremiumPlan plan3Months;
    private PaymentProperties.BankConfig bankConfig;

    @BeforeEach
    void setUp() {
        testUser = new User();
        testUser.setId(100L);
        testUser.setEmail("learner@example.com");

        plan3Months = PremiumPlan.builder()
                .id(2L)
                .code("PREMIUM_3_MONTHS")
                .name("Gói 3 Tháng")
                .durationMonths(3)
                .priceVnd(159000L)
                .active(true)
                .build();

        bankConfig = new PaymentProperties.BankConfig();
        bankConfig.setBankCode("MB");
        bankConfig.setAccountNumber("0987654321");
        bankConfig.setAccountName("ENGLISH COACH");

        lenient().when(paymentProperties.getBank()).thenReturn(bankConfig);
        lenient().when(paymentProperties.getCodePrefix()).thenReturn("EC");
        lenient().when(paymentProperties.getOrderTtlMinutes()).thenReturn(20);
        lenient().when(paymentProperties.isConfiguredForProduction()).thenReturn(true);
        lenient().when(paymentProperties.getProvider()).thenReturn("SEPAY");
        lenient().when(vietQrService.generateQrImageUrl(any(), any(), any(), any()))
                .thenReturn("https://qr.sepay.vn/img?mock=1");
    }

    @Test
    @DisplayName("Create order uses DB plan price and ignores any client-supplied amount or price")
    void createOrder_UsesDbPlanPrice_AuthorityOnServer() {
        when(userRepository.findById(100L)).thenReturn(Optional.of(testUser));
        when(premiumPlanRepository.findByCode("PREMIUM_3_MONTHS")).thenReturn(Optional.of(plan3Months));
        when(paymentOrderRepository.findActivePendingOrders(eq(100L), eq("PREMIUM_3_MONTHS"), eq(PaymentOrderStatus.PENDING), any()))
                .thenReturn(Collections.emptyList());
        when(paymentOrderRepository.existsByTransferCode(anyString())).thenReturn(false);
        when(paymentOrderRepository.save(any(PaymentOrder.class))).thenAnswer(invocation -> {
            PaymentOrder po = invocation.getArgument(0);
            po.setId(501L);
            po.setCreatedAt(Instant.now());
            return po;
        });

        CreatePaymentOrderRequest request = new CreatePaymentOrderRequest("PREMIUM_3_MONTHS");
        PaymentOrderResponse response = paymentOrderService.createPaymentOrder(100L, request);

        assertThat(response).isNotNull();
        assertThat(response.getOrderId()).isEqualTo(501L);
        assertThat(response.getAmountVnd()).isEqualTo(159000L); // Exactly DB plan price
        assertThat(response.getPlanCode()).isEqualTo("PREMIUM_3_MONTHS");
        assertThat(response.getTransferCode()).startsWith("EC");
        assertThat(response.getStatus()).isEqualTo("PENDING");
        assertThat(response.getExpiresAt()).isAfter(Instant.now().plus(Duration.ofMinutes(15)));
    }

    @Test
    @DisplayName("Create order rejects inactive plan")
    void createOrder_RejectsInactivePlan() {
        PremiumPlan inactivePlan = PremiumPlan.builder()
                .id(99L)
                .code("LEGACY_PLAN")
                .name("Legacy")
                .active(false)
                .priceVnd(99999L)
                .build();

        when(userRepository.findById(100L)).thenReturn(Optional.of(testUser));
        when(premiumPlanRepository.findByCode("LEGACY_PLAN")).thenReturn(Optional.of(inactivePlan));

        CreatePaymentOrderRequest request = new CreatePaymentOrderRequest("LEGACY_PLAN");
        assertThatThrownBy(() -> paymentOrderService.createPaymentOrder(100L, request))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("not available for purchase");
    }

    @Test
    @DisplayName("Order snapshot preserves original amount even if plan price changes later")
    void orderSnapshot_PreservesOriginalAmount() {
        PaymentOrder order = PaymentOrder.builder()
                .id(501L)
                .user(testUser)
                .plan(plan3Months)
                .planCodeSnapshot("PREMIUM_3_MONTHS")
                .planNameSnapshot("Gói 3 Tháng")
                .durationMonthsSnapshot(3)
                .amountVnd(159000L) // original snapshot price
                .transferCode("ECTEST12345")
                .status(PaymentOrderStatus.PENDING)
                .expiresAt(Instant.now().plus(Duration.ofMinutes(20)))
                .build();

        // Simulate plan price increasing tomorrow to 199,000 VND
        plan3Months.setPriceVnd(199000L);

        PaymentOrderResponse response = paymentOrderService.toResponse(order, null);
        assertThat(response.getAmountVnd()).isEqualTo(159000L); // Snapshot retained
    }

    @Test
    @DisplayName("Get payment order enforces user isolation and rejects other users with 404 NOT FOUND")
    void getPaymentOrder_EnforcesUserIsolation() {
        PaymentOrder order = PaymentOrder.builder()
                .id(501L)
                .user(testUser) // belongs to user 100
                .plan(plan3Months)
                .planCodeSnapshot("PREMIUM_3_MONTHS")
                .planNameSnapshot("Gói 3 Tháng")
                .durationMonthsSnapshot(3)
                .amountVnd(159000L)
                .transferCode("ECTEST12345")
                .status(PaymentOrderStatus.PENDING)
                .expiresAt(Instant.now().plus(Duration.ofMinutes(20)))
                .build();

        when(paymentOrderRepository.findByIdAndUserId(501L, 100L)).thenReturn(Optional.of(order));

        when(paymentOrderRepository.findByIdAndUserId(501L, 200L)).thenReturn(Optional.empty());
        // User 200 attempts to read order 501
        assertThatThrownBy(() -> paymentOrderService.getPaymentOrder(200L, 501L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404");

        // User 100 reads order 501 successfully
        PaymentOrderResponse response = paymentOrderService.getPaymentOrder(100L, 501L);
        assertThat(response).isNotNull();
        assertThat(response.getOrderId()).isEqualTo(501L);
    }

    @Test
    @DisplayName("Expired order is automatically marked EXPIRED on lookup")
    void getPaymentOrder_ExpiredOrder_MarkedExpired() {
        PaymentOrder expiredOrder = PaymentOrder.builder()
                .id(502L)
                .user(testUser)
                .plan(plan3Months)
                .planCodeSnapshot("PREMIUM_3_MONTHS")
                .planNameSnapshot("Gói 3 Tháng")
                .durationMonthsSnapshot(3)
                .amountVnd(159000L)
                .transferCode("ECEXPIRED12")
                .status(PaymentOrderStatus.PENDING)
                .expiresAt(Instant.now().minus(Duration.ofMinutes(5))) // expired 5 mins ago
                .build();

        when(paymentOrderRepository.findByIdAndUserId(502L, 100L)).thenReturn(Optional.of(expiredOrder));


        PaymentOrderResponse response = paymentOrderService.getPaymentOrder(100L, 502L);
        assertThat(response.getStatus()).isEqualTo("EXPIRED");
        verify(paymentOrderRepository, never()).save(any());
    }
}
