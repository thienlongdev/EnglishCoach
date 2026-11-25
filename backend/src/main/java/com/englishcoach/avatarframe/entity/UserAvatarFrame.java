package com.englishcoach.avatarframe.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(
    name = "user_avatar_frames",
    schema = "public",
    uniqueConstraints = {
        @UniqueConstraint(name = "uq_user_avatar_frames_user_frame", columnNames = {"user_id", "frame_id"})
    }
)
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class UserAvatarFrame {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "frame_id", nullable = false)
    private AvatarFrame frame;

    @CreationTimestamp
    @Column(name = "unlocked_at", nullable = false)
    private Instant unlockedAt;

    @Column(name = "expires_at")
    private Instant expiresAt;

    @Column(nullable = false, length = 32)
    private String source;

    @Builder.Default
    @Column(name = "is_equipped", nullable = false)
    private boolean isEquipped = false;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
