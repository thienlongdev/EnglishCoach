package com.englishcoach.listening.entity;

import jakarta.persistence.*;
import lombok.*;

import java.util.List;

@Entity
@Table(name = "listening_materials")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ListeningMaterial {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String title;

    @Column(nullable = false)
    private String audioUrl;

    @Builder.Default
    private String sourceType = "VIDEO";
    private String voiceId;

    private Integer durationSeconds;

    @Column(name = "cefr_level")
    private String cefrLevel;

    private String topic;

    private String accent;

    private Double speechRate;

    private Integer speakerCount;

    private Double backgroundNoiseLevel;

    private Double vocabularyDifficulty;

    private Double connectedSpeechDifficulty;

    private Double inferenceDifficulty;

    @Column(name = "owner_user_id")
    private Long ownerUserId;

    @Column(name = "is_system", nullable = false)
    @Builder.Default
    private boolean isSystem = false;

    @Column(name = "channel")
    private String channel;

    @Column(name = "thumbnail")
    private String thumbnail;

    @Column(name = "youtube_video_id")
    private String youtubeVideoId;

    @OneToMany(mappedBy = "listeningMaterial", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    private List<TranscriptSegment> segments;

    @OneToMany(mappedBy = "listeningMaterial", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    private List<ListeningExercise> exercises;

    @OneToMany(mappedBy = "listeningMaterial", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    private List<ListeningSession> sessions;
}
