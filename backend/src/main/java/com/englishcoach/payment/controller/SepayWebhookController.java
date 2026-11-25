package com.englishcoach.payment.controller;

import com.englishcoach.payment.dto.SepayWebhookPayload;
import com.englishcoach.payment.entity.PaymentTransaction;
import com.englishcoach.payment.entity.PaymentTransactionStatus;
import com.englishcoach.payment.service.PaymentReconciliationService;
import com.englishcoach.payment.service.SepayWebhookVerifier;
import com.englishcoach.payment.worker.PaymentWebhookWorker;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;
import java.nio.charset.StandardCharsets;
import com.fasterxml.jackson.databind.DeserializationFeature;

@Slf4j
@RestController
@RequestMapping("/api/v1/payments/webhooks")
@RequiredArgsConstructor
public class SepayWebhookController {

    private final SepayWebhookVerifier sepayWebhookVerifier;
    private final PaymentReconciliationService paymentReconciliationService;
    private final ObjectMapper objectMapper;

    @Autowired(required = false)
    private PaymentWebhookWorker paymentWebhookWorker;

    /**
     * POST /api/v1/payments/webhooks/sepay
     * Public callback endpoint protected strictly by SePay HMAC-SHA256 signature verification.
     * Uses raw HTTP request body for cryptographically sound verification.
     */
    @PostMapping("/sepay")
    public ResponseEntity<Map<String, Object>> handleSepayWebhook(
            @RequestBody byte[] rawBody,
            @RequestHeader(value = "X-SePay-Signature", required = false) String signatureHeader,
            @RequestHeader(value = "X-SePay-Timestamp", required = false) String timestampHeader
    ) {
        log.info("[SePay Webhook] Inbound callback received. Length: {} bytes", rawBody != null ? rawBody.length : 0);

        // 1. Verify HMAC-SHA256 signature using raw unmodified request body
        boolean isValid = sepayWebhookVerifier.verifySignature(rawBody, signatureHeader, timestampHeader);
        if (!isValid) {
            log.warn("[SePay Webhook] Authentication failed: invalid or missing HMAC signature");
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of(
                    "success", false,
                    "message", "Invalid or missing webhook signature"
            ));
        }

        // 2. Parse payload safely
        SepayWebhookPayload payload;
        try {
            payload = objectMapper.readerFor(SepayWebhookPayload.class)
                    .without(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
                    .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .with(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                    .readValue(rawBody);
        } catch (Exception e) {
            log.warn("[SePay Webhook] Malformed payment notification");
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of(
                    "success", false,
                    "message", "Malformed JSON payload"
            ));
        }

        if (payload == null || payload.getId() == null || !payload.getId().matches("[1-9][0-9]{0,18}")) {
            log.warn("[SePay Webhook] Missing transaction ID in payload");
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(Map.of(
                    "success", false,
                    "message", "Transaction ID is required"
            ));
        }

        // 3. Ingest, deduplicate, and process
        try {
            PaymentTransaction tx = paymentReconciliationService.processWebhook(payload, new String(rawBody, StandardCharsets.UTF_8));
            log.info("[SePay Webhook] Handled transaction id={} with status={}",
                    payload.getId(), tx.getProcessingStatus());
            if (paymentWebhookWorker != null && tx.getProcessingStatus() == PaymentTransactionStatus.RECEIVED) {
                paymentWebhookWorker.wakePoller();
            }

            return ResponseEntity.ok(Map.of(
                    "success", true,
                    "message", "Webhook acknowledged",
                    "transactionId", payload.getId()
            ));
        } catch (org.springframework.dao.DataIntegrityViolationException duplicate) {
            // Two copies of one delivery at the same moment: the unique index on the provider's transaction id let
            // exactly one in, and this copy lost. Its insert waited for the other transaction to END, so the row
            // is either committed (the transfer is recorded and was processed once: acknowledge) or absent (the
            // other copy failed: answer an error so the provider delivers again).
            if (paymentReconciliationService.isRecorded(payload.getId())) {
                log.info("[SePay Webhook] Simultaneous duplicate of transaction id={} acknowledged", payload.getId());
                return ResponseEntity.ok(Map.of(
                        "success", true,
                        "message", "Webhook acknowledged",
                        "transactionId", payload.getId()
                ));
            }
            log.error("[SePay Webhook] Constraint violation without a recorded transaction for id={}", payload.getId());
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                    "success", false,
                    "message", "Internal processing error"
            ));
        } catch (Exception e) {
            log.error("[SePay Webhook] Processing failed ({})", e.getClass().getSimpleName());
            // Return 200 with error details or 500 depending on provider retry policy. SePay treats 200 as success.
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                    "success", false,
                    "message", "Internal processing error"
            ));
        }
    }
}
