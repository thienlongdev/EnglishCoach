package com.englishcoach.writing.entity;

import com.englishcoach.writing.enums.EvidenceType;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "writing_learning_evidence")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingLearningEvidenceEntity {

    @Id
    @Column(name = "id", length = 64)
    private String id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "source_issue_id", length = 64)
    private String sourceIssueId;

    @Column(name = "source_assessment_id", nullable = false, length = 64)
    private String sourceAssessmentId;

    @Column(name = "source_practice_id", length = 64)
    private String sourcePracticeId;

    @Column(name = "pattern_code", length = 128)
    private String patternCode;

    @Column(name = "skill_code", length = 128)
    private String skillCode;

    @Enumerated(EnumType.STRING)
    @Column(name = "evidence_type", nullable = false, length = 32)
    private EvidenceType evidenceType;

    @Column(name = "is_positive", nullable = false)
    private Boolean isPositive;

    @Column(name = "weight", nullable = false)
    @Builder.Default
    private Double weight = 1.0;

    @Column(name = "context_id", nullable = false, length = 64)
    private String contextId;

    @CreationTimestamp
    @Column(name = "recorded_at", nullable = false, updatable = false)
    private Instant recordedAt;
}
