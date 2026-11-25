package com.englishcoach.flashcard.pvp.entity;

import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;

@Entity
@Table(name = "pvp_matches", schema = "public", indexes = {
        @Index(name = "idx_pvp_matches_room_code", columnList = "room_code"),
        @Index(name = "idx_pvp_matches_host_guest", columnList = "host_user_id, guest_user_id"),
        @Index(name = "idx_pvp_matches_ended_at", columnList = "ended_at DESC")
})
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PvpMatch {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "room_code", length = 10)
    private String roomCode;

    @Column(name = "deck_id")
    private Long deckId;

    @Column(length = 20)
    private String mode;

    private Long seed;

    @Column(name = "host_user_id")
    private Long hostUserId;

    @Column(name = "guest_user_id")
    private Long guestUserId;

    @Column(name = "winner_user_id")
    private Long winnerUserId;

    @Column(length = 20)
    private String result;

    @Column(name = "end_reason", length = 30)
    private String endReason;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "ended_at")
    private Instant endedAt;

    @Column(name = "duration_ms")
    private Long durationMs;

    @Column(name = "host_score")
    private Integer hostScore;

    @Column(name = "guest_score")
    private Integer guestScore;

    @Column(name = "is_ranked")
    @Builder.Default
    private Boolean isRanked = false;
}
