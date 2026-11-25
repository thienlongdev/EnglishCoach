package com.englishcoach.writing.entity;

import com.englishcoach.writing.enums.SubmissionKind;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "writing_submissions")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingSubmissionEntity {

    @Id
    @Column(name = "id", length = 64)
    private String id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "session_id", length = 64)
    private String sessionId;

    @Column(name = "practice_id", length = 64)
    private String practiceId;

    @Enumerated(EnumType.STRING)
    @Column(name = "kind", nullable = false, length = 32)
    private SubmissionKind kind;

    @Column(name = "ordinal", nullable = false)
    @Builder.Default
    private Integer ordinal = 1;

    @Column(name = "content", nullable = false, columnDefinition = "TEXT")
    private String content;

    @Column(name = "word_count", nullable = false)
    @Builder.Default
    private Integer wordCount = 0;

    @Column(name = "character_count", nullable = false)
    @Builder.Default
    private Integer characterCount = 0;

    @Column(name = "idempotency_key", length = 128)
    private String idempotencyKey;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
