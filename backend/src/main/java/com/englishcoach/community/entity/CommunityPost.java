package com.englishcoach.community.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "community_posts", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityPost {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "author_user_id", nullable = false)
    private User author;

    @Enumerated(EnumType.STRING)
    @Column(name = "author_type", nullable = false, length = 32)
    @Builder.Default
    private AuthorType authorType = AuthorType.USER;

    @Column(name = "created_by_admin_id")
    private Long createdByAdminId;

    @Column(name = "updated_by_admin_id")
    private Long updatedByAdminId;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 32)
    @Builder.Default
    private PostStatus status = PostStatus.PENDING;

    @Enumerated(EnumType.STRING)
    @Column(name = "post_type", nullable = false, length = 32)
    @Builder.Default
    private PostType postType = PostType.GENERAL;

    @Column(name = "content", nullable = false, columnDefinition = "TEXT")
    private String content;

    @Column(name = "is_pinned", nullable = false)
    @Builder.Default
    private boolean isPinned = false;

    @Column(name = "is_featured", nullable = false)
    @Builder.Default
    private boolean isFeatured = false;

    @Column(name = "series_type", length = 64)
    private String seriesType;

    @Column(name = "scheduled_for")
    private Instant scheduledFor;

    @Column(name = "published_at")
    private Instant publishedAt;

    @Column(name = "scheduled_date")
    private LocalDate scheduledDate;

    @Column(name = "like_count", nullable = false)
    @Builder.Default
    private int likeCount = 0;

    @Column(name = "comment_count", nullable = false)
    @Builder.Default
    private int commentCount = 0;

    @Column(name = "save_count", nullable = false)
    @Builder.Default
    private int saveCount = 0;

    @Column(name = "comments_disabled_by_owner", nullable = false)
    @Builder.Default
    private boolean commentsDisabledByOwner = false;

    @Column(name = "comments_locked_by_admin", nullable = false)
    @Builder.Default
    private boolean commentsLockedByAdmin = false;

    public boolean isCommentsDisabled() {
        return commentsLockedByAdmin || commentsDisabledByOwner;
    }

    @Enumerated(EnumType.STRING)
    @Column(name = "shared_entity_type", length = 64)
    private SharedEntityType sharedEntityType;

    @Column(name = "shared_entity_id", length = 128)
    private String sharedEntityId;

    @Column(name = "shared_entity_payload", columnDefinition = "TEXT")
    private String sharedEntityPayload;

    @OneToMany(mappedBy = "post", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    @OrderBy("displayOrder ASC")
    @Builder.Default
    private List<CommunityPostMedia> mediaList = new ArrayList<>();

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
