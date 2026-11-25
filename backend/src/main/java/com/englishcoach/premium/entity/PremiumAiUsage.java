package com.englishcoach.premium.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(
    name = "premium_ai_usage",
    schema = "public",
    uniqueConstraints = {
        @UniqueConstraint(name = "uq_premium_usage_user_feature_request", columnNames = {"user_id", "feature_key", "request_id"})
    }
)
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PremiumAiUsage {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "feature_key", nullable = false, length = 64)
    private String featureKey;

    @Column(name = "usage_kind", nullable = false, length = 32)
    private String usageKind; // TRIAL or PREMIUM

    @Column(name = "request_id", nullable = false, length = 128)
    private String requestId;

    @Column(name = "status", nullable = false, length = 32)
    private String status; // RESERVED, COMPLETED, RELEASED

    @Column(name = "billing_cycle_month", nullable = false, length = 7)
    private String billingCycleMonth; // YYYY-MM

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "completed_at")
    private Instant completedAt;
}
