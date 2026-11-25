package com.englishcoach.writing.translation.paragraph.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_paragraph_documents", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationParagraphDocumentEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "source_id", nullable = false)
    private TranslationParagraphSourceEntity source;

    @Column(name = "external_document_id", nullable = false)
    private String externalDocumentId;

    @Column(name = "source_title", nullable = false, columnDefinition = "TEXT")
    private String sourceTitle;

    @Column(name = "target_title", nullable = false, columnDefinition = "TEXT")
    private String targetTitle;

    @Column(name = "source_url", columnDefinition = "TEXT")
    private String sourceUrl;

    @Column(name = "target_url", columnDefinition = "TEXT")
    private String targetUrl;

    @Column(name = "source_revision_id", length = 64)
    private String sourceRevisionId;

    @Column(name = "target_revision_id", length = 64)
    private String targetRevisionId;

    @Column(name = "source_language", nullable = false, length = 16)
    @Builder.Default
    private String sourceLanguage = "en";

    @Column(name = "target_language", nullable = false, length = 16)
    @Builder.Default
    private String targetLanguage = "vi";

    @Column(name = "publication_timestamp")
    private Instant publicationTimestamp;

    @Column(name = "author", columnDefinition = "TEXT")
    private String author;

    @Column(name = "document_hash", nullable = false, columnDefinition = "CHAR(64)")
    private String documentHash;

    @Column(name = "original_order_proven", nullable = false)
    @Builder.Default
    private Boolean originalOrderProven = true;

    @Column(name = "provenance_complete", nullable = false)
    @Builder.Default
    private Boolean provenanceComplete = true;

    @Column(name = "publication_state", nullable = false, length = 32)
    @Builder.Default
    private String publicationState = "ELIGIBLE";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
