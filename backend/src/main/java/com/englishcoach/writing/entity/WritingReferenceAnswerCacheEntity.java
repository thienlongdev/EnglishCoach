package com.englishcoach.writing.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

@Entity
@Table(name = "writing_reference_answer_cache")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingReferenceAnswerCacheEntity {

    @Id
    @Column(name = "id", length = 64)
    private String id;

    @Column(name = "cache_key", nullable = false, unique = true, length = 192)
    private String cacheKey;

    @Column(name = "task_id", nullable = false, length = 64)
    private String taskId;

    @Column(name = "task_content_version", nullable = false, length = 64)
    private String taskContentVersion;

    @Column(name = "prompt_version", nullable = false, length = 32)
    private String promptVersion;

    @Column(name = "schema_version", nullable = false, length = 32)
    private String schemaVersion;

    @Column(name = "model_version", nullable = false, length = 64)
    private String modelVersion;

    @Column(name = "exemplar_model_answer", nullable = false, columnDefinition = "TEXT")
    private String exemplarModelAnswer;

    @Column(name = "calibrated_level", length = 32)
    private String calibratedLevel;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "structural_observations", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String structuralObservations = "[]";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "lexical_alternatives", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String lexicalAlternatives = "[]";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "generation_metadata", columnDefinition = "jsonb")
    private String generationMetadata;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
