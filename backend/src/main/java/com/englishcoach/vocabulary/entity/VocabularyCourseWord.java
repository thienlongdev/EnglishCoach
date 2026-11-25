package com.englishcoach.vocabulary.entity;

import com.englishcoach.reading.entity.ReadingMaterial;
import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(name = "vocabulary_course_words")
@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class VocabularyCourseWord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "course_id", nullable = false)
    private VocabularyCourse course;

    @Column(name = "word", nullable = false)
    private String word;

    // --- Active Reading System integration ---
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "source_material_id", nullable = true)
    private ReadingMaterial sourceMaterial;

    @Column(columnDefinition = "TEXT", nullable = true)
    private String contextSentence;
}
