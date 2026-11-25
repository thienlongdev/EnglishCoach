package com.englishcoach.writing.translation.paragraph.entity;

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
@Table(name = "translation_paragraph_passages", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationParagraphPassageEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "document_id", nullable = false)
    private TranslationParagraphDocumentEntity document;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "section_id", nullable = false)
    private TranslationParagraphSectionEntity section;

    @Column(name = "external_passage_id", nullable = false)
    private String externalPassageId;

    @Column(name = "passage_ordinal", nullable = false)
    private Integer passageOrdinal;

    @Column(name = "source_vi", nullable = false, columnDefinition = "TEXT")
    private String sourceVi;

    @Column(name = "reference_en", nullable = false, columnDefinition = "TEXT")
    private String referenceEn;

    @Column(name = "source_span_start", nullable = false)
    private Integer sourceSpanStart;

    @Column(name = "source_span_end", nullable = false)
    private Integer sourceSpanEnd;

    @Column(name = "target_span_start", nullable = false)
    private Integer targetSpanStart;

    @Column(name = "target_span_end", nullable = false)
    private Integer targetSpanEnd;

    @Column(name = "source_revision_id", length = 64)
    private String sourceRevisionId;

    @Column(name = "target_revision_id", length = 64)
    private String targetRevisionId;

    @Column(name = "source_hash", nullable = false, columnDefinition = "CHAR(64)")
    private String sourceHash;

    @Column(name = "reference_hash", nullable = false, columnDefinition = "CHAR(64)")
    private String referenceHash;

    @Column(name = "bilingual_pair_hash", nullable = false, columnDefinition = "CHAR(64)")
    private String bilingualPairHash;

    @Column(name = "content_version", nullable = false)
    @Builder.Default
    private Integer contentVersion = 1;

    @Column(name = "alignment_score", nullable = false, precision = 6, scale = 4)
    private BigDecimal alignmentScore;

    @Column(name = "alignment_decision", nullable = false, length = 32)
    private String alignmentDecision;

    @Column(name = "coherence_score", nullable = false, precision = 6, scale = 4)
    private BigDecimal coherenceScore;

    @Column(name = "coherence_decision", nullable = false, length = 32)
    private String coherenceDecision;

    @Column(name = "quality_score", nullable = false, precision = 6, scale = 4)
    private BigDecimal qualityScore;

    @Column(name = "quality_decision", nullable = false, length = 32)
    private String qualityDecision;

    @Column(name = "usefulness_score", precision = 6, scale = 4)
    private BigDecimal usefulnessScore;

    @Column(name = "rights_decision", nullable = false, length = 32)
    private String rightsDecision;

    @Column(name = "rights_eligible", nullable = false)
    @Builder.Default
    private Boolean rightsEligible = true;

    @Column(name = "duplicate_cluster_id", length = 255)
    private String duplicateClusterId;

    @Column(name = "canonical_content", nullable = false)
    @Builder.Default
    private Boolean canonicalContent = true;

    @Column(name = "genre", nullable = false, length = 64)
    private String genre;

    @Column(name = "topic", nullable = false, length = 64)
    private String topic;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "secondary_topics", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String secondaryTopics = "[]";

    @Column(name = "difficulty_status", nullable = false, length = 32)
    @Builder.Default
    private String difficultyStatus = "UNCALIBRATED";

    @Column(name = "difficulty_score", precision = 6, scale = 4)
    private BigDecimal difficultyScore;

    @Column(name = "difficulty_model_version", length = 64)
    private String difficultyModelVersion;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "difficulty_features", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String difficultyFeatures = "{}";

    @Column(name = "publication_state", nullable = false, length = 32)
    @Builder.Default
    private String publicationState = "STAGED";

    @Column(name = "attribution_text", nullable = false, columnDefinition = "TEXT")
    private String attributionText;

    @Column(name = "license_code", nullable = false, length = 64)
    private String licenseCode;

    @Column(name = "source_url", columnDefinition = "TEXT")
    private String sourceUrl;

    @Column(name = "target_url", columnDefinition = "TEXT")
    private String targetUrl;

    @Column(name = "pipeline_version", nullable = false, length = 64)
    private String pipelineVersion;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
