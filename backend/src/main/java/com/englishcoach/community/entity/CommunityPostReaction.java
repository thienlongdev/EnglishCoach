package com.englishcoach.community.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(
    name = "community_post_reactions",
    schema = "public",
    uniqueConstraints = @UniqueConstraint(name = "uq_community_post_user_reaction", columnNames = {"post_id", "user_id"})
)
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityPostReaction {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "post_id", nullable = false)
    private CommunityPost post;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @Enumerated(EnumType.STRING)
    @Column(name = "reaction_type", nullable = false, length = 32)
    @Builder.Default
    private ReactionType reactionType = ReactionType.LIKE;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
