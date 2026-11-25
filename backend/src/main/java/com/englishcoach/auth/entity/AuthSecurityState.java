package com.englishcoach.auth.entity;

import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;

@Entity
@Table(name = "auth_security_state", schema = "public")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AuthSecurityState {

    @Id
    @Column(name = "user_id")
    private Long userId;

    @OneToOne(fetch = FetchType.LAZY)
    @MapsId
    @JoinColumn(name = "user_id")
    private User user;

    @Builder.Default
    @Column(name = "failed_login_count", nullable = false)
    private Integer failedLoginCount = 0;

    @Column(name = "window_started_at")
    private Instant windowStartedAt;

    @Column(name = "next_allowed_at")
    private Instant nextAllowedAt;

    @Column(name = "locked_until")
    private Instant lockedUntil;

    @Builder.Default
    @Column(name = "reset_generation", nullable = false)
    private Long resetGeneration = 0L;

    @Builder.Default
    @Column(name = "verification_generation", nullable = false)
    private Long verificationGeneration = 0L;

    @Builder.Default
    @Version
    @Column(name = "version", nullable = false)
    private Long version = 0L;
}
