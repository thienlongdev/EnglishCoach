package com.englishcoach.flashcard.pvp.entity;

import jakarta.persistence.*;
import lombok.*;

import java.time.Instant;

@Entity
@Table(name = "pvp_missed_words", schema = "public", indexes = {
        @Index(name = "idx_pvp_missed_words_user_match", columnList = "user_id, match_id")
})
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PvpMissedWord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id")
    private Long userId;

    @Column(name = "word_id")
    private Long wordId;

    @Column(name = "match_id", nullable = false)
    private Long matchId;

    @Column(name = "missed_at")
    @Builder.Default
    private Instant missedAt = Instant.now();
}
