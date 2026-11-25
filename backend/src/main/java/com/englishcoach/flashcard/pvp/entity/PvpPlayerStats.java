package com.englishcoach.flashcard.pvp.entity;

import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(name = "pvp_player_stats", schema = "public", indexes = {
        @Index(name = "idx_pvp_player_stats_match_id", columnList = "match_id"),
        @Index(name = "idx_pvp_player_stats_user_id", columnList = "user_id")
})
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PvpPlayerStats {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "match_id", nullable = false)
    private Long matchId;

    @Column(name = "user_id")
    private Long userId;

    private Integer hits;

    private Integer misses;

    @Column(name = "best_streak")
    private Integer bestStreak;

    @Column(name = "avg_reaction_ms")
    private Integer avgReactionMs;

    @Column(name = "golden_captured")
    private Integer goldenCaptured;

    @Column(name = "attacks_sent")
    private Integer attacksSent;

    @Column(name = "attacks_received")
    private Integer attacksReceived;

    @Column(name = "skills_used")
    private Integer skillsUsed;
}
