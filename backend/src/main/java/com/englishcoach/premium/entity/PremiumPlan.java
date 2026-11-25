package com.englishcoach.premium.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "premium_plans", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PremiumPlan {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "code", nullable = false, unique = true, length = 64)
    private String code;

    @Column(name = "name", nullable = false, length = 128)
    private String name;

    @Column(name = "duration_months", nullable = false)
    private Integer durationMonths;

    @Column(name = "price_vnd", nullable = false)
    private Long priceVnd;

    @Builder.Default
    @Column(name = "display_order", nullable = false)
    private Integer displayOrder = 0;

    @Column(name = "badge", length = 64)
    private String badge;

    @Builder.Default
    @Column(name = "active", nullable = false)
    private boolean active = true;

    @Builder.Default
    @Column(name = "pricing_version", nullable = false, updatable = false)
    private int pricingVersion = 1;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
