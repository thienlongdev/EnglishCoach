package com.englishcoach.speaking.entity;

import com.englishcoach.auth.entity.User;
import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDateTime;

@Entity
@Table(name = "speaking_sessions", indexes = {
        @Index(name = "idx_speaking_sessions_user_status", columnList = "user_id, status"),
        @Index(name = "idx_speaking_sessions_user_created", columnList = "user_id, created_at")
})
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SpeakingSession {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @JsonIgnore
    @ToString.Exclude
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "scenario_id")
    private SpeakingScenario scenario;

    @Column(nullable = false, length = 50)
    private String mode; // "SHADOWING", "ROLEPLAY"

    @Column(nullable = false, length = 50)
    private String status; // "ACTIVE", "COMPLETED", "ABANDONED"

    @Column(name = "source_type", length = 50)
    private String sourceType; // "VOCABULARY", "READING", "LISTENING"

    @Column(name = "source_id")
    private Long sourceId;

    private Integer durationSeconds;

    @Column(name = "current_unit_index")
    @Builder.Default
    private Integer currentUnitIndex = 0;

    @Column(name = "completed_units_count")
    @Builder.Default
    private Integer completedUnitsCount = 0;

    @Column(name = "total_units_count")
    @Builder.Default
    private Integer totalUnitsCount = 0;

    @Column(name = "active_target_id", length = 100)
    private String activeTargetId;

    @Column(name = "active_attempt_id", length = 100)
    private String activeAttemptId;

    @Column(name = "voice_id", length = 50)
    @Builder.Default
    private String voiceId = "us_female";

    @CreationTimestamp
    @Column(nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @UpdateTimestamp
    private LocalDateTime updatedAt;
}
