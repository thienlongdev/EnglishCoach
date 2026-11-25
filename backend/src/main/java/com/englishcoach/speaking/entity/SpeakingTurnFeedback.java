package com.englishcoach.speaking.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.LocalDateTime;

@Entity
@Table(name = "speaking_turn_feedbacks", indexes = {
        @Index(name = "idx_speaking_turn_feedbacks_turn_id", columnList = "turn_id")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class SpeakingTurnFeedback {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @OneToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "turn_id", unique = true, nullable = false)
    private SpeakingTurn turn;

    @Column(name = "summary", length = 500)
    private String summary;

    @Column(name = "positive_feedback", length = 500)
    private String positiveFeedback;

    @Column(name = "corrections_json", columnDefinition = "TEXT")
    private String correctionsJson;

    @Column(name = "is_mocked")
    @Builder.Default
    private Boolean isMocked = false;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;
}
