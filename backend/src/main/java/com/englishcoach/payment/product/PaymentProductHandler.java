package com.englishcoach.payment.product;

import java.time.Instant;

/**
 * A one-time product sold through the existing SePay bank-transfer path that is NOT a Premium plan.
 *
 * <p>{@code payment_orders} stays Premium-only (its plan is mandatory and its reconciliation activates Premium). A
 * product module keeps its own order and registers a handler: the payment module still owns everything that makes a
 * transfer trustworthy — the webhook signature, the transaction inbox with its replay guard, the inbound / positive
 * amount / receiving-account checks and the transfer-code extraction — and only then asks the handler whose order the
 * transfer code names. A handler is therefore never called for an unverified, outbound, foreign-account or replayed
 * transfer, and it runs inside the reconciliation transaction.</p>
 */
public interface PaymentProductHandler {

    /** Short stable name stored with the match (for example {@code GARDEN_COSMETIC}). */
    String productKind();

    /** Whether this transfer code names one of the handler's orders, whatever its state. */
    boolean ownsTransferCode(String transferCode);

    /**
     * Delivers the order the code names, exactly once, or records why it cannot be delivered. Must be idempotent for a
     * given provider transaction and must never grant anything when the amount, the state or the ownership is wrong.
     */
    Settlement settle(VerifiedTransfer transfer);

    /** A transfer the payment module has verified: inbound, positive, to the configured receiving account. */
    record VerifiedTransfer(String provider, String providerTransactionId, String transferCode, long amountVnd, Instant receivedAt) {}

    /**
     * {@code delivered}: the product was granted by this transaction (or had already been granted by it);
     * {@code outcome}: a short code for the audit row; {@code detail}: free text for the administrator.
     */
    record Settlement(boolean delivered, String productRef, String outcome, String detail) {}
}
