package com.englishcoach.speaking.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDateTime;

@Entity
@Table(name = "speaking_quick_checks", schema = "exams", indexes = {
        @Index(name = "idx_quick_check_user_created", columnList = "user_id, created_at"),
        @Index(name = "idx_quick_check_client_id", columnList = "client_attempt_id")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SpeakingQuickCheck {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "session_id")
    private SpeakingSession session;

    @Column(name = "client_attempt_id", nullable = false, unique = true, length = 100)
    private String clientAttemptId;

    @Column(name = "audio_ref", length = 255)
    private String audioRef;

    @Column(name = "whisper_transcript", columnDefinition = "TEXT")
    private String whisperTranscript;

    @Column(name = "intended_transcript", columnDefinition = "TEXT")
    private String intendedTranscript;

    @Column(name = "overall_score")
    private Double overallScore;

    @Column(name = "phoneme_score")
    private Double phonemeScore;

    @Column(name = "stress_score")
    private Double stressScore;

    @Column(name = "pitch_score")
    private Double pitchScore;

    @Column(name = "rhythm_score")
    private Double rhythmScore;

    @Column(name = "fluency_score")
    private Double fluencyScore;

    @Column(name = "pronunciation_diagnostics_json", columnDefinition = "TEXT")
    private String pronunciationDiagnosticsJson;

    @Column(name = "language_feedback_json", columnDefinition = "TEXT")
    private String languageFeedbackJson;

    @Column(name = "model_metadata_json", columnDefinition = "TEXT")
    private String modelMetadataJson;

    @Column(name = "is_mocked")
    @Builder.Default
    private Boolean isMocked = false;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at")
    private LocalDateTime updatedAt;
}
