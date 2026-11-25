package com.englishcoach.writing.translation.paragraph.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_paragraph_grade_cache", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationParagraphGradeCacheEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "passage_id", nullable = false)
    private UUID passageId;

    @Column(name = "content_version", nullable = false)
    private Integer contentVersion;

    @Column(name = "cache_fingerprint", nullable = false, columnDefinition = "CHAR(64)")
    private String cacheFingerprint;

    @Column(name = "source_hash", nullable = false, columnDefinition = "CHAR(64)")
    private String sourceHash;

    @Column(name = "reference_hash", nullable = false, columnDefinition = "CHAR(64)")
    private String referenceHash;

    @Column(name = "normalized_answer_hash", nullable = false, columnDefinition = "CHAR(64)")
    private String normalizedAnswerHash;

    @Column(name = "grader_version", nullable = false, length = 64)
    private String graderVersion;

    @Column(name = "prompt_version", nullable = false, length = 64)
    private String promptVersion;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "feedback_json", nullable = false, columnDefinition = "jsonb")
    private String feedbackJson;

    @Column(name = "accepted", nullable = false)
    private Boolean accepted;

    @Column(name = "evaluation_status", nullable = false, length = 24)
    private String evaluationStatus;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
