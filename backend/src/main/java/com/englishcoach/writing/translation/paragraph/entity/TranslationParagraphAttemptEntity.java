package com.englishcoach.writing.translation.paragraph.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_paragraph_attempts", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationParagraphAttemptEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "session_id", nullable = false)
    private UUID sessionId;

    @Column(name = "session_item_id", nullable = false)
    private UUID sessionItemId;

    @Column(name = "passage_id", nullable = false)
    private UUID passageId;

    @Column(name = "content_version", nullable = false)
    private Integer contentVersion;

    @Column(name = "attempt_ordinal", nullable = false)
    private Integer attemptOrdinal;

    @Column(name = "action", nullable = false, length = 16)
    private String action;

    @Column(name = "client_mutation_id", nullable = false, length = 128)
    private String clientMutationId;

    @Column(name = "submitted_text", nullable = false, columnDefinition = "TEXT")
    private String submittedText;

    @Column(name = "normalized_answer_hash", nullable = false, columnDefinition = "CHAR(64)")
    private String normalizedAnswerHash;

    @Column(name = "evaluation_status", nullable = false, length = 24)
    private String evaluationStatus;

    @Column(name = "grader_version", nullable = false, length = 64)
    private String graderVersion;

    @Column(name = "prompt_version", nullable = false, length = 64)
    private String promptVersion;

    @Column(name = "model_id", length = 128)
    private String modelId;

    @Column(name = "accepted")
    private Boolean accepted;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "feedback_snapshot", columnDefinition = "jsonb")
    private String feedbackSnapshot;

    @Column(name = "cache_fingerprint", columnDefinition = "CHAR(64)")
    private String cacheFingerprint;

    @Column(name = "generation_count", nullable = false)
    @Builder.Default
    private Integer generationCount = 0;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
