package com.englishcoach.writing.entity;

import com.englishcoach.writing.enums.WritingSessionStage;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

@Entity
@Table(name = "writing_sessions")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingSessionEntity {

    @Id
    @Column(name = "id", length = 64)
    private String id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "task_id", nullable = false, length = 64)
    private String taskId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "task_snapshot", nullable = false, columnDefinition = "jsonb")
    private String taskSnapshot;

    @Enumerated(EnumType.STRING)
    @Column(name = "stage", nullable = false, length = 32)
    @Builder.Default
    private WritingSessionStage stage = WritingSessionStage.UNDERSTANDING;

    @Column(name = "working_plan", nullable = false, columnDefinition = "TEXT")
    @Builder.Default
    private String workingPlan = "";

    @Column(name = "working_text", nullable = false, columnDefinition = "TEXT")
    @Builder.Default
    private String workingText = "";

    @Column(name = "current_revision", nullable = false)
    @Builder.Default
    private Long currentRevision = 1L;

    @Column(name = "active_assessment_id", length = 64)
    private String activeAssessmentId;

    @Column(name = "final_draft_id", length = 64)
    private String finalDraftId;

    @Column(name = "is_favorite", nullable = false)
    @Builder.Default
    private Boolean isFavorite = false;

    @Column(name = "completed_at")
    private Instant completedAt;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
