package com.englishcoach.writing.translation.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "translation_mutation_receipts", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranslationMutationReceiptEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(name = "id")
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "session_id", nullable = false)
    private UUID sessionId;

    @Column(name = "session_unit_id", nullable = false)
    private UUID sessionUnitId;

    @Column(name = "endpoint", nullable = false, length = 32)
    private String endpoint;

    @Column(name = "client_mutation_id", nullable = false, length = 128)
    private String clientMutationId;

    @Column(name = "request_sha256", nullable = false, length = 64)
    private String requestSha256;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "response_snapshot", nullable = false, columnDefinition = "jsonb")
    private String responseSnapshot;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
