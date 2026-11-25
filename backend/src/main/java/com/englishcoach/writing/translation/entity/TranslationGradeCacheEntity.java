package com.englishcoach.writing.translation.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_grade_cache", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationGradeCacheEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "fingerprint_hash", nullable = false, length = 64)
    private String fingerprintHash;

    @Column(name = "exercise_id", nullable = false)
    private UUID exerciseId;

    @Column(name = "content_version", nullable = false)
    private Integer contentVersion;

    @Column(name = "unit_id", nullable = false)
    private UUID unitId;

    @Column(name = "grader_version", nullable = false, length = 64)
    private String graderVersion;

    @Column(name = "answer_cache_hash", nullable = false, length = 64)
    private String answerCacheHash;

    @Column(name = "exact_answer_hash", nullable = false, length = 64)
    private String exactAnswerHash;

    @Column(name = "paragraph_context_hash", length = 64)
    private String paragraphContextHash;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "result_snapshot", columnDefinition = "jsonb")
    private String resultSnapshot;

    @Column(name = "result_status", nullable = false, length = 16)
    private String resultStatus;

    @Column(name = "lease_owner", length = 128)
    private String leaseOwner;

    @Column(name = "lease_until")
    private Instant leaseUntil;

    @Column(name = "owner_attempt_id")
    private UUID ownerAttemptId;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "expires_at")
    private Instant expiresAt;
}
