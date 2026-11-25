package com.englishcoach.writing.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "writing_skill_masteries")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class WritingSkillMasteryEntity {

    @Id
    @Column(name = "id", length = 64)
    private String id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "skill_code", nullable = false, length = 128)
    private String skillCode;

    @Column(name = "category", nullable = false, length = 64)
    private String category;

    @Column(name = "name", nullable = false, length = 255)
    private String name;

    @Column(name = "evidence_count", nullable = false)
    @Builder.Default
    private Integer evidenceCount = 0;

    @Column(name = "mastery_percentage")
    private Integer masteryPercentage;

    @Column(name = "trend", nullable = false, length = 32)
    @Builder.Default
    private String trend = "INSUFFICIENT_DATA";

    @Column(name = "last_practiced_at")
    private Instant lastPracticedAt;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
