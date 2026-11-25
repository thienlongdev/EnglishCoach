package com.englishcoach.listening.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;

import java.time.LocalDateTime;

@Entity
@Table(name = "listening_sessions")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ListeningSession {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = true)
    private User user;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "listening_material_id", nullable = false)
    private ListeningMaterial listeningMaterial;

    private LocalDateTime startedAt;

    private LocalDateTime endedAt;

    private LocalDateTime closedEarlyAt;

    public boolean isClosed() {
        return endedAt != null || closedEarlyAt != null;
    }

    private Double playbackSpeedUsed;

    @OneToMany(mappedBy = "listeningSession", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    private java.util.List<ExerciseAttempt> attempts;
}
