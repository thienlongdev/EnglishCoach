package com.englishcoach.writing.entity;

import com.englishcoach.writing.enums.PracticeMode;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

@Entity
@Table(name = "writing_practices")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingPracticeEntity {

    @Id
    @Column(name = "id", length = 64)
    private String id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Enumerated(EnumType.STRING)
    @Column(name = "mode", nullable = false, length = 32)
    private PracticeMode mode;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "exercise_snapshot", nullable = false, columnDefinition = "jsonb")
    private String exerciseSnapshot;

    @Column(name = "target_pattern_code", length = 128)
    private String targetPatternCode;

    @Column(name = "source_issue_id", length = 64)
    private String sourceIssueId;

    @Column(name = "source_session_id", length = 64)
    private String sourceSessionId;

    @Column(name = "current_attempt_ordinal", nullable = false)
    @Builder.Default
    private Integer currentAttemptOrdinal = 0;

    @Column(name = "max_attempts", nullable = false)
    @Builder.Default
    private Integer maxAttempts = 3;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "revealed_hints", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String revealedHints = "[]";

    @Column(name = "is_completed", nullable = false)
    @Builder.Default
    private Boolean isCompleted = false;

    @Column(name = "is_success", nullable = false)
    @Builder.Default
    private Boolean isSuccess = false;

    @Column(name = "model_answer_revealed", nullable = false)
    @Builder.Default
    private Boolean modelAnswerRevealed = false;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
