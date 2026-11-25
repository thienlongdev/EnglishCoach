package com.englishcoach.writing.translation.paragraph.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_paragraph_sources", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationParagraphSourceEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "source_code", nullable = false, length = 80)
    private String sourceCode;

    @Column(name = "source_name", nullable = false, length = 160)
    private String sourceName;

    @Column(name = "source_release", nullable = false, length = 120)
    private String sourceRelease;

    @Column(name = "source_type", nullable = false, length = 64)
    private String sourceType;

    @Column(name = "legal_class", nullable = false, length = 32)
    private String legalClass;

    @Column(name = "legal_review_state", nullable = false, length = 32)
    private String legalReviewState;

    @Column(name = "publication_state", nullable = false, length = 32)
    private String publicationState;

    @Column(name = "license_code", nullable = false, length = 64)
    private String licenseCode;

    @Column(name = "license_version", length = 32)
    private String licenseVersion;

    @Column(name = "license_url", columnDefinition = "TEXT")
    private String licenseUrl;

    @Column(name = "commercial_use_allowed", nullable = false)
    private Boolean commercialUseAllowed;

    @Column(name = "derivatives_allowed", nullable = false)
    private Boolean derivativesAllowed;

    @Column(name = "attribution_required", nullable = false)
    private Boolean attributionRequired;

    @Column(name = "source_url", columnDefinition = "TEXT")
    private String sourceUrl;

    @Column(name = "retrieved_at")
    private Instant retrievedAt;

    @Column(name = "source_snapshot_hash", columnDefinition = "CHAR(64)")
    private String sourceSnapshotHash;

    @Column(name = "pipeline_version", nullable = false, length = 64)
    private String pipelineVersion;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
