package com.englishcoach.writing.translation.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_sessions", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationSessionEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "exercise_id", nullable = false)
    private UUID exerciseId;

    @Column(name = "content_version", nullable = false)
    private Integer contentVersion;

    @Column(name = "status", nullable = false, length = 20)
    private String status;

    @Column(name = "current_ordinal", nullable = false)
    @Builder.Default
    private Short currentOrdinal = 1;

    @Column(name = "session_revision", nullable = false)
    @Builder.Default
    private Long sessionRevision = 0L;

    @Column(name = "client_mutation_id", nullable = false, length = 128)
    private String clientMutationId;

    @Column(name = "request_sha256", nullable = false, length = 64)
    private String requestSha256;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "context_snapshot_json", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String contextSnapshotJson = "{}";

    @Column(name = "context_hash", nullable = false, length = 64)
    private String contextHash;

    @Column(name = "last_attempt_id")
    private UUID lastAttemptId;

    @Column(name = "started_at", nullable = false)
    @Builder.Default
    private Instant startedAt = Instant.now();

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "completed_at")
    private Instant completedAt;

    @Column(name = "expires_at")
    private Instant expiresAt;
}
