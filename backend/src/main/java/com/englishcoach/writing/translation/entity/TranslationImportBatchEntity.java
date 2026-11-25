package com.englishcoach.writing.translation.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_import_batches", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationImportBatchEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "source_id", nullable = false)
    private UUID sourceId;

    @Column(name = "batch_key", nullable = false, unique = true, length = 255)
    private String batchKey;

    @Column(name = "importer_version", nullable = false, length = 64)
    private String importerVersion;

    @Column(name = "taxonomy_version", nullable = false, length = 64)
    private String taxonomyVersion;

    @Column(name = "normalizer_version", nullable = false, length = 64)
    private String normalizerVersion;

    @Column(name = "status", nullable = false, length = 24)
    private String status;

    @Column(name = "records_read", nullable = false)
    @Builder.Default
    private Long recordsRead = 0L;

    @Column(name = "records_accepted", nullable = false)
    @Builder.Default
    private Long recordsAccepted = 0L;

    @Column(name = "records_rejected", nullable = false)
    @Builder.Default
    private Long recordsRejected = 0L;

    @Column(name = "records_review", nullable = false)
    @Builder.Default
    private Long recordsReview = 0L;

    @Column(name = "artifact_uri", nullable = false, columnDefinition = "TEXT")
    private String artifactUri;

    @Column(name = "artifact_sha256", nullable = false, length = 64)
    private String artifactSha256;

    @Column(name = "started_at", nullable = false)
    @Builder.Default
    private Instant startedAt = Instant.now();

    @Column(name = "completed_at")
    private Instant completedAt;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
