package com.englishcoach.writing.translation.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_documents", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationDocumentEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "source_id", nullable = false)
    private UUID sourceId;

    @Column(name = "import_batch_id", nullable = false)
    private UUID importBatchId;

    @Column(name = "source_document_id", nullable = false, length = 255)
    private String sourceDocumentId;

    @Column(name = "document_kind", nullable = false, length = 24)
    @Builder.Default
    private String documentKind = "PARAGRAPH";

    @Column(name = "topic_code", nullable = false, length = 32)
    private String topicCode;

    @Column(name = "difficulty_bucket", nullable = false, length = 24)
    private String difficultyBucket;

    @Column(name = "cefr_band", length = 8)
    private String cefrBand;

    @Column(name = "quality_score", nullable = false, precision = 5, scale = 2)
    private BigDecimal qualityScore;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "coherence_json", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String coherenceJson = "{}";

    @Column(name = "content_version", nullable = false)
    private Integer contentVersion;

    @Column(name = "active", nullable = false)
    @Builder.Default
    private Boolean active = false;

    @Column(name = "sequence_count", nullable = false)
    private Short sequenceCount;

    @Column(name = "random_bucket", nullable = false)
    private Short randomBucket;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
