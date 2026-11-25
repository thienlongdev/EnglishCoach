package com.englishcoach.content.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "feed_articles", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class FeedArticle {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "provider_key", length = 50)
    private String providerKey;

    @Column(nullable = false, length = 100)
    private String source;

    @Column(nullable = false, length = 500)
    private String title;

    @Column(nullable = false, length = 1000)
    private String url;

    @Column(length = 1000)
    private String thumbnail;

    @Column(columnDefinition = "TEXT")
    private String summary;

    @Column(length = 100)
    private String category;

    @Column(nullable = false, length = 10)
    @Builder.Default
    private String level = "B1";

    @Column(name = "read_minutes", nullable = false)
    @Builder.Default
    private Integer readMinutes = 3;

    @Column(name = "published_at", nullable = false)
    private Instant publishedAt;

    @CreationTimestamp
    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;
}
