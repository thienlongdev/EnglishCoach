package com.englishcoach.payment.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.payment.config.PaymentProperties;
import com.englishcoach.payment.dto.SepayWebhookPayload;
import com.englishcoach.payment.entity.PaymentOrder;
import com.englishcoach.payment.entity.PaymentOrderStatus;
import com.englishcoach.payment.entity.PaymentTransaction;
import com.englishcoach.payment.entity.PaymentTransactionStatus;
import com.englishcoach.payment.repository.PaymentOrderRepository;
import com.englishcoach.payment.repository.PaymentTransactionRepository;
import com.englishcoach.premium.entity.PremiumPlan;
import com.englishcoach.premium.service.PremiumSubscriptionService;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class PaymentWebhookAndReconciliationTest {

    @Mock
    private PaymentTransactionRepository paymentTransactionRepository;

    @Mock
    private PaymentOrderRepository paymentOrderRepository;

    @Mock
    private PremiumSubscriptionService premiumSubscriptionService;

    @Mock
    private NotificationService notificationService;

    @Mock
    private PaymentProperties paymentProperties;

    @Mock
    private EntityManager entityManager;

    @InjectMocks
    private PaymentReconciliationService reconciliationService;

    private SepayWebhookVerifier verifier;
    private PaymentProperties.SepayConfig sepayConfig;
    private PaymentProperties.BankConfig bankConfig;

    private User testUser;
    private PremiumPlan plan3Months;
    private PaymentOrder validOrder;

    private static final String TEST_SECRET = "super-secret-webhook-key-123456";

    @BeforeEach
    void setUp() {
        sepayConfig = new PaymentProperties.SepayConfig();
        sepayConfig.setEnv("LIVE");
        sepayConfig.setWebhookSecret(TEST_SECRET);

        bankConfig = new PaymentProperties.BankConfig();
        bankConfig.setBankCode("MB");
        bankConfig.setAccountNumber("0987654321");
        bankConfig.setAccountName("ENGLISH COACH");

        lenient().when(paymentProperties.getSepay()).thenReturn(sepayConfig);
        lenient().when(paymentProperties.getBank()).thenReturn(bankConfig);
        lenient().when(paymentProperties.getProvider()).thenReturn("SEPAY");
        lenient().when(paymentProperties.getCodePrefix()).thenReturn("EC");

        verifier = new SepayWebhookVerifier(paymentProperties);

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

        validOrder = PaymentOrder.builder()
                .id(501L)
                .user(testUser)
                .plan(plan3Months)
                .planCodeSnapshot("PREMIUM_3_MONTHS")
                .planNameSnapshot("Gói 3 Tháng")
                .durationMonthsSnapshot(3)
                .amountVnd(159000L)
                .transferCode("EC8F3K91Q2")
                .status(PaymentOrderStatus.PENDING)
                .expiresAt(Instant.now().plus(Duration.ofMinutes(20)))
                .build();

        // Native query mock for advisory lock
        Query mockQuery = mock(Query.class);
        lenient().when(entityManager.createNativeQuery(anyString())).thenReturn(mockQuery);
        lenient().when(mockQuery.setParameter(anyString(), any())).thenReturn(mockQuery);
        lenient().when(mockQuery.getResultList()).thenReturn(Collections.emptyList());
    }

    private String calculateHmac(String data, String secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] rawHmac = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : rawHmac) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    // ==========================================
    // 1. WEBHOOK HMAC SIGNATURE VERIFICATION TESTS
    // ==========================================

    @Test
    @DisplayName("HMAC: Correct raw-body and timestamp HMAC is accepted")
    void hmac_CorrectSignature_Accepted() {
        String rawBody = "{\"id\":\"tx-101\",\"transfer_amount\":159000,\"content\":\"EC8F3K91Q2\"}";
        String timestamp = String.valueOf(java.time.Instant.now().getEpochSecond());
        String signature = calculateHmac(timestamp + "." + rawBody, TEST_SECRET);

        boolean valid = verifier.verifySignature(rawBody.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=" + signature, timestamp);
        assertThat(valid).isTrue();
    }

    @Test
    @DisplayName("HMAC: a correctly signed but stale timestamp is refused (replay window, SEC-02)")
    void hmac_StaleSignedTimestamp_Rejected() {
        String rawBody = "{\"id\":\"tx-102\",\"transfer_amount\":159000,\"content\":\"EC8F3K91Q2\"}";
        String timestamp = String.valueOf(java.time.Instant.now().minus(java.time.Duration.ofDays(8)).getEpochSecond());
        String signature = calculateHmac(timestamp + "." + rawBody, TEST_SECRET);
        assertThat(verifier.verifySignature(rawBody.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=" + signature, timestamp)).isFalse();
    }

    @Test
    @DisplayName("HMAC: a signed timestamp from the provider's retry window (6 days, milliseconds) is accepted")
    void hmac_RetryWindowTimestamp_Accepted() {
        String rawBody = "{\"id\":\"tx-103\",\"transfer_amount\":159000,\"content\":\"EC8F3K91Q2\"}";
        String timestamp = String.valueOf(java.time.Instant.now().minus(java.time.Duration.ofDays(6)).toEpochMilli());
        String signature = calculateHmac(timestamp + "." + rawBody, TEST_SECRET);
        assertThat(verifier.verifySignature(rawBody.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=" + signature, timestamp)).isTrue();
    }

    @Test
    @DisplayName("HMAC: a signed timestamp far in the future is refused")
    void hmac_FutureSignedTimestamp_Rejected() {
        String rawBody = "{\"id\":\"tx-104\",\"transfer_amount\":159000}";
        String timestamp = String.valueOf(java.time.Instant.now().plus(java.time.Duration.ofHours(2)).getEpochSecond());
        String signature = calculateHmac(timestamp + "." + rawBody, TEST_SECRET);
        assertThat(verifier.verifySignature(rawBody.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=" + signature, timestamp)).isFalse();
    }

    @Test
    @DisplayName("HMAC: a delivery without a timestamp is still judged by its body signature alone")
    void hmac_NoTimestamp_SignatureOnly() {
        String rawBody = "{\"id\":\"tx-105\",\"transfer_amount\":159000}";
        String signature = calculateHmac(rawBody, TEST_SECRET);
        assertThat(verifier.verifySignature(rawBody.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=" + signature, null)).isTrue();
    }

    @Test
    @DisplayName("HMAC: Modified body is rejected")
    void hmac_ModifiedBody_Rejected() {
        String originalBody = "{\"id\":\"tx-101\",\"transfer_amount\":159000,\"content\":\"EC8F3K91Q2\"}";
        String tamperedBody = "{\"id\":\"tx-101\",\"transfer_amount\":1,\"content\":\"EC8F3K91Q2\"}";
        String timestamp = "1727361600";
        String signature = calculateHmac(timestamp + "." + originalBody, TEST_SECRET);

        boolean valid = verifier.verifySignature(tamperedBody.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=" + signature, timestamp);
        assertThat(valid).isFalse();
    }

    @Test
    @DisplayName("HMAC: Modified timestamp is rejected")
    void hmac_ModifiedTimestamp_Rejected() {
        String rawBody = "{\"id\":\"tx-101\",\"transfer_amount\":159000,\"content\":\"EC8F3K91Q2\"}";
        String timestamp = "1727361600";
        String signature = calculateHmac(timestamp + "." + rawBody, TEST_SECRET);

        boolean valid = verifier.verifySignature(rawBody.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=" + signature, "1727369999");
        assertThat(valid).isFalse();
    }

    @Test
    @DisplayName("HMAC: Invalid secret / wrong signature is rejected")
    void hmac_WrongSignature_Rejected() {
        String rawBody = "{\"id\":\"tx-101\",\"transfer_amount\":159000}";
        String timestamp = "1727361600";
        String wrongSignature = calculateHmac(timestamp + "." + rawBody, "wrong-secret-key");

        boolean valid = verifier.verifySignature(rawBody.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=" + wrongSignature, timestamp);
        assertThat(valid).isFalse();
    }

    // ==========================================
    // 2. WEBHOOK INGESTION & IDEMPOTENCY TESTS
    // ==========================================

    @Test
    @DisplayName("Idempotency: Duplicate provider transaction ID is ignored and does not re-process")
    void webhook_DuplicateTransactionId_IsIdempotent() {
        SepayWebhookPayload payload = SepayWebhookPayload.builder()
                .id("sepay-tx-999")
                .transferAmount(159000L)
                .content("EC8F3K91Q2")
                .gateway("MB").transferType("in")
                .accountNumber("0987654321")
                .build();

        PaymentTransaction existingTx = PaymentTransaction.builder()
                .id(1L)
                .providerTransactionId("sepay-tx-999")
                .processingStatus(PaymentTransactionStatus.PROCESSED)
                .build();

        when(paymentTransactionRepository.findByProviderTransactionId("sepay-tx-999"))
                .thenReturn(Optional.of(existingTx));

        PaymentTransaction result = reconciliationService.processWebhook(payload, "{}");

        assertThat(result.getId()).isEqualTo(1L);
        assertThat(result.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.PROCESSED);
        verify(paymentTransactionRepository, never()).saveAndFlush(any());
        verify(premiumSubscriptionService, never()).extendOrActivateSubscription(any(), any(), any(), org.mockito.ArgumentMatchers.anyInt());
    }

    // ==========================================
    // 3. RECONCILIATION MATCHING VALIDATION TESTS
    // ==========================================

    @Test
    @DisplayName("Validation: Outbound transfer is ignored and does not activate Premium")
    void reconcile_OutboundTransfer_Ignored() {
        PaymentTransaction tx = PaymentTransaction.builder()
                .providerTransactionId("tx-out-1")
                .gateway("MB").transferType("out")
                .transferAmountVnd(159000L)
                .accountNumber("0987654321")
                .content("EC8F3K91Q2")
                .build();

        reconciliationService.reconcileTransaction(tx);

        assertThat(tx.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.IGNORED);
        assertThat(tx.getErrorMessage()).contains("Outbound");
        verify(premiumSubscriptionService, never()).extendOrActivateSubscription(any(), any(), any(), org.mockito.ArgumentMatchers.anyInt());
    }

    @Test
    @DisplayName("Validation: Wrong receiving account does not activate Premium and is UNMATCHED")
    void reconcile_WrongAccount_Unmatched() {
        PaymentTransaction tx = PaymentTransaction.builder()
                .providerTransactionId("tx-wrong-acc")
                .gateway("MB").transferType("in")
                .transferAmountVnd(159000L)
                .accountNumber("111222333") // Not configured account 0987654321
                .content("EC8F3K91Q2")
                .build();

        reconciliationService.reconcileTransaction(tx);

        assertThat(tx.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.UNMATCHED);
        assertThat(tx.getErrorMessage()).contains("account");
        verify(premiumSubscriptionService, never()).extendOrActivateSubscription(any(), any(), any(), org.mockito.ArgumentMatchers.anyInt());
    }

    @Test
    @DisplayName("Validation: Wrong amount does not activate Premium and is UNMATCHED")
    void reconcile_WrongAmount_Unmatched() {
        PaymentTransaction tx = PaymentTransaction.builder()
                .providerTransactionId("tx-wrong-amt")
                .gateway("MB").transferType("in")
                .transferAmountVnd(59000L) // Plan price is 159,000 VND
                .accountNumber("0987654321")
                .content("EC8F3K91Q2")
                .build();

        when(paymentOrderRepository.findByTransferCode("EC8F3K91Q2")).thenReturn(Optional.of(validOrder));

        reconciliationService.reconcileTransaction(tx);

        assertThat(tx.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.UNMATCHED);
        assertThat(tx.getErrorMessage()).contains("Amount mismatch");
        assertThat(validOrder.getStatus()).isEqualTo(PaymentOrderStatus.PENDING); // Not paid
        verify(premiumSubscriptionService, never()).extendOrActivateSubscription(any(), any(), any(), org.mockito.ArgumentMatchers.anyInt());
    }

    @Test
    @DisplayName("Validation: Unknown transfer code does not activate Premium and is UNMATCHED")
    void reconcile_UnknownTransferCode_Unmatched() {
        PaymentTransaction tx = PaymentTransaction.builder()
                .providerTransactionId("tx-unknown-code")
                .gateway("MB").transferType("in")
                .transferAmountVnd(159000L)
                .accountNumber("0987654321")
                .content("CHUYEN TIEN ECUNKNOWN99")
                .build();

        when(paymentOrderRepository.findByTransferCode("ECUNKNOWN99")).thenReturn(Optional.empty());

        reconciliationService.reconcileTransaction(tx);

        assertThat(tx.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.UNMATCHED);
        assertThat(tx.getErrorMessage()).contains("No matching payment order");
        verify(premiumSubscriptionService, never()).extendOrActivateSubscription(any(), any(), any(), org.mockito.ArgumentMatchers.anyInt());
    }

    @Test
    @DisplayName("Validation: Expired order does not activate Premium and marks order EXPIRED")
    void reconcile_ExpiredOrder_NotActivated() {
        validOrder.setExpiresAt(Instant.now().minus(Duration.ofMinutes(10))); // Expired

        PaymentTransaction tx = PaymentTransaction.builder()
                .providerTransactionId("tx-expired")
                .gateway("MB").transferType("in")
                .transferAmountVnd(159000L)
                .accountNumber("0987654321")
                .content("EC8F3K91Q2")
                .build();

        when(paymentOrderRepository.findByTransferCode("EC8F3K91Q2")).thenReturn(Optional.of(validOrder));

        reconciliationService.reconcileTransaction(tx);

        assertThat(tx.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.UNMATCHED);
        assertThat(tx.getErrorMessage()).contains("expired");
        assertThat(validOrder.getStatus()).isEqualTo(PaymentOrderStatus.EXPIRED);
        verify(premiumSubscriptionService, never()).extendOrActivateSubscription(any(), any(), any(), org.mockito.ArgumentMatchers.anyInt());
    }

    // ==========================================
    // 4. SUCCESSFUL RECONCILIATION & ACTIVATION
    // ==========================================

    @Test
    @DisplayName("Activation: Exact match marks order PAID, transaction PROCESSED, extends Premium, and notifies user")
    void reconcile_ExactMatch_ActivatesPremiumSuccessfully() {
        PaymentTransaction tx = PaymentTransaction.builder()
                .providerTransactionId("sepay-live-001")
                .gateway("MB").transferType("in")
                .transferAmountVnd(159000L)
                .accountNumber("0987654321")
                .content("THANH TOAN EC8F3K91Q2 TIEN HOC")
                .build();

        when(paymentOrderRepository.findByTransferCode("EC8F3K91Q2")).thenReturn(Optional.of(validOrder));

        reconciliationService.reconcileTransaction(tx);

        // Verify order is PAID
        assertThat(validOrder.getStatus()).isEqualTo(PaymentOrderStatus.PAID);
        assertThat(validOrder.getPaidAt()).isNotNull();
        assertThat(validOrder.getProviderTransactionId()).isEqualTo("sepay-live-001");
        verify(paymentOrderRepository).save(validOrder);

        // Verify transaction is PROCESSED
        assertThat(tx.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.PROCESSED);
        assertThat(tx.getProcessedAt()).isNotNull();
        verify(paymentTransactionRepository).save(tx);

        // Verify Premium activation was called with correct user and plan
        verify(premiumSubscriptionService).extendOrActivateSubscription(eq(100L), eq(2L), eq("SEPAY:sepay-live-001"), eq(3));

        // Verify notification created with deterministic order ID
        verify(notificationService).createPaymentSuccessNotification(eq(100L), eq("Gói 3 Tháng"), eq(501L));
    }
}
