package com.englishcoach.writing.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "writing_error_memories")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingErrorMemoryEntity {

    @Id
    @Column(name = "id", length = 64)
    private String id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "pattern_code", nullable = false, length = 128)
    private String patternCode;

    @Column(name = "category", nullable = false, length = 64)
    private String category;

    @Column(name = "title", nullable = false, length = 255)
    private String title;

    @Column(name = "occurrence_count", nullable = false)
    @Builder.Default
    private Integer occurrenceCount = 0;

    @Column(name = "context_count", nullable = false)
    @Builder.Default
    private Integer contextCount = 0;

    @Column(name = "last_seen_at", nullable = false)
    private Instant lastSeenAt;

    @Column(name = "estimated_mastery", nullable = false)
    @Builder.Default
    private Integer estimatedMastery = 0;

    @Column(name = "has_sufficient_evidence", nullable = false)
    @Builder.Default
    private Boolean hasSufficientEvidence = false;

    @Column(name = "due_for_practice", nullable = false)
    @Builder.Default
    private Boolean dueForPractice = false;

    @Column(name = "next_practice_due_at")
    private Instant nextPracticeDueAt;

    @Column(name = "is_muted", nullable = false)
    @Builder.Default
    private Boolean isMuted = false;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
