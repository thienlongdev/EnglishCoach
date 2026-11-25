package com.englishcoach.writing.entity;

import com.englishcoach.writing.enums.IssueDisposition;
import com.englishcoach.writing.enums.IssueKind;
import com.englishcoach.writing.enums.IssueSeverity;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;

@Entity
@Table(name = "writing_feedback_issues")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingFeedbackIssueEntity {

    @Id
    @Column(name = "id", length = 64)
    private String id;

    @Column(name = "assessment_id", nullable = false, length = 64)
    private String assessmentId;

    @Enumerated(EnumType.STRING)
    @Column(name = "kind", nullable = false, length = 32)
    private IssueKind kind;

    @Enumerated(EnumType.STRING)
    @Column(name = "severity", nullable = false, length = 32)
    private IssueSeverity severity;

    @Column(name = "category", nullable = false, length = 64)
    private String category;

    @Column(name = "pattern_code", length = 128)
    private String patternCode;

    @Column(name = "title", nullable = false, length = 255)
    private String title;

    @Column(name = "explanation", nullable = false, columnDefinition = "TEXT")
    private String explanation;

    @Column(name = "source_quote", nullable = false, columnDefinition = "TEXT")
    private String sourceQuote;

    @Column(name = "start_offset", nullable = false)
    private Integer startOffset;

    @Column(name = "end_offset", nullable = false)
    private Integer endOffset;

    @Column(name = "replacement", columnDefinition = "TEXT")
    private String replacement;

    @Column(name = "teaching_rule", columnDefinition = "TEXT")
    private String teachingRule;

    @Column(name = "suggested_practice_mode", length = 32)
    private String suggestedPracticeMode;

    @Enumerated(EnumType.STRING)
    @Column(name = "disposition", nullable = false, length = 32)
    @Builder.Default
    private IssueDisposition disposition = IssueDisposition.ACTIVE;

    @Column(name = "priority_rank", nullable = false)
    @Builder.Default
    private Integer priorityRank = 99;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
