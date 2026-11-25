package com.englishcoach.payment.service;

import com.englishcoach.payment.config.PaymentProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

@Slf4j
@Service
public class SepayWebhookVerifier {

    private static final int MAX_FUTURE_SKEW_MINUTES = 5;

    private final PaymentProperties paymentProperties;
    private final boolean allowLegacyTimestampLess;

    @Autowired
    public SepayWebhookVerifier(
            PaymentProperties paymentProperties,
            @Value("${app.payment.sepay.allow-legacy-timestamp-less:false}") boolean allowLegacyTimestampLess
    ) {
        this.paymentProperties = paymentProperties;
        this.allowLegacyTimestampLess = allowLegacyTimestampLess;
    }

    /** Backwards-compatible constructor for legacy unit tests covering timestamp-less HMAC behavior. */
    public SepayWebhookVerifier(PaymentProperties paymentProperties) {
        this(paymentProperties, true);
    }

    // Current SePay HMAC signs Unix seconds (±5 min). Millisecond signatures enforce max age and <= 5 min future skew.
    // Timestamp-less legacy deliveries are rejected by default in Spring/prod unless explicitly enabled.
    boolean freshEnough(String timestampHeader) {
        if (timestampHeader == null || timestampHeader.isBlank()) {
            if (!allowLegacyTimestampLess) {
                log.warn("[SePay Webhook] Rejection: missing X-SePay-Timestamp header (legacy timestamp-less mode disabled)");
                return false;
            }
            return true;
        }
        String t = timestampHeader.trim();
        if (!t.matches("\\d{10}|\\d{13}")) return false;
        long epochMs = t.length() == 10 ? Long.parseLong(t) * 1000L : Long.parseLong(t);
        long now = System.currentTimeMillis();
        if (t.length() == 10) return Math.abs(now / 1000 - Long.parseLong(t)) <= 300;
        PaymentProperties.SepayConfig cfg = paymentProperties.getSepay();
        long futureSkewMs = Math.min(MAX_FUTURE_SKEW_MINUTES, Math.max(0, cfg.getWebhookFutureSkewMinutes())) * 60_000L;
        if (epochMs > now + futureSkewMs) {
            log.warn("[SePay Webhook] Rejection: signed timestamp lies in the future beyond the allowed clock skew");
            return false;
        }
        int maxAgeHours = cfg.getWebhookMaxAgeHours();
        if (maxAgeHours > 0 && now - epochMs > maxAgeHours * 3_600_000L) {
            log.warn("[SePay Webhook] Rejection: signed timestamp older than {} hours (replay window)", maxAgeHours);
            return false;
        }
        return true;
    }

    /**
     * Verifies HMAC-SHA256 signature using the raw unmodified HTTP request body.
     * 
     * Signature format: sha256=<hex> or raw hex
     * Payload signed: timestamp + "." + rawBody
     */
    public boolean verifySignature(byte[] rawBody, String signatureHeader, String timestampHeader) {
        String rawSecret = paymentProperties.getSepay().getWebhookSecret();
        String secret = rawSecret != null ? rawSecret.trim() : "";

        // Safety check for unconfigured environments
        if (secret.isBlank()) {
            log.error("[SePay Webhook] Rejection: SEPAY_WEBHOOK_SECRET is not configured in production");
            return false;
        }

        if (signatureHeader == null || signatureHeader.isBlank()) {
            log.warn("[SePay Webhook] Missing X-SePay-Signature header");
            return false;
        }

        if (timestampHeader == null && !allowLegacyTimestampLess) {
            log.warn("[SePay Webhook] Rejection: missing X-SePay-Timestamp header (legacy timestamp-less mode disabled)");
            return false;
        }

        try {
            String expectedHash = signatureHeader.trim();
            if (expectedHash.regionMatches(true, 0, "sha256=", 0, 7)) {
                expectedHash = expectedHash.substring(7).trim();
            }

            Mac mac = Mac.getInstance("HmacSHA256");
            SecretKeySpec secretKey = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            mac.init(secretKey);
            if (timestampHeader != null) {
                if (timestampHeader.isBlank() || !timestampHeader.equals(timestampHeader.trim())) return false;
                mac.update((timestampHeader + ".").getBytes(StandardCharsets.US_ASCII));
            }
            byte[] hmacBytes = mac.doFinal(rawBody);

            StringBuilder hexString = new StringBuilder();
            for (byte b : hmacBytes) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) {
                    hexString.append('0');
                }
                hexString.append(hex);
            }
            String calculatedHash = hexString.toString();

            boolean matches = MessageDigest.isEqual(
                    calculatedHash.getBytes(StandardCharsets.UTF_8),
                    expectedHash.toLowerCase().getBytes(StandardCharsets.UTF_8)
            );

            if (!matches) {
                log.warn("[SePay Webhook] Signature mismatch. Calculated length: {}, Expected length: {}",
                        calculatedHash.length(), expectedHash.length());
                return false;
            }

            return freshEnough(timestampHeader);
        } catch (Exception e) {
            log.error("[SePay Webhook] Verification error: {}", e.getMessage());
            return false;
        }
    }
}
