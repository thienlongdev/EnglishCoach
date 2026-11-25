package com.englishcoach.auth.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "auth_mail_jobs", schema = "public")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AuthMailJob {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @Column(nullable = false, length = 64)
    private String purpose;

    @Column(name = "recipient_email", nullable = false)
    private String recipientEmail;

    @Builder.Default
    @Column(nullable = false)
    private Long generation = 0L;

    @Builder.Default
    @Column(nullable = false, length = 32)
    private String status = "PENDING";

    @Builder.Default
    @Column(name = "attempt_count", nullable = false)
    private Integer attemptCount = 0;

    @Builder.Default
    @Column(name = "next_attempt_at", nullable = false)
    private Instant nextAttemptAt = Instant.now();

    @Column(name = "lease_expires_at")
    private Instant leaseExpiresAt;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    @Column(name = "last_error")
    private String lastError;
}
