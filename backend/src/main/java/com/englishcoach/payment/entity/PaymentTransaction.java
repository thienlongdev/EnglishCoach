package com.englishcoach.payment.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "payment_transactions", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PaymentTransaction {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Builder.Default
    @Column(name = "provider", nullable = false, length = 32)
    private String provider = "SEPAY";

    @Column(name = "provider_transaction_id", nullable = false, unique = true, length = 128)
    private String providerTransactionId;

    @Column(name = "gateway", length = 64)
    private String gateway;

    @Column(name = "transaction_date")
    private Instant transactionDate;

    @Column(name = "account_number", nullable = false, length = 64)
    private String accountNumber;

    @Column(name = "sub_account", length = 64)
    private String subAccount;

    @Column(name = "payment_code", length = 64)
    private String paymentCode;

    @Column(name = "content", length = 512)
    private String content;

    @Column(name = "transfer_type", nullable = false, length = 32)
    private String transferType;

    @Column(name = "transfer_amount_vnd", nullable = false)
    private Long transferAmountVnd;

    @Column(name = "reference_code", length = 128)
    private String referenceCode;

    @Column(name = "raw_payload", columnDefinition = "TEXT")
    private String rawPayload;

    @Enumerated(EnumType.STRING)
    @Builder.Default
    @Column(name = "processing_status", nullable = false, length = 32)
    private PaymentTransactionStatus processingStatus = PaymentTransactionStatus.RECEIVED;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "matched_payment_order_id")
    private PaymentOrder matchedPaymentOrder;

    @CreationTimestamp
    @Column(name = "received_at", nullable = false, updatable = false)
    private Instant receivedAt;

    @Column(name = "processed_at")
    private Instant processedAt;

    @Column(name = "error_message", length = 512)
    private String errorMessage;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
