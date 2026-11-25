package com.englishcoach.reading.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.LocalDateTime;

@Entity
@Table(name = "reading_materials")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ReadingMaterial {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String title;

    @Column(length = 1000)
    private String sourceUrl;

    @Enumerated(EnumType.STRING)
    @Column
    private MaterialType materialType;

    @Column(columnDefinition = "TEXT")
    private String contentText;

    @Column
    private String fileUrl;

    @Column
    private Integer wordCount;

    @Column
    private String difficultyLevel;

    @Column
    private LocalDateTime createdAt;

    @Column(name = "owner_user_id")
    private Long ownerUserId;

    @Column(name = "origin_feed_article_id")
    private Long originFeedArticleId;

    @Column(name = "source_name", length = 100)
    private String sourceName;

    @Column(name = "content_mode", length = 20)
    private String contentMode;

    @Column(name = "is_system", nullable = false)
    @Builder.Default
    private boolean isSystem = false;

    @Column(name = "document_schema_version", length = 64)
    private String documentSchemaVersion;

    @Column(name = "source_document_type", length = 64)
    private String sourceDocumentType;

    @Column(name = "source_file_name", length = 255)
    private String sourceFileName;

    @Column(name = "canonical_document", columnDefinition = "jsonb")
    @JdbcTypeCode(SqlTypes.JSON)
    private String canonicalDocument;

    public enum MaterialType {
        ARTICLE, PDF, CUSTOM
    }
}
