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
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;
import com.englishcoach.payment.product.PaymentProductHandler;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentOrderService {

    private static final String CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final PaymentOrderRepository paymentOrderRepository;
    private final PremiumPlanRepository premiumPlanRepository;
    private final UserRepository userRepository;
    private final PaymentProperties paymentProperties;
    private final VietQrService vietQrService;
    private final PremiumSubscriptionService premiumSubscriptionService;

    /** Product orders sold through the same transfer path (none in slim unit tests). */
    @Autowired(required = false)
    @Lazy
    private List<PaymentProductHandler> productHandlers;

    @Transactional
    public PaymentOrderResponse createPaymentOrder(Long userId, CreatePaymentOrderRequest request) {
        User user = userRepository.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));

        if (request.getPlanCode() == null || request.getPlanCode().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Plan code is required");
        }

        PremiumPlan plan = premiumPlanRepository.findByCode(request.getPlanCode().trim())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Plan not found: " + request.getPlanCode()));

        if (!plan.isActive()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Plan is currently not available for purchase");
        }

        if (!paymentProperties.isConfiguredForProduction()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Payment configuration unavailable");
        }
        Instant now = Instant.now();

        // Idempotency check: Reuse active pending order for same user & plan if at least 5 minutes remaining
        List<PaymentOrder> activeOrders = paymentOrderRepository.findActivePendingOrders(
                userId, plan.getCode(), PaymentOrderStatus.PENDING, now.plus(Duration.ofMinutes(5))
        );
        for (PaymentOrder existingOrder : activeOrders) {
            if (existingOrder.getPricingVersion() != plan.getPricingVersion()) continue;
            log.info("Reusing active pending payment order {} for user {}", existingOrder.getId(), userId);
            return toResponse(existingOrder, null);
        }

        String transferCode = generateUniqueTransferCode();
        int ttlMinutes = Math.max(paymentProperties.getOrderTtlMinutes(), 5);
        Instant expiresAt = now.plus(Duration.ofMinutes(ttlMinutes));

        PaymentOrder order = PaymentOrder.builder()
                .user(user)
                .plan(plan)
                .planCodeSnapshot(plan.getCode())
                .planNameSnapshot(plan.getName())
                .durationMonthsSnapshot(plan.getDurationMonths())
                .amountVnd(plan.getPriceVnd())
                .pricingVersion(plan.getPricingVersion())
                .currency("VND")
                .transferCode(transferCode)
                .status(PaymentOrderStatus.PENDING)
                .provider(paymentProperties.getProvider())
                .expiresAt(expiresAt)
                .build();

        PaymentOrder saved = paymentOrderRepository.save(order);
        log.info("Created Premium payment order id={}", saved.getId());

        return toResponse(saved, null);
    }

    @Transactional(readOnly = true)
    public PaymentOrderResponse getPaymentOrder(Long userId, Long orderId) {
        PaymentOrder order = paymentOrderRepository.findByIdAndUserId(orderId, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Payment order not found"));

        Instant premiumExpiresAt = null;
        if (order.getStatus() == PaymentOrderStatus.PAID) {
            premiumExpiresAt = premiumSubscriptionService.getCoverageEnd(userId).orElse(null);
        }

        return toResponse(order, premiumExpiresAt);
    }

    /** A Premium order never reuses the reference of a product order (same code shape, see TransferCodeService). */
    private boolean usedByProductOrder(String candidate) {
        if (productHandlers == null) return false;
        for (PaymentProductHandler handler : productHandlers) {
            if (handler.ownsTransferCode(candidate)) return true;
        }
        return false;
    }

    private String generateUniqueTransferCode() {
        String prefix = (paymentProperties.getCodePrefix() != null && !paymentProperties.getCodePrefix().isBlank())
                ? paymentProperties.getCodePrefix().trim().toUpperCase()
                : "EC";

        for (int attempt = 0; attempt < 10; attempt++) {
            StringBuilder sb = new StringBuilder(prefix);
            for (int i = 0; i < 8; i++) {
                int idx = RANDOM.nextInt(CODE_CHARS.length());
                sb.append(CODE_CHARS.charAt(idx));
            }
            String candidate = sb.toString();
            if (!paymentOrderRepository.existsByTransferCode(candidate) && !usedByProductOrder(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("Failed to generate unique transfer code after multiple attempts");
    }

    public PaymentOrderResponse toResponse(PaymentOrder order, Instant premiumExpiresAt) {
        String bankCode = paymentProperties.getBank().getBankCode();
        String accountNumber = paymentProperties.getBank().getAccountNumber();
        String accountName = paymentProperties.getBank().getAccountName();

        String qrImageUrl = vietQrService.generateQrImageUrl(
                bankCode, accountNumber, order.getAmountVnd(), order.getTransferCode()
        );

        return PaymentOrderResponse.builder()
                .orderId(order.getId())
                .status(order.getStatus() == PaymentOrderStatus.PENDING && order.isExpired(Instant.now())
                        ? PaymentOrderStatus.EXPIRED.name() : order.getStatus().name())
                .planCode(order.getPlanCodeSnapshot())
                .planName(order.getPlanNameSnapshot())
                .durationMonths(order.getDurationMonthsSnapshot())
                .amountVnd(order.getAmountVnd())
                .currency(order.getCurrency())
                .transferCode(order.getTransferCode())
                .bankCode(bankCode)
                .accountNumber(accountNumber)
                .accountName(accountName)
                .expiresAt(order.getExpiresAt())
                .qrImageUrl(qrImageUrl)
                .createdAt(order.getCreatedAt())
                .paidAt(order.getPaidAt())
                .premiumExpiresAt(premiumExpiresAt)
                .build();
    }
}
