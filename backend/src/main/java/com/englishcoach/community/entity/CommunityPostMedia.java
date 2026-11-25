package com.englishcoach.community.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "community_post_media", schema = "public")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CommunityPostMedia {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = true)
    @JoinColumn(name = "post_id", nullable = true)
    private CommunityPost post;

    @Column(name = "user_id")
    private Long userId;

    @Column(name = "storage_key", nullable = false, length = 512)
    private String storageKey;

    @Column(name = "file_name", nullable = false)
    private String fileName;

    @Column(name = "file_size", nullable = false)
    private Long fileSize;

    @Column(name = "mime_type", nullable = false, length = 64)
    private String mimeType;

    private Integer width;

    private Integer height;

    @Column(name = "display_order", nullable = false)
    @Builder.Default
    private int displayOrder = 0;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
