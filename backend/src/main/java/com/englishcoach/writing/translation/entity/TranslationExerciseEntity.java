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
@Table(name = "translation_exercises", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationExerciseEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "source_id", nullable = false)
    private UUID sourceId;

    @Column(name = "import_batch_id", nullable = false)
    private UUID importBatchId;

    @Column(name = "document_id")
    private UUID documentId;

    @Column(name = "mode", nullable = false, length = 16)
    private String mode;

    @Column(name = "source_vi", columnDefinition = "TEXT")
    private String sourceVi;

    @Column(name = "reference_en", columnDefinition = "TEXT")
    private String referenceEn;

    @Column(name = "source_record_id", length = 255)
    private String sourceRecordId;

    @Column(name = "topic_code", nullable = false, length = 32)
    private String topicCode;

    @Column(name = "difficulty_bucket", nullable = false, length = 24)
    private String difficultyBucket;

    @Column(name = "cefr_band", length = 8)
    private String cefrBand;

    @Column(name = "quality_score", nullable = false, precision = 5, scale = 2)
    private BigDecimal qualityScore;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "target_chunks_json", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String targetChunksJson = "[]";

    @Column(name = "content_version", nullable = false)
    private Integer contentVersion;

    @Column(name = "active", nullable = false)
    @Builder.Default
    private Boolean active = false;

    @Column(name = "random_bucket", nullable = false)
    private Short randomBucket;

    @Column(name = "source_matching_hash", nullable = false, length = 64)
    private String sourceMatchingHash;

    @Column(name = "reference_matching_hash", nullable = false, length = 64)
    private String referenceMatchingHash;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
