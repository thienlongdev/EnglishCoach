package com.englishcoach.payment.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PaymentOrderResponse {

    private Long orderId;
    private String status;
    private String planCode;
    private String planName;
    private Integer durationMonths;
    private Long amountVnd;
    private String currency;
    private String transferCode;
    private String bankCode;
    private String accountNumber;
    private String accountName;
    private Instant expiresAt;
    private String qrImageUrl;
    private Instant createdAt;
    private Instant paidAt;
    private Instant premiumExpiresAt;
}
