package com.englishcoach.auth.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "auth_action_tokens", schema = "public")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AuthActionToken {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "token_digest", nullable = false, unique = true, length = 64)
    private String tokenDigest;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @Column(nullable = false, length = 64)
    private String purpose;

    @Column(name = "bound_email_normalized")
    private String boundEmailNormalized;

    @Column(name = "bound_session_id")
    private UUID boundSessionId;

    @org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)
    @Column(name = "metadata", columnDefinition = "jsonb")
    private String metadata;

    @Builder.Default
    @Column(nullable = false)
    private Long generation = 0L;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "used_at")
    private Instant usedAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;
}
