package com.englishcoach.content.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.time.LocalDate;

@Entity
@Table(name = "listening_content", schema = "public")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ListeningContent {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "provider_key", length = 50)
    private String providerKey;

    @Column(nullable = false, length = 20)
    @Builder.Default
    private String kind = "LISTENING";

    @Column(name = "youtube_video_id", length = 50)
    private String youtubeVideoId;

    @Column(nullable = false, length = 500)
    private String title;

    @Column(length = 255)
    private String channel;

    @Column(nullable = false, length = 10)
    @Builder.Default
    private String level = "B1";

    @Column(nullable = false)
    @Builder.Default
    private Integer duration = 0;

    @Column(name = "audio_url", length = 1000)
    private String audioUrl;

    @Column(length = 1000)
    private String thumbnail;

    @Column(columnDefinition = "TEXT")
    private String transcript;

    @Column(name = "transcript_hidden", nullable = false)
    @Builder.Default
    private Boolean transcriptHidden = false;

    @Column(length = 50)
    private String accent;

    @Column(length = 100)
    private String topic;

    @Column(name = "featured_on")
    private LocalDate featuredOn;

    @CreationTimestamp
    @Column(name = "created_at", insertable = false, updatable = false)
    private Instant createdAt;
}
