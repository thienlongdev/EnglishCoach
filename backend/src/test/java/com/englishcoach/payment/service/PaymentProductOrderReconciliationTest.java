package com.englishcoach.payment.service;

import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.payment.config.PaymentProperties;
import com.englishcoach.payment.entity.PaymentOrder;
import com.englishcoach.payment.entity.PaymentOrderStatus;
import com.englishcoach.payment.entity.PaymentTransaction;
import com.englishcoach.payment.entity.PaymentTransactionStatus;
import com.englishcoach.payment.product.PaymentProductHandler;
import com.englishcoach.payment.product.PaymentProductHandler.Settlement;
import com.englishcoach.payment.product.PaymentProductHandler.VerifiedTransfer;
import com.englishcoach.payment.repository.PaymentOrderRepository;
import com.englishcoach.payment.repository.PaymentTransactionRepository;
import com.englishcoach.premium.entity.PremiumPlan;
import com.englishcoach.premium.service.PremiumSubscriptionService;
import com.englishcoach.auth.entity.User;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * One-time product orders on the existing SePay path: the payment module's own checks run first, a product handler is
 * asked only for a verified transfer whose code names no Premium order, and the Premium path is exactly as before.
 */
@ExtendWith(MockitoExtension.class)
class PaymentProductOrderReconciliationTest {

    @Mock private PaymentTransactionRepository transactions;
    @Mock private PaymentOrderRepository orders;
    @Mock private PremiumSubscriptionService premium;
    @Mock private NotificationService notifications;
    @Mock private PaymentProperties properties;
    @Mock private EntityManager entityManager;
    @Mock private PaymentProductHandler handler;

    private PaymentReconciliationService service;

    @BeforeEach
    void setUp() {
        var bank = new PaymentProperties.BankConfig();
        bank.setBankCode("MB");
        bank.setAccountNumber("0987654321");
        bank.setAccountName("ENGLISH COACH");
        lenient().when(properties.getBank()).thenReturn(bank);
        lenient().when(properties.getProvider()).thenReturn("SEPAY");
        lenient().when(properties.getCodePrefix()).thenReturn("EC");
        Query query = mock(Query.class);
        lenient().when(entityManager.createNativeQuery(anyString())).thenReturn(query);
        lenient().when(query.setParameter(anyString(), any())).thenReturn(query);
        lenient().when(query.getResultList()).thenReturn(List.of());
        lenient().when(handler.productKind()).thenReturn("GARDEN_COSMETIC");
        service = new PaymentReconciliationService(transactions, orders, premium, notifications, properties, entityManager);
        ReflectionTestUtils.setField(service, "productHandlers", List.of(handler));
    }

    private static PaymentTransaction transfer(String id, String type, long amount, String account, String content) {
        return PaymentTransaction.builder().providerTransactionId(id).provider("SEPAY").gateway("MB").transferType(type).transferAmountVnd(amount)
                .accountNumber(account).content(content).build();
    }

    @Test
    void aVerifiedTransferForAProductOrderIsHandedToItsHandlerAndNeverActivatesPremium() {
        PaymentTransaction tx = transfer("tx-skin-1", "in", 149_000, "0987654321", "MUA SKIN ECG7H2K9QW");
        when(orders.findByTransferCode("ECG7H2K9QW")).thenReturn(Optional.empty());
        when(handler.ownsTransferCode("ECG7H2K9QW")).thenReturn(true);
        when(handler.settle(any())).thenReturn(new Settlement(true, "order:41", "FULFILLED", null));

        service.reconcileTransaction(tx);

        ArgumentCaptor<VerifiedTransfer> seen = ArgumentCaptor.forClass(VerifiedTransfer.class);
        verify(handler).settle(seen.capture());
        assertThat(seen.getValue().providerTransactionId()).isEqualTo("tx-skin-1");
        assertThat(seen.getValue().transferCode()).isEqualTo("ECG7H2K9QW");
        assertThat(seen.getValue().amountVnd()).isEqualTo(149_000);
        assertThat(tx.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.PROCESSED);
        assertThat(tx.getErrorMessage()).isNull();
        verify(premium, never()).extendOrActivateSubscription(any(), any(), any(), org.mockito.ArgumentMatchers.anyInt());
    }

    @Test
    void aTransferTheHandlerCannotDeliverStaysUnmatchedForTheAdministrator() {
        PaymentTransaction tx = transfer("tx-skin-late", "in", 29_000, "0987654321", "ECG7H2K9QX");
        when(orders.findByTransferCode("ECG7H2K9QX")).thenReturn(Optional.empty());
        when(handler.ownsTransferCode("ECG7H2K9QX")).thenReturn(true);
        when(handler.settle(any())).thenReturn(new Settlement(false, "order:42", "LATE_PAYMENT", "issue #3"));

        service.reconcileTransaction(tx);

        assertThat(tx.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.UNMATCHED);
        assertThat(tx.getErrorMessage()).isEqualTo("GARDEN_COSMETIC: LATE_PAYMENT");
        verify(premium, never()).extendOrActivateSubscription(any(), any(), any(), org.mockito.ArgumentMatchers.anyInt());
    }

    @Test
    void anOutboundAForeignAccountOrANonPositiveTransferNeverReachesAHandler() {
        service.reconcileTransaction(transfer("tx-out", "out", 149_000, "0987654321", "ECG7H2K9QW"));
        service.reconcileTransaction(transfer("tx-other-account", "in", 149_000, "1111111111", "ECG7H2K9QW"));
        service.reconcileTransaction(transfer("tx-zero", "in", 0, "0987654321", "ECG7H2K9QW"));

        verify(handler, never()).ownsTransferCode(anyString());
        verify(handler, never()).settle(any());
    }

    @Test
    void aCodeNoOrderOfAnyKindKnowsIsUnmatchedAsBefore() {
        PaymentTransaction tx = transfer("tx-unknown", "in", 149_000, "0987654321", "ECUNKNOWN99");
        when(orders.findByTransferCode("ECUNKNOWN99")).thenReturn(Optional.empty());
        when(handler.ownsTransferCode("ECUNKNOWN99")).thenReturn(false);

        service.reconcileTransaction(tx);

        assertThat(tx.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.UNMATCHED);
        assertThat(tx.getErrorMessage()).contains("No matching payment order");
        verify(handler, never()).settle(any());
    }

    @Test
    void aPremiumOrderStillActivatesPremiumAndNoHandlerIsAsked() {
        User user = new User();
        user.setId(100L);
        PremiumPlan plan = PremiumPlan.builder().id(2L).code("PLAN_3_MONTHS").name("Gói 3 Tháng").durationMonths(3).priceVnd(159_000L).active(true).build();
        PaymentOrder order = PaymentOrder.builder().id(501L).user(user).plan(plan).planCodeSnapshot("PLAN_3_MONTHS").planNameSnapshot("Gói 3 Tháng")
                .durationMonthsSnapshot(3).amountVnd(159_000L).transferCode("EC8F3K91Q2").status(PaymentOrderStatus.PENDING)
                .expiresAt(Instant.now().plus(Duration.ofMinutes(20))).build();
        PaymentTransaction tx = transfer("tx-premium", "in", 159_000, "0987654321", "EC8F3K91Q2");
        when(orders.findByTransferCode("EC8F3K91Q2")).thenReturn(Optional.of(order));

        service.reconcileTransaction(tx);

        assertThat(order.getStatus()).isEqualTo(PaymentOrderStatus.PAID);
        verify(premium).extendOrActivateSubscription(100L, 2L, "SEPAY:tx-premium", 3);
        verify(handler, never()).ownsTransferCode(anyString());
        verify(handler, never()).settle(any());
    }

    @Test
    @SuppressWarnings("unchecked")
    void aNewReferenceIsUniqueAcrossPremiumOrdersAndProductOrders() {
        ObjectProvider<PaymentProductHandler> provider = mock(ObjectProvider.class);
        when(provider.stream()).thenAnswer(i -> Stream.of(handler));
        when(orders.existsByTransferCode(anyString())).thenReturn(false);
        // the first candidate is taken by a product order, the second is free
        when(handler.ownsTransferCode(anyString())).thenReturn(true, false);
        TransferCodeService codes = new TransferCodeService(orders, properties, provider);

        String code = codes.newCode();

        assertThat(code).matches("^EC[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$");
        verify(handler, org.mockito.Mockito.times(2)).ownsTransferCode(anyString());
    }
}
