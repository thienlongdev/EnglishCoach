package com.englishcoach.listening.entity;

import com.englishcoach.listening.entity.enums.ExerciseType;
import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(name = "listening_exercises")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ListeningExercise {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "listening_material_id", nullable = false)
    private ListeningMaterial listeningMaterial;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "transcript_segment_id")
    private TranscriptSegment transcriptSegment;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private ExerciseType exerciseType;

    @Column(columnDefinition = "TEXT")
    private String questionText;

    @Column(columnDefinition = "TEXT")
    private String expectedAnswer;

    private Double difficultyScore;

    @OneToMany(mappedBy = "listeningExercise", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    private java.util.List<ExerciseAttempt> attempts;
}
