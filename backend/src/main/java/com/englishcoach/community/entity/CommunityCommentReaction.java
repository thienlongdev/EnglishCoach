package com.englishcoach.community.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(
    name = "community_comment_reactions",
    schema = "public",
    uniqueConstraints = @UniqueConstraint(name = "uq_community_comment_user_reaction", columnNames = {"comment_id", "user_id"})
)
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityCommentReaction {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "comment_id", nullable = false)
    private CommunityComment comment;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @Column(name = "reaction_type", nullable = false, length = 32)
    @Builder.Default
    private String reactionType = "LIKE";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
