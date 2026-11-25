package com.englishcoach.writing.entity;

import com.englishcoach.writing.enums.AssessmentOperation;
import com.englishcoach.writing.enums.AssessmentStatus;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

@Entity
@Table(name = "writing_assessments")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingAssessmentEntity {

    @Id
    @Column(name = "id", length = 64)
    private String id;

    @Column(name = "submission_id", nullable = false, length = 64)
    private String submissionId;

    @Enumerated(EnumType.STRING)
    @Column(name = "operation", nullable = false, length = 32)
    private AssessmentOperation operation;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 32)
    @Builder.Default
    private AssessmentStatus status = AssessmentStatus.QUEUED;

    @Column(name = "overall_score")
    private Integer overallScore;

    @Column(name = "grammatically_correct")
    @Builder.Default
    private Boolean grammaticallyCorrect = null;

    @Column(name = "coverage_summary", columnDefinition = "TEXT")
    private String coverageSummary;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "dimension_verdicts", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String dimensionVerdicts = "[]";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "strengths", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String strengths = "[]";

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "prioritized_issue_ids", nullable = false, columnDefinition = "jsonb")
    @Builder.Default
    private String prioritizedIssueIds = "[]";

    @Column(name = "lease_token", length = 64)
    private String leaseToken;

    @Column(name = "grading_reservation_id")
    private Long gradingReservationId;

    @Column(name = "grading_voucher_use_id")
    private Long gradingVoucherUseId;

    @Column(name = "lease_expires_at")
    private Instant leaseExpiresAt;

    @Column(name = "retry_count", nullable = false)
    @Builder.Default
    private Integer retryCount = 0;

    @Column(name = "max_retries", nullable = false)
    @Builder.Default
    private Integer maxRetries = 2;

    @Column(name = "error_message", columnDefinition = "TEXT")
    private String errorMessage;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "completed_at")
    private Instant completedAt;
}
