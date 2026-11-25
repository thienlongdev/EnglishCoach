package com.englishcoach.speaking.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "speaking_turns", uniqueConstraints = {
        @UniqueConstraint(name = "uk_speaking_turn_session_client_id", columnNames = {"session_id", "client_turn_id"}),
        @UniqueConstraint(name = "uk_speaking_turn_session_seq", columnNames = {"session_id", "sequence_number"})
}, indexes = {
        @Index(name = "idx_speaking_turns_session_seq", columnList = "session_id, sequence_number"),
        @Index(name = "idx_speaking_turns_session_speaker", columnList = "session_id, speaker")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SpeakingTurn {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "session_id", nullable = false)
    private SpeakingSession session;

    @Column(name = "client_turn_id", length = 100)
    private String clientTurnId;

    @Column(name = "sequence_number", nullable = false)
    private Integer sequenceNumber;

    @Column(nullable = false, length = 30)
    private String speaker; // "LEARNER", "ASSISTANT"

    @Column(columnDefinition = "TEXT", nullable = false)
    private String text;

    @ElementCollection(fetch = FetchType.LAZY)
    @CollectionTable(name = "speaking_turn_detected_vocab", joinColumns = @JoinColumn(name = "turn_id"))
    @Column(name = "word")
    @Builder.Default
    private List<String> detectedVocabulary = new ArrayList<>();

    @Column(name = "is_mocked")
    @Builder.Default
    private Boolean isMocked = false;

    private Integer durationSeconds;

    @Column(name = "pronunciation_score")
    private Integer pronunciationScore;

    @Column(name = "fluency_score")
    private Integer fluencyScore;

    @Column(name = "stress_score")
    private Integer stressScore;

    @Column(name = "intonation_score")
    private Integer intonationScore;

    @Column(name = "rhythm_score")
    private Integer rhythmScore;

    @Column(name = "engine_version", length = 50)
    private String engineVersion;

    @Column(name = "pronunciation_result_json", columnDefinition = "TEXT")
    private String pronunciationResultJson;

    @Column(name = "audio_ref", length = 255)
    private String audioRef;

    @Column(name = "synthesized_audio_ref", length = 500)
    private String synthesizedAudioRef;

    @Column(name = "segmental_score")
    private Integer segmentalScore;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;
}
