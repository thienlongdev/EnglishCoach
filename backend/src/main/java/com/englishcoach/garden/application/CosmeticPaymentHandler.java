package com.englishcoach.garden.application;

import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.payment.product.PaymentProductHandler;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * The garden's side of the payment module's product-order path: a SePay transfer the payment module has verified
 * (signature, inbox replay guard, inbound, positive, receiving account) and whose code names a cosmetic order arrives
 * here and is settled by {@link CosmeticCheckoutService#settle} inside the reconciliation transaction.
 */
@Slf4j
@Component
public class CosmeticPaymentHandler implements PaymentProductHandler {

    private final CosmeticCheckoutService checkout;

    @Autowired(required = false)
    private NotificationService notifications;

    public CosmeticPaymentHandler(CosmeticCheckoutService checkout) {
        this.checkout = checkout;
    }

    @Override
    public String productKind() {
        return "GARDEN_COSMETIC";
    }

    @Override
    public boolean ownsTransferCode(String transferCode) {
        return checkout.ownsTransferCode(transferCode);
    }

    @Override
    public Settlement settle(VerifiedTransfer transfer) {
        CosmeticCheckoutService.Settled result = checkout.settle(transfer.provider(), transfer.providerTransactionId(),
                transfer.transferCode(), transfer.amountVnd());
        if (result.deliveredNow() && notifications != null) {
            try {
                notifications.create(new CreateNotificationCommand(result.userId(), NotificationCategory.MILESTONE, NotificationType.SYSTEM_UPDATE,
                        "Đã nhận Skin Echo Garden", "Thanh toán thành công: " + result.productName() + " đã có trong Tiệm Trang Trí của bạn.",
                        "/games/echo-garden", "garden_cosmetic_order_" + result.orderId()));
            } catch (Exception e) {
                log.warn("[Garden] delivery notification failed for order {}: {}", result.orderId(), e.getMessage());
            }
        }
        return new Settlement(result.delivered(), "order:" + result.orderId(), result.outcome(), result.detail());
    }
}
