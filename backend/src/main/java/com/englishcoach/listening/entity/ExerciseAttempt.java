package com.englishcoach.listening.entity;

import com.englishcoach.listening.entity.enums.ErrorCategory;
import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(name = "exercise_attempts")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ExerciseAttempt {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "listening_session_id", nullable = false)
    private ListeningSession listeningSession;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "listening_exercise_id", nullable = false)
    private ListeningExercise listeningExercise;

    @Column(columnDefinition = "TEXT")
    private String rawUserAnswer;

    private Boolean isCorrect;

    private Double accuracyPercentage;

    @Enumerated(EnumType.STRING)
    private ErrorCategory primaryErrorCategory;

    @Column(columnDefinition = "TEXT")
    private String diagnosticFeedback;
}
