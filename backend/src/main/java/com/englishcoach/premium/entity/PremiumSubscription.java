package com.englishcoach.premium.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "premium_subscriptions", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PremiumSubscription {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @ManyToOne(fetch = FetchType.EAGER, optional = false)
    @JoinColumn(name = "plan_id", nullable = false)
    private PremiumPlan plan;

    @Column(name = "starts_at", nullable = false)
    private Instant startsAt;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Builder.Default
    @Column(name = "status", nullable = false, length = 32)
    private String status = "ACTIVE"; // ACTIVE, EXPIRED, CANCELLED

    @Builder.Default
    @Column(name = "source", nullable = false, length = 64)
    private String source = "SYSTEM";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    public boolean isActiveAt(Instant instant) {
        return "ACTIVE".equalsIgnoreCase(status) &&
                startsAt != null && !startsAt.isAfter(instant) &&
                expiresAt != null && expiresAt.isAfter(instant);
    }
}
