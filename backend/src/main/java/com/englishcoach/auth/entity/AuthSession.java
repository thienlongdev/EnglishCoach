package com.englishcoach.auth.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "auth_sessions", schema = "public")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AuthSession {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @Column(name = "session_grant_digest", nullable = false, unique = true, length = 64)
    private String sessionGrantDigest;

    @Builder.Default
    @Column(nullable = false, length = 32)
    private String state = "PENDING";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "activated_at")
    private Instant activatedAt;

    @Column(name = "last_seen_at")
    private Instant lastSeenAt;

    @Column(name = "idle_expires_at", nullable = false)
    private Instant idleExpiresAt;

    @Column(name = "absolute_expires_at", nullable = false)
    private Instant absoluteExpiresAt;

    @Column(name = "pending_expires_at")
    private Instant pendingExpiresAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @Column(name = "revoked_reason")
    private String revokedReason;

    @Column(name = "auth_method", length = 32)
    private String authMethod;

    @Column(name = "authenticated_at")
    private Instant authenticatedAt;

    /** When this session passed a second factor (V92); null for a session that never did. */
    @Column(name = "mfa_verified_at")
    private Instant mfaVerifiedAt;

    /** The factor that was used: WEBAUTHN, TOTP or RECOVERY_CODE (V92). */
    @Column(name = "mfa_method", length = 32)
    private String mfaMethod;

    /** When this session last proved a second factor for a sensitive action (V92). */
    @Column(name = "step_up_at")
    private Instant stepUpAt;

    /** Coarse device description for the session list ("Chrome · Windows"), never the raw User-Agent (V93). */
    @Column(name = "device_label", length = 80)
    private String deviceLabel;
}
