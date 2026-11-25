package com.englishcoach.community.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "community_moderation_records", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityModerationRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "post_id", nullable = false)
    private CommunityPost post;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "admin_id", nullable = false)
    private User admin;

    @Column(name = "previous_status", nullable = false, length = 32)
    private String previousStatus;

    @Column(name = "new_status", nullable = false, length = 32)
    private String newStatus;

    @Enumerated(EnumType.STRING)
    @Column(name = "action", nullable = false, length = 32)
    private ModerationAction action;

    @Column(name = "reason", length = 64)
    private String reason;

    @Column(name = "note", columnDefinition = "TEXT")
    private String note;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
