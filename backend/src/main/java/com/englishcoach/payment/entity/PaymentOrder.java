package com.englishcoach.payment.entity;

import com.englishcoach.auth.entity.User;
import com.englishcoach.premium.entity.PremiumPlan;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "payment_orders", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PaymentOrder {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "plan_id", nullable = false)
    private PremiumPlan plan;

    @Column(name = "plan_code_snapshot", nullable = false, length = 64)
    private String planCodeSnapshot;

    @Column(name = "plan_name_snapshot", nullable = false, length = 128)
    private String planNameSnapshot;

    @Column(name = "duration_months_snapshot", nullable = false)
    private Integer durationMonthsSnapshot;

    @Column(name = "amount_vnd", nullable = false)
    private Long amountVnd;

    @Builder.Default
    @Column(name = "currency", nullable = false, length = 16)
    private String currency = "VND";

    @Column(name = "transfer_code", nullable = false, unique = true, length = 64)
    private String transferCode;

    @Enumerated(EnumType.STRING)
    @Builder.Default
    @Column(name = "status", nullable = false, length = 32)
    private PaymentOrderStatus status = PaymentOrderStatus.PENDING;

    @Builder.Default
    @Column(name = "provider", nullable = false, length = 32)
    private String provider = "SEPAY";

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "paid_at")
    private Instant paidAt;

    @Column(name = "provider_transaction_id", length = 128)
    private String providerTransactionId;

    @Builder.Default
    @Column(name = "pricing_version", nullable = false, updatable = false)
    private int pricingVersion = 1;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public boolean isExpired(Instant now) {
        return expiresAt != null && !expiresAt.isAfter(now);
    }
}
