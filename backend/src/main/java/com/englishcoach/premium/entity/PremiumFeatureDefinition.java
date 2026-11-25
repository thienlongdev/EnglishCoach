package com.englishcoach.premium.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "premium_feature_definitions", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PremiumFeatureDefinition {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "feature_key", nullable = false, unique = true, length = 64)
    private String featureKey;

    @Column(name = "display_name", nullable = false, length = 128)
    private String displayName;

    @Column(name = "description", nullable = false, length = 512)
    private String description;

    @Builder.Default
    @Column(name = "premium_required", nullable = false)
    private boolean premiumRequired = true;

    @Builder.Default
    @Column(name = "free_trial_limit", nullable = false)
    private Integer freeTrialLimit = 5;

    @Builder.Default
    @Column(name = "premium_monthly_limit", nullable = false)
    private Integer premiumMonthlyLimit = 300;

    @Builder.Default
    @Column(name = "enabled", nullable = false)
    private boolean enabled = true;

    @Builder.Default
    @Column(name = "sort_order", nullable = false)
    private Integer sortOrder = 0;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
