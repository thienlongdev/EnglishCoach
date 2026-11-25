package com.englishcoach.writing.translation.paragraph.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_paragraph_session_items", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationParagraphSessionItemEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "session_id", nullable = false)
    private TranslationParagraphSessionEntity session;

    @ManyToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "passage_id", nullable = false)
    private TranslationParagraphPassageEntity passage;

    @Column(name = "content_version", nullable = false)
    @Builder.Default
    private Integer contentVersion = 1;

    @Column(name = "ordinal", nullable = false)
    private Integer ordinal;

    @Column(name = "draft_text", nullable = false, columnDefinition = "TEXT")
    @Builder.Default
    private String draftText = "";

    @Column(name = "draft_revision", nullable = false)
    @Builder.Default
    private Long draftRevision = 0L;

    @Column(name = "progress_state", nullable = false, length = 32)
    @Builder.Default
    private String progressState = "NOT_STARTED";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
