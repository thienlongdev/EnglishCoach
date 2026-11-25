package com.englishcoach.listening.entity;

import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(name = "transcript_segments")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class TranscriptSegment {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "listening_material_id", nullable = false)
    private ListeningMaterial listeningMaterial;

    private Integer startTimeMs;

    private Integer endTimeMs;

    private String speakerName;

    @Column(columnDefinition = "TEXT")
    private String text;

    @Column(columnDefinition = "TEXT")
    private String wordsJson;

    private Double difficultyScore;
}

