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
@Table(name = "translation_exercise_units", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationExerciseUnitEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "exercise_id", nullable = false)
    private UUID exerciseId;

    @Column(name = "ordinal", nullable = false)
    private Short ordinal;

    @Column(name = "source_vi", nullable = false, columnDefinition = "TEXT")
    private String sourceVi;

    @Column(name = "reference_en", nullable = false, columnDefinition = "TEXT")
    private String referenceEn;

    @Column(name = "source_record_id", length = 255)
    private String sourceRecordId;

    @Column(name = "quality_score", nullable = false, precision = 5, scale = 2)
    private BigDecimal qualityScore;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "target_chunks_json", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String targetChunksJson = "[]";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "accepted_variants_json", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String acceptedVariantsJson = "[]";

    @Column(name = "content_version", nullable = false)
    private Integer contentVersion;

    @Column(name = "active", nullable = false)
    @Builder.Default
    private Boolean active = false;

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
