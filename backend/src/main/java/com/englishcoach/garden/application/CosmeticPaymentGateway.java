package com.englishcoach.garden.application;

/**
 * The boundary between the garden and the payment provider for cosmetics bought with VND.
 *
 * <p>The production implementation is {@link SepayCosmeticGateway}: it reuses English Coach's existing SePay
 * bank-transfer integration (the Premium checkout's merchant account, VietQR service and transfer-code shape) without
 * touching {@code payment_orders}, which stays Premium-only. The garden keeps its own order
 * ({@code garden_cosmetic_order} + {@code garden_cosmetic_payment}); the payment module verifies the webhook, the
 * receiving account and the transaction, and only then hands the transfer to {@link CosmeticPaymentHandler}, which
 * calls {@link CosmeticCheckoutService#settle}. Scanning a QR, a browser redirect or a client claim never grants
 * anything.</p>
 */
public interface CosmeticPaymentGateway {

    /** What the buyer needs to pay an order: the configured receiving account and the QR of exactly this transfer. */
    record Instructions(String bankCode, String accountNumber, String accountName, String qrImageUrl) {}

    /** Short provider code stored on the order (for example {@code SEPAY}). */
    String provider();

    /** Registers a payment for an order and returns its unique reference — the bank-transfer content. */
    String createPayment(long userId, String skuCode, long amountVnd);

    /**
     * Whether real payments can be taken AND verified now (merchant account and webhook authentication configured).
     * Checkout stays closed while this is false, whatever the switch says.
     */
    default boolean available() {
        return true;
    }

    /** Payment instructions of an order ({@code null} when the provider has none to show). */
    default Instructions instructions(String reference, long amountVnd) {
        return null;
    }
}
