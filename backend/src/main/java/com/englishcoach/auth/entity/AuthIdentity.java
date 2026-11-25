package com.englishcoach.auth.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "auth_identities", schema = "public", uniqueConstraints = {
        @UniqueConstraint(name = "uk_auth_identities_provider_sub", columnNames = {"provider", "provider_subject"}),
        @UniqueConstraint(name = "uk_auth_identities_user_provider", columnNames = {"user_id", "provider"})
})
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AuthIdentity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @Column(nullable = false, length = 32)
    private String provider;

    @Column(name = "provider_subject", nullable = false)
    private String providerSubject;

    @Column(name = "provider_email")
    private String providerEmail;

    @Builder.Default
    @Column(name = "email_verified")
    private Boolean emailVerified = false;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "last_authenticated_at")
    private Instant lastAuthenticatedAt;
}
