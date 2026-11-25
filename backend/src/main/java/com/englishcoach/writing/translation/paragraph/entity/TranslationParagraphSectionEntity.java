package com.englishcoach.writing.translation.paragraph.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_paragraph_sections", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationParagraphSectionEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "document_id", nullable = false)
    private TranslationParagraphDocumentEntity document;

    @Column(name = "external_section_id", nullable = false)
    private String externalSectionId;

    @Column(name = "section_number")
    private Integer sectionNumber;

    @Column(name = "section_title", columnDefinition = "TEXT")
    private String sectionTitle;

    @Column(name = "ordinal", nullable = false)
    private Integer ordinal;

    @Column(name = "source_locator", columnDefinition = "TEXT")
    private String sourceLocator;

    @Column(name = "target_locator", columnDefinition = "TEXT")
    private String targetLocator;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
