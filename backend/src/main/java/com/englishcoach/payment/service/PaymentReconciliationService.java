package com.englishcoach.payment.service;

import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.payment.config.PaymentProperties;
import com.englishcoach.payment.dto.SepayWebhookPayload;
import com.englishcoach.payment.entity.PaymentOrder;
import com.englishcoach.payment.entity.PaymentOrderStatus;
import com.englishcoach.payment.entity.PaymentTransaction;
import com.englishcoach.payment.entity.PaymentTransactionStatus;
import com.englishcoach.payment.repository.PaymentOrderRepository;
import com.englishcoach.payment.repository.PaymentTransactionRepository;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumSubscriptionService;
import jakarta.persistence.EntityManager;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;
import com.englishcoach.payment.product.PaymentProductHandler;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentReconciliationService {

    private final PaymentTransactionRepository paymentTransactionRepository;
    private final PaymentOrderRepository paymentOrderRepository;
    private final PremiumSubscriptionService premiumSubscriptionService;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.beans.factory.ObjectProvider<PremiumEntitlementService> premiumEntitlementService;
    private final NotificationService notificationService;
    private final PaymentProperties paymentProperties;
    private final EntityManager entityManager;

    /** One-time products sold through the same verified transfer path (none in slim unit tests). */
    @Autowired(required = false)
    @Lazy
    private List<PaymentProductHandler> productHandlers;

    /** Whether a delivery with this provider transaction id is committed (read outside any transaction of the caller). */
    public boolean isRecorded(String providerTransactionId) {
        return providerTransactionId != null
                && paymentTransactionRepository.findByProviderTransactionId(providerTransactionId.trim()).isPresent();
    }

    /**
     * Ingests and processes a SePay webhook delivery.
     * Deduplicates at the database level by provider_transaction_id.
     */
    @Transactional
    public PaymentTransaction processWebhook(SepayWebhookPayload payload, String rawPayload) {
        String providerTxId = payload.getId() != null ? payload.getId().trim() : null;
        if (providerTxId == null || providerTxId.isBlank()) {
            throw new IllegalArgumentException("Provider transaction ID is missing from webhook payload");
        }

        // 1. Replay Safety: Deduplicate by provider transaction ID
        entityManager.createNativeQuery("SELECT pg_advisory_xact_lock(92132, hashtext(:providerTxId))")
                .setParameter("providerTxId", providerTxId).getResultList();
        Optional<PaymentTransaction> existingTxOpt = paymentTransactionRepository.findByProviderTransactionId(providerTxId);
        if (existingTxOpt.isPresent()) {
            log.info("[SePay Webhook] Duplicate transaction delivery ignored for id={}", providerTxId);
            return existingTxOpt.get();
        }

        // 2. Persist new transaction inbox record
        PaymentTransaction tx = PaymentTransaction.builder()
                .provider(paymentProperties.getProvider())
                .providerTransactionId(providerTxId)
                .gateway(payload.getGateway())
                .accountNumber(payload.getAccountNumber() != null ? payload.getAccountNumber().trim() : "")
                .subAccount(payload.getSubAccount() != null ? payload.getSubAccount().trim() : null)
                .paymentCode(payload.getCode() != null ? payload.getCode().trim() : null)
                .content(payload.getContent())
                .transferType(payload.getTransferType() != null ? payload.getTransferType().trim().toLowerCase() : "")
                .transferAmountVnd(payload.getTransferAmount() != null ? payload.getTransferAmount() : 0L)
                .referenceCode(payload.getReferenceCode())
                .rawPayload(rawPayload)
                .processingStatus(PaymentTransactionStatus.RECEIVED)
                .build();

        tx = paymentTransactionRepository.saveAndFlush(tx);

        // 3. Reconcile and activate
        if (payload.getCurrency() != null && !"VND".equalsIgnoreCase(payload.getCurrency())) {
            tx.setProcessingStatus(PaymentTransactionStatus.UNMATCHED);
            tx.setErrorMessage("Unexpected transfer currency");
            return tx;
        }
        reconcileTransaction(tx);
        return tx;
    }

    /**
     * Validates transaction and idempotently matches with payment order.
     */
    @Transactional
    public void reconcileTransaction(PaymentTransaction tx) {
        // Step 1: Inbound only validation
        if (!"in".equalsIgnoreCase(tx.getTransferType())) {
            log.info("[Payment] Transaction id={} ignored: transferType is '{}' (not inbound)",
                    tx.getProviderTransactionId(), tx.getTransferType());
            tx.setProcessingStatus(PaymentTransactionStatus.IGNORED);
            tx.setErrorMessage("Outbound transfer ignored");
            paymentTransactionRepository.save(tx);
            return;
        }

        // Step 2: Positive amount check
        if (tx.getTransferAmountVnd() == null || tx.getTransferAmountVnd() <= 0) {
            log.warn("[Payment] Transaction id={} rejected: non-positive amount {}",
                    tx.getProviderTransactionId(), tx.getTransferAmountVnd());
            tx.setProcessingStatus(PaymentTransactionStatus.FAILED);
            tx.setErrorMessage("Transfer amount must be positive");
            paymentTransactionRepository.save(tx);
            return;
        }

        // Step 3: Receiving account validation (trim all sides so provider whitespace never causes false mismatch)
        String expectedAccount = paymentProperties.getBank().getAccountNumber() != null
                ? paymentProperties.getBank().getAccountNumber().trim() : "";
        String expectedBank = paymentProperties.getBank().getBankCode() != null
                ? paymentProperties.getBank().getBankCode().trim() : "";
        String txGateway = tx.getGateway() != null ? tx.getGateway().trim() : "";
        String txAccount = tx.getAccountNumber() != null ? tx.getAccountNumber().trim() : "";
        String txSubAccount = tx.getSubAccount() != null ? tx.getSubAccount().trim() : "";
        if (expectedAccount.isBlank() || expectedBank.isBlank()
                || !expectedBank.equalsIgnoreCase(txGateway)
                || !(expectedAccount.equals(txAccount) || expectedAccount.equals(txSubAccount))) {
            tx.setProcessingStatus(PaymentTransactionStatus.UNMATCHED);
            tx.setErrorMessage("Receiving bank or account does not match merchant");
            com.englishcoach.common.security.SecuritySignals.signal("PAYMENT_UNMATCHED", "ACCOUNT_MISMATCH");
            paymentTransactionRepository.save(tx);
            return;
        }

        // Step 4: Transfer code resolution
        String resolvedCode = extractTransferCode(tx);
        if (resolvedCode == null || resolvedCode.isBlank()) {
            log.warn("[Payment] Transaction id={} unmatched: no transfer code found in its content ({} characters)",
                    tx.getProviderTransactionId(), tx.getContent() == null ? 0 : tx.getContent().length());
            tx.setProcessingStatus(PaymentTransactionStatus.UNMATCHED);
            tx.setErrorMessage("Transfer code could not be extracted from payment content");
            com.englishcoach.common.security.SecuritySignals.signal("PAYMENT_UNMATCHED", "NO_CODE");
            paymentTransactionRepository.save(tx);
            return;
        }

        Optional<PaymentOrder> orderOpt = paymentOrderRepository.findByTransferCode(resolvedCode.toUpperCase());
        if (orderOpt.isEmpty() && settleProductOrder(tx, resolvedCode.toUpperCase())) {
            return;
        }
        if (orderOpt.isEmpty()) {
            log.warn("[Payment] Transaction id={} unmatched: no order matches code '{}'",
                    tx.getProviderTransactionId(), resolvedCode);
            tx.setProcessingStatus(PaymentTransactionStatus.UNMATCHED);
            tx.setErrorMessage("No matching payment order for transfer code: " + resolvedCode);
            com.englishcoach.common.security.SecuritySignals.signal("PAYMENT_UNMATCHED", "NO_ORDER");
            paymentTransactionRepository.save(tx);
            return;
        }

        PaymentOrder order = orderOpt.get();
        // Two transfers that name the same order can arrive together. Take the order's row lock and read its state
        // again before deciding, so only the first of them can find the order unpaid.
        entityManager.refresh(order, jakarta.persistence.LockModeType.PESSIMISTIC_WRITE);
        tx.setMatchedPaymentOrder(order);

        // Step 5: Check order status
        if (order.getStatus() == PaymentOrderStatus.PAID) {
            log.info("[Payment] Order id={} is already PAID. Additional transfer id={} needs review.",
                    order.getId(), tx.getProviderTransactionId());
            tx.setProcessingStatus(PaymentTransactionStatus.UNMATCHED);
            tx.setErrorMessage("Order was already marked PAID");
            tx.setProcessedAt(Instant.now());
            paymentTransactionRepository.save(tx);
            return;
        }

        if (order.getStatus() == PaymentOrderStatus.CANCELLED) {
            log.warn("[Payment] Order id={} was CANCELLED. Preserving transaction id={} as UNMATCHED.",
                    order.getId(), tx.getProviderTransactionId());
            tx.setProcessingStatus(PaymentTransactionStatus.UNMATCHED);
            tx.setErrorMessage("Payment order was cancelled");
            com.englishcoach.common.security.SecuritySignals.signal("PAYMENT_UNMATCHED", "ORDER_CANCELLED");
            paymentTransactionRepository.save(tx);
            return;
        }

        Instant now = Instant.now();
        if (order.getStatus() == PaymentOrderStatus.EXPIRED || order.isExpired(now)) {
            log.warn("[Payment] Order id={} is EXPIRED (expired at {}). Transaction id={} marked UNMATCHED.",
                    order.getId(), order.getExpiresAt(), tx.getProviderTransactionId());
            order.setStatus(PaymentOrderStatus.EXPIRED);
            paymentOrderRepository.save(order);
            tx.setProcessingStatus(PaymentTransactionStatus.UNMATCHED);
            tx.setErrorMessage("Payment order expired before transaction received");
            com.englishcoach.common.security.SecuritySignals.signal("PAYMENT_UNMATCHED", "ORDER_EXPIRED");
            paymentTransactionRepository.save(tx);
            return;
        }

        // Step 6: Exact amount match
        if (!"VND".equals(order.getCurrency()) || !order.getProvider().equals(tx.getProvider())
                || !order.getAmountVnd().equals(tx.getTransferAmountVnd())) {
            log.warn("[Payment] Transaction id={} amount mismatch: expected {} VND, received {} VND",
                    tx.getProviderTransactionId(), order.getAmountVnd(), tx.getTransferAmountVnd());
            tx.setProcessingStatus(PaymentTransactionStatus.UNMATCHED);
            tx.setErrorMessage(String.format("Amount mismatch: expected %d VND but received %d VND",
                    order.getAmountVnd(), tx.getTransferAmountVnd()));
            com.englishcoach.common.security.SecuritySignals.signal("PAYMENT_UNMATCHED", "AMOUNT_MISMATCH");
            paymentTransactionRepository.save(tx);
            return;
        }

        // Step 7: Atomic match & Premium activation
        Long userId = order.getUser().getId();

        // PostgreSQL Transaction-Scoped Namespaced Advisory Lock on userId shared with PremiumSubscriptionService & PromoPremiumService
        entityManager.createNativeQuery("SELECT pg_advisory_xact_lock(hashtext(:lockKey))")
                .setParameter("lockKey", PremiumSubscriptionService.userSubscriptionLockKey(userId))
                .getResultList();

        // Mark order PAID
        order.setStatus(PaymentOrderStatus.PAID);
        order.setPaidAt(now);
        order.setProviderTransactionId(tx.getProviderTransactionId());
        paymentOrderRepository.save(order);

        // Mark transaction PROCESSED
        tx.setProcessingStatus(PaymentTransactionStatus.PROCESSED);
        tx.setProcessedAt(now);
        tx.setErrorMessage(null);
        paymentTransactionRepository.save(tx);

        // Extend/activate Premium subscription
        premiumSubscriptionService.extendOrActivateSubscription(
                userId, order.getPlan().getId(), "SEPAY:" + tx.getProviderTransactionId(), order.getDurationMonthsSnapshot()
        );

        // Create notification strictly AFTER_COMMIT so notification failures or duplicate keys
        // can NEVER poison the payment transaction (25P02) or affect the HTTP 200 SePay response.
        final Long notifyUserId = userId;
        final String notifyPlanName = order.getPlanNameSnapshot();
        final Long notifyOrderId = order.getId();
        Runnable dispatchNotification = () -> {
            if (premiumEntitlementService != null) {
                PremiumEntitlementService ent = premiumEntitlementService.getIfAvailable();
                if (ent != null) ent.invalidatePremiumCache(notifyUserId);
            }
            try {
                notificationService.createPaymentSuccessNotification(notifyUserId, notifyPlanName, notifyOrderId);
            } catch (Exception e) {
                log.error("[Payment] Post-commit notification failed for order={} ({})",
                        notifyOrderId, e.getClass().getSimpleName());
            }
        };
        if (TransactionSynchronizationManager.isActualTransactionActive()
                && TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    dispatchNotification.run();
                }
            });
        } else {
            dispatchNotification.run();
        }

        log.info("[Payment] SUCCESS: Activated Premium for user={} order={} plan={} amount={}",
                userId, order.getId(), order.getPlanCodeSnapshot(), order.getAmountVnd());
    }

    @Transactional
    public void reconcileReceived(Long id) {
        PaymentTransaction tx = entityManager.find(PaymentTransaction.class, id, jakarta.persistence.LockModeType.PESSIMISTIC_WRITE);
        if (tx != null && tx.getProcessingStatus() == PaymentTransactionStatus.RECEIVED) reconcileTransaction(tx);
    }

    /**
     * A transfer whose code names no Premium order may pay a one-time product (see {@link PaymentProductHandler}). It has
     * already passed every check above (inbound, positive, receiving account). The handler delivers exactly once or
     * records why it cannot; a transfer that was not delivered stays UNMATCHED for the administrator. Returns false when
     * no handler knows the code (the caller then records the usual "no matching order").
     */
    private boolean settleProductOrder(PaymentTransaction tx, String code) {
        if (productHandlers == null) return false;
        for (PaymentProductHandler handler : productHandlers) {
            if (!handler.ownsTransferCode(code)) continue;
            Instant now = Instant.now();
            PaymentProductHandler.Settlement result = handler.settle(new PaymentProductHandler.VerifiedTransfer(
                    tx.getProvider(), tx.getProviderTransactionId(), code, tx.getTransferAmountVnd(), now));
            tx.setProcessingStatus(result.delivered() ? PaymentTransactionStatus.PROCESSED : PaymentTransactionStatus.UNMATCHED);
            tx.setProcessedAt(result.delivered() ? now : null);
            tx.setErrorMessage(result.delivered() ? null : handler.productKind() + ": " + result.outcome());
            paymentTransactionRepository.save(tx);
            entityManager.flush();
            entityManager.createNativeQuery("""
                            INSERT INTO public.payment_product_match(transaction_id, product_kind, product_ref, outcome, detail)
                            VALUES (:tx, :kind, :ref, :outcome, :detail) ON CONFLICT (transaction_id) DO NOTHING
                            """)
                    .setParameter("tx", tx.getId()).setParameter("kind", handler.productKind())
                    .setParameter("ref", result.productRef() == null ? code : result.productRef())
                    .setParameter("outcome", result.outcome())
                    .setParameter("detail", result.detail() == null ? "" : result.detail())
                    .executeUpdate();
            log.info("[Payment] Product transfer id={} kind={} outcome={}", tx.getProviderTransactionId(), handler.productKind(), result.outcome());
            return true;
        }
        return false;
    }

    private String extractTransferCode(PaymentTransaction tx) {
        String prefix = (paymentProperties.getCodePrefix() != null && !paymentProperties.getCodePrefix().isBlank())
                ? paymentProperties.getCodePrefix().trim()
                : "EC";

        Pattern pattern = Pattern.compile("(?i)(?<![A-Z0-9])" + Pattern.quote(prefix) + "[A-Z0-9]{6,12}(?![A-Z0-9])");
        String code = tx.getPaymentCode();
        if (code != null && !code.isBlank() && !pattern.matcher(code).matches()) return null;
        Matcher matcher = pattern.matcher(tx.getContent() == null ? "" : tx.getContent());
        while (matcher.find()) {
            String candidate = matcher.group();
            if (code != null && !code.isBlank() && !candidate.equalsIgnoreCase(code)) return null;
            code = candidate;
        }
        return code;
    }
}
