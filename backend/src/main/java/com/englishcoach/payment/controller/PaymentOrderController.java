package com.englishcoach.payment.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.payment.dto.CreatePaymentOrderRequest;
import com.englishcoach.payment.dto.PaymentOrderResponse;
import com.englishcoach.payment.service.PaymentOrderService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@Slf4j
@RestController
@RequestMapping("/api/v1/payments/orders")
@RequiredArgsConstructor
public class PaymentOrderController {

    private final PaymentOrderService paymentOrderService;

    /**
     * POST /api/v1/payments/orders
     * Creates a new payment order for the current authenticated user.
     * Price, duration, and transfer code authority remains strictly on the server.
     */
    @PostMapping
    public ResponseEntity<PaymentOrderResponse> createPaymentOrder(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody CreatePaymentOrderRequest request
    ) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required to create payment order");
        }

        PaymentOrderResponse response = paymentOrderService.createPaymentOrder(userDetails.getId(), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    /**
     * GET /api/v1/payments/orders/{orderId}
     * Retrieves status and details of an order owned by the current authenticated user.
     */
    @GetMapping("/{orderId}")
    public ResponseEntity<PaymentOrderResponse> getPaymentOrder(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long orderId
    ) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required to view payment order");
        }

        PaymentOrderResponse response = paymentOrderService.getPaymentOrder(userDetails.getId(), orderId);
        return ResponseEntity.ok(response);
    }
}
