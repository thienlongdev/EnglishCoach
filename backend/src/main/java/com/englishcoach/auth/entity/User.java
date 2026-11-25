package com.englishcoach.auth.entity;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDateTime;

@Entity
@Table(name = "users")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String email;

    @Column(name = "email_normalized", insertable = false, updatable = false)
    private String emailNormalized;

    @JsonIgnore
    @ToString.Exclude
    @Column(nullable = true)
    private String password;

    @Column(nullable = false)
    private String name;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Role role;

    @Builder.Default
    @Column(name = "credential_status", nullable = false)
    private String credentialStatus = "NONE";

    @Builder.Default
    @Column(name = "account_status", nullable = false)
    private String accountStatus = "ACTIVE";

    @Column(name = "email_verified_at")
    private LocalDateTime emailVerifiedAt;

    @Column(name = "email_verification_source")
    private String emailVerificationSource;

    @Column(name = "password_changed_at")
    private LocalDateTime passwordChangedAt;

    @Builder.Default
    @Column(name = "credential_version", nullable = false)
    private Long credentialVersion = 0L;

    @CreationTimestamp
    @Column(nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @UpdateTimestamp
    private LocalDateTime updatedAt;

    /** Single-admin invariant (owner policy): ROLE_ADMIN only for the official administrator e-mail. */
    @PrePersist
    @PreUpdate
    void enforceSingleAdmin() {
        com.englishcoach.auth.policy.OfficialAdminPolicy.assertRoleAllowed(email, role);
    }
}
