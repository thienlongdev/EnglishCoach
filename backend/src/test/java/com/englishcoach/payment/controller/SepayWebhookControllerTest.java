package com.englishcoach.payment.controller;

import com.englishcoach.payment.dto.SepayWebhookPayload;
import com.englishcoach.payment.entity.PaymentTransaction;
import com.englishcoach.payment.entity.PaymentTransactionStatus;
import com.englishcoach.payment.service.PaymentReconciliationService;
import com.englishcoach.payment.service.SepayWebhookVerifier;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SepayWebhookControllerTest {

    @Mock
    private SepayWebhookVerifier verifier;

    @Mock
    private PaymentReconciliationService reconciliationService;

    @Spy
    private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks
    private SepayWebhookController controller;

    private static final String VALID_BODY = "{\"id\":\"12345\",\"transfer_amount\":159000,\"content\":\"EC8F3K91Q2\",\"transfer_type\":\"in\",\"account_number\":\"0987654321\"}";

    @Test
    @DisplayName("Webhook: Invalid signature returns 401 UNAUTHORIZED")
    void handleWebhook_InvalidSignature_Returns401() {
        when(verifier.verifySignature(any(), any(), any())).thenReturn(false);

        ResponseEntity<Map<String, Object>> response = controller.handleSepayWebhook(
                VALID_BODY.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=invalidsig", "1727361600"
        );

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(response.getBody()).containsEntry("success", false);
        verify(reconciliationService, never()).processWebhook(any(), any());
    }

    @Test
    @DisplayName("Webhook: Malformed JSON returns 400 BAD_REQUEST")
    void handleWebhook_MalformedJson_Returns400() {
        when(verifier.verifySignature(any(), any(), any())).thenReturn(true);

        ResponseEntity<Map<String, Object>> response = controller.handleSepayWebhook(
                "invalid-json-body".getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=validsig", "1727361600"
        );

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).containsEntry("success", false);
    }

    @Test
    @DisplayName("Webhook: Missing transaction ID returns 400 BAD_REQUEST")
    void handleWebhook_MissingTransactionId_Returns400() {
        when(verifier.verifySignature(any(), any(), any())).thenReturn(true);

        String bodyWithoutId = "{\"transfer_amount\":159000,\"content\":\"EC8F3K91Q2\"}";
        ResponseEntity<Map<String, Object>> response = controller.handleSepayWebhook(
                bodyWithoutId.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=validsig", "1727361600"
        );

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).containsEntry("success", false);
    }

    @Test
    @DisplayName("Webhook: Valid signed payload returns 200 OK and acknowledges transaction")
    void handleWebhook_ValidSignature_AcknowledgesSuccessfully() {
        when(verifier.verifySignature(any(), any(), any())).thenReturn(true);

        PaymentTransaction tx = PaymentTransaction.builder()
                .id(1L)
                .providerTransactionId("12345")
                .processingStatus(PaymentTransactionStatus.PROCESSED)
                .build();
        when(reconciliationService.processWebhook(any(SepayWebhookPayload.class), eq(VALID_BODY)))
                .thenReturn(tx);

        ResponseEntity<Map<String, Object>> response = controller.handleSepayWebhook(
                VALID_BODY.getBytes(java.nio.charset.StandardCharsets.UTF_8), "sha256=validsig", "1727361600"
        );

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).containsEntry("success", true);
        assertThat(response.getBody()).containsEntry("transactionId", "12345");
        verify(reconciliationService).processWebhook(any(), eq(VALID_BODY));
    }
}
