package com.englishcoach.writing.translation.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_attempts", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationAttemptEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "session_id", nullable = false)
    private UUID sessionId;

    @Column(name = "exercise_id", nullable = false)
    private UUID exerciseId;

    @Column(name = "unit_id", nullable = false)
    private UUID unitId;

    @Column(name = "unit_ordinal", nullable = false)
    private Short unitOrdinal;

    @Column(name = "attempt_ordinal", nullable = false)
    private Integer attemptOrdinal;

    @Column(name = "action", nullable = false, length = 16)
    private String action;

    @Column(name = "client_mutation_id", nullable = false, length = 128)
    private String clientMutationId;

    @Column(name = "request_sha256", nullable = false, length = 64)
    private String requestSha256;

    @Column(name = "answer_text", nullable = false, columnDefinition = "TEXT")
    private String answerText;

    @Column(name = "exact_answer_hash", nullable = false, length = 64)
    private String exactAnswerHash;

    @Column(name = "answer_cache_hash", nullable = false, length = 64)
    private String answerCacheHash;

    @Column(name = "hint_level", nullable = false, length = 16)
    private String hintLevel;

    @Column(name = "reference_revealed", nullable = false)
    private Boolean referenceRevealed;

    @Column(name = "evaluation_status", nullable = false, length = 24)
    private String evaluationStatus;

    @Column(name = "grader_version", nullable = false, length = 64)
    private String graderVersion;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "result_snapshot", columnDefinition = "jsonb")
    private String resultSnapshot;

    @Column(name = "accepted")
    private Boolean accepted;

    @Column(name = "cache_fingerprint", length = 64)
    private String cacheFingerprint;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
