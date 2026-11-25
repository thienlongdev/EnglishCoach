package com.englishcoach.reading.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

/**
 * User Personal Reading History.
 * Represents a user's persistent association with a contextual explanation for a specific Reading material.
 * When a user removes an item, ONLY this association row is deleted, preserving the shared explanation cache.
 */
@Entity
@Table(
    name = "reading_contextual_vocabulary_history",
    uniqueConstraints = {
        @UniqueConstraint(
            name = "uk_rcvh_user_mat_exp",
            columnNames = {"user_id", "reading_material_id", "contextual_explanation_id"}
        )
    },
    indexes = {
        @Index(
            name = "idx_rcvh_user_material",
            columnList = "user_id, reading_material_id"
        ),
        @Index(
            name = "idx_rcvh_explanation",
            columnList = "contextual_explanation_id"
        )
    }
)
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ReadingContextualVocabularyHistory {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "reading_material_id", nullable = false)
    private Long readingMaterialId;

    @ManyToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "contextual_explanation_id", nullable = false)
    private ReadingContextualExplanation explanation;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
