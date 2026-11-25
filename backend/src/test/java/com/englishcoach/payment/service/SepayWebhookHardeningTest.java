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
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import jakarta.persistence.Query;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Payment webhook under hostile or unlucky delivery: an unsigned call in production, the same transfer delivered twice
 * at once, and two transfers that name one order. Nothing here talks to the provider or to a bank.
 */
class SepayWebhookHardeningTest {

    private PaymentTransactionRepository transactions;
    private PaymentOrderRepository orders;
    private PremiumSubscriptionService premium;
    private EntityManager entityManager;
    private PaymentProperties properties;
    private PaymentProperties.SepayConfig sepay;
    private PaymentReconciliationService service;
    private PaymentOrder order;

    @BeforeEach
    void setUp() {
        transactions = mock(PaymentTransactionRepository.class);
        orders = mock(PaymentOrderRepository.class);
        premium = mock(PremiumSubscriptionService.class);
        entityManager = mock(EntityManager.class);
        properties = mock(PaymentProperties.class);

        sepay = new PaymentProperties.SepayConfig();
        sepay.setEnv("LIVE");
        sepay.setWebhookSecret("a-webhook-secret-used-only-in-this-test");
        PaymentProperties.BankConfig bank = new PaymentProperties.BankConfig();
        bank.setBankCode("MB");
        bank.setAccountNumber("0987654321");
        when(properties.getSepay()).thenReturn(sepay);
        when(properties.getBank()).thenReturn(bank);
        when(properties.getProvider()).thenReturn("SEPAY");
        when(properties.getCodePrefix()).thenReturn("EC");

        Query lockQuery = mock(Query.class);
        when(entityManager.createNativeQuery(anyString())).thenReturn(lockQuery);
        when(lockQuery.setParameter(anyString(), any())).thenReturn(lockQuery);
        when(lockQuery.getResultList()).thenReturn(Collections.emptyList());

        service = new PaymentReconciliationService(transactions, orders, premium, mock(NotificationService.class),
                properties, entityManager);

        User learner = new User();
        learner.setId(100L);
        PremiumPlan plan = PremiumPlan.builder().id(2L).code("PREMIUM_3_MONTHS").name("Plan").durationMonths(3)
                .priceVnd(159000L).active(true).build();
        order = PaymentOrder.builder().id(501L).user(learner).plan(plan).planCodeSnapshot("PREMIUM_3_MONTHS")
                .planNameSnapshot("Plan").durationMonthsSnapshot(3).amountVnd(159000L).transferCode("EC8F3K91Q2")
                .status(PaymentOrderStatus.PENDING).expiresAt(Instant.now().plus(Duration.ofMinutes(20))).build();
        when(orders.findByTransferCode("EC8F3K91Q2")).thenReturn(Optional.of(order));
        when(transactions.saveAndFlush(any(PaymentTransaction.class))).thenAnswer(call -> call.getArgument(0));
    }

    private static PaymentTransaction inbound(String providerId) {
        return PaymentTransaction.builder().providerTransactionId(providerId).gateway("MB").transferType("in")
                .transferAmountVnd(159000L).accountNumber("0987654321").content("CK EC8F3K91Q2").build();
    }

    private static SepayWebhookPayload payload(String providerId) {
        SepayWebhookPayload payload = new SepayWebhookPayload();
        payload.setId(providerId);
        payload.setTransferType("in");
        payload.setTransferAmount(159000L);
        payload.setAccountNumber("0987654321");
        payload.setContent("CK EC8F3K91Q2");
        return payload;
    }

    // ---- unsigned deliveries ------------------------------------------------------------------------------------

    @Test
    @DisplayName("Production never accepts an unsigned delivery, even with SEPAY_ENV=TEST and no secret")
    void productionRefusesUnsignedDelivery() {
        sepay.setEnv("TEST");
        sepay.setWebhookSecret("");
        SepayWebhookVerifier verifier = new SepayWebhookVerifier(properties);

        assertThat(verifier.verifySignature("{\"id\":\"1\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8), null, null)).isFalse();
        assertThat(verifier.verifySignature("{\"id\":\"1\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=00", null)).isFalse();
    }

    @Test
    @DisplayName("A configured secret is always enforced: no signature, no acceptance")
    void missingSignatureIsRefusedWhenSecretIsSet() {
        SepayWebhookVerifier verifier = new SepayWebhookVerifier(properties);

        assertThat(verifier.verifySignature("{\"id\":\"1\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8), null, null)).isFalse();
        assertThat(verifier.verifySignature("{\"id\":\"1\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8), "", "1700000000")).isFalse();
    }

    // ---- two transfers for one order ----------------------------------------------------------------------------

    @Test
    @DisplayName("The order row is locked and read again before its state decides anything")
    void orderIsLockedBeforeTheDecision() {
        PaymentTransaction tx = inbound("sepay-a");

        service.reconcileTransaction(tx);

        InOrder sequence = inOrder(entityManager, orders, premium);
        sequence.verify(entityManager).refresh(order, LockModeType.PESSIMISTIC_WRITE);
        sequence.verify(orders).save(order);
        sequence.verify(premium).extendOrActivateSubscription(100L, 2L, "SEPAY:sepay-a", 3);
    }

    @Test
    @DisplayName("A second transfer that waited for the lock finds the order paid and activates nothing")
    void secondTransferForSameOrderActivatesNothing() {
        // What the row lock makes visible: while this transfer waited, the first one committed the order as PAID.
        doAnswer(call -> {
            order.setStatus(PaymentOrderStatus.PAID);
            return null;
        }).when(entityManager).refresh(order, LockModeType.PESSIMISTIC_WRITE);
        PaymentTransaction second = inbound("sepay-b");

        service.reconcileTransaction(second);

        assertThat(second.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.UNMATCHED);
        assertThat(second.getErrorMessage()).contains("already");
        verify(premium, never()).extendOrActivateSubscription(anyLong(), anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt());
    }

    // ---- the same transfer delivered twice at once --------------------------------------------------------------

    @Test
    @DisplayName("The losing copy of a concurrent duplicate fails on the unique index and activates nothing")
    void concurrentDuplicateDeliveryActivatesOnce() {
        when(transactions.findByProviderTransactionId("sepay-dup")).thenReturn(Optional.empty());
        // The winner's insert succeeded; the loser's insert hits uq_payment_transactions_provider_tx_id.
        when(transactions.saveAndFlush(any(PaymentTransaction.class)))
                .thenThrow(new DataIntegrityViolationException("duplicate key value violates unique constraint"));

        assertThatThrownBy(() -> service.processWebhook(payload("sepay-dup"), "{}"))
                .isInstanceOf(DataIntegrityViolationException.class);

        verify(premium, never()).extendOrActivateSubscription(anyLong(), anyLong(), anyString(), org.mockito.ArgumentMatchers.anyInt());
        verify(orders, never()).save(any());
    }

    @Test
    @DisplayName("PostgreSQL 17, table exactly as V37 creates it: 16 concurrent copies of one transfer leave one row")
    void uniqueIndexHoldsUnderConcurrency() throws Exception {
        try (PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:17")) {
            postgres.start();
            HikariConfig config = new HikariConfig();
            config.setJdbcUrl(postgres.getJdbcUrl());
            config.setUsername(postgres.getUsername());
            config.setPassword(postgres.getPassword());
            config.setMaximumPoolSize(16);
            try (HikariDataSource dataSource = new HikariDataSource(config)) {
                JdbcTemplate jdbc = new JdbcTemplate(dataSource);
                // Only what V37 references from earlier migrations; V37 itself is executed unchanged.
                jdbc.execute("CREATE TABLE public.users (id BIGSERIAL PRIMARY KEY)");
                jdbc.execute("CREATE TABLE public.premium_plans (id BIGSERIAL PRIMARY KEY)");
                jdbc.execute(Files.readString(Path.of(
                        "src/main/resources/db/migration/exams/V37__payment_orders_and_transactions.sql")));

                int copies = 16;
                ExecutorService pool = Executors.newFixedThreadPool(copies);
                CountDownLatch go = new CountDownLatch(1);
                List<Future<Boolean>> inserts = new ArrayList<>();
                for (int i = 0; i < copies; i++) {
                    inserts.add(pool.submit(() -> {
                        go.await();
                        try {
                            jdbc.update("""
                                    INSERT INTO public.payment_transactions
                                        (provider, provider_transaction_id, account_number, transfer_type,
                                         transfer_amount_vnd, raw_payload, processing_status)
                                    VALUES ('SEPAY', 'sepay-dup', '0987654321', 'in', 159000, '{}', 'RECEIVED')
                                    """);
                            return true;
                        } catch (DuplicateKeyException duplicate) {
                            return false;
                        }
                    }));
                }
                go.countDown();
                int accepted = 0;
                for (Future<Boolean> insert : inserts) {
                    if (insert.get()) accepted++;
                }
                pool.shutdown();

                assertThat(accepted).isEqualTo(1);
                assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM public.payment_transactions WHERE provider_transaction_id = 'sepay-dup'",
                        Integer.class)).isEqualTo(1);
            }
        }
    }
}
