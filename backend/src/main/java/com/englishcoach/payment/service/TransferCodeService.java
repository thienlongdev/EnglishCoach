package com.englishcoach.payment.service;

import com.englishcoach.payment.config.PaymentProperties;
import com.englishcoach.payment.product.PaymentProductHandler;
import com.englishcoach.payment.repository.PaymentOrderRepository;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;

/**
 * Bank-transfer references for product orders (see {@link PaymentProductHandler}). Same shape as a Premium order's
 * transfer code — configured prefix + 8 characters of the unambiguous alphabet — so SePay recognises it with the
 * merchant's existing payment-code rule, and unique across Premium orders AND every product handler's orders.
 */
@Service
public class TransferCodeService {

    private static final String CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final PaymentOrderRepository orders;
    private final PaymentProperties properties;
    private final ObjectProvider<PaymentProductHandler> handlers;

    public TransferCodeService(PaymentOrderRepository orders, PaymentProperties properties, ObjectProvider<PaymentProductHandler> handlers) {
        this.orders = orders;
        this.properties = properties;
        this.handlers = handlers;
    }

    public String prefix() {
        String p = properties.getCodePrefix();
        return p != null && !p.isBlank() ? p.trim().toUpperCase() : "EC";
    }

    /** Whether any order of any kind already uses this code. */
    public boolean taken(String code) {
        if (orders.existsByTransferCode(code)) return true;
        return handlers.stream().anyMatch(h -> h.ownsTransferCode(code));
    }

    public String newCode() {
        String prefix = prefix();
        for (int attempt = 0; attempt < 10; attempt++) {
            StringBuilder sb = new StringBuilder(prefix);
            for (int i = 0; i < 8; i++) sb.append(CODE_CHARS.charAt(RANDOM.nextInt(CODE_CHARS.length())));
            String candidate = sb.toString();
            if (!taken(candidate)) return candidate;
        }
        throw new IllegalStateException("Failed to generate unique transfer code after multiple attempts");
    }
}
