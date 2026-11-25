package com.englishcoach.community.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "community_user_restrictions", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityUserRestriction {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "target_user_id", nullable = false)
    private User targetUser;

    @Enumerated(EnumType.STRING)
    @Column(name = "restriction_type", nullable = false, length = 64)
    private CommunityRestrictionType restrictionType;

    @Column(name = "reason", nullable = false, length = 500)
    private String reason;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "created_by_admin_id", nullable = false)
    private User createdByAdmin;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "expires_at")
    private Instant expiresAt; // null = permanent

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "revoked_by_admin_id")
    private User revokedByAdmin;

    public boolean isActive() {
        return revokedAt == null && (expiresAt == null || expiresAt.isAfter(Instant.now()));
    }
}
