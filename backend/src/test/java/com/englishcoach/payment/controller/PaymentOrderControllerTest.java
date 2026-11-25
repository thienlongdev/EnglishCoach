package com.englishcoach.payment.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.payment.dto.CreatePaymentOrderRequest;
import com.englishcoach.payment.dto.PaymentOrderResponse;
import com.englishcoach.payment.service.PaymentOrderService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.Collections;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class PaymentOrderControllerTest {

    @Mock
    private PaymentOrderService paymentOrderService;

    @InjectMocks
    private PaymentOrderController controller;

    private UserDetailsImpl userDetails;

    @BeforeEach
    void setUp() {
        userDetails = new UserDetailsImpl(
                100L,
                "learner@example.com",
                "hash",
                Collections.emptyList()
        );
    }

    @Test
    @DisplayName("Create order: Unauthorized if userDetails is null")
    void createOrder_Unauthorized_WhenNullUser() {
        CreatePaymentOrderRequest request = new CreatePaymentOrderRequest("PREMIUM_3_MONTHS");
        assertThatThrownBy(() -> controller.createPaymentOrder(null, request))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Authentication required");
    }

    @Test
    @DisplayName("Create order: Returns 201 CREATED with server payment order")
    void createOrder_Success_Returns201() {
        CreatePaymentOrderRequest request = new CreatePaymentOrderRequest("PREMIUM_3_MONTHS");
        PaymentOrderResponse mockResponse = PaymentOrderResponse.builder()
                .orderId(501L)
                .amountVnd(159000L)
                .status("PENDING")
                .transferCode("EC8F3K91Q2")
                .expiresAt(Instant.now().plusSeconds(1200))
                .build();

        when(paymentOrderService.createPaymentOrder(eq(100L), eq(request)))
                .thenReturn(mockResponse);

        ResponseEntity<PaymentOrderResponse> response = controller.createPaymentOrder(userDetails, request);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().getOrderId()).isEqualTo(501L);
        assertThat(response.getBody().getAmountVnd()).isEqualTo(159000L);
    }

    @Test
    @DisplayName("Get order: Returns 200 OK with order details")
    void getOrder_Success_Returns200() {
        PaymentOrderResponse mockResponse = PaymentOrderResponse.builder()
                .orderId(501L)
                .amountVnd(159000L)
                .status("PAID")
                .transferCode("EC8F3K91Q2")
                .build();

        when(paymentOrderService.getPaymentOrder(eq(100L), eq(501L)))
                .thenReturn(mockResponse);

        ResponseEntity<PaymentOrderResponse> response = controller.getPaymentOrder(userDetails, 501L);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody()).isNotNull();
        assertThat(response.getBody().getStatus()).isEqualTo("PAID");
    }
}
