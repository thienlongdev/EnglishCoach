package com.englishcoach.flashcard.entity;

import com.englishcoach.auth.entity.User;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.LocalDateTime;

@Entity
@Table(name = "card_blast_runs", indexes = {
    @Index(name = "idx_card_blast_runs_user_deck", columnList = "user_id, deck_id"),
    @Index(name = "idx_card_blast_runs_created_at", columnList = "created_at DESC")
})
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CardBlastRun {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    @com.fasterxml.jackson.annotation.JsonIgnore
    private User user;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "deck_id")
    @com.fasterxml.jackson.annotation.JsonIgnore
    private VocabDeck deck;

    @Column(name = "issued_run_id", length = 36, updatable = false)
    private String issuedRunId;

    @Column(nullable = false)
    private int score;

    @Column(nullable = false)
    private double accuracy;

    @Column(name = "weak_words_count", nullable = false)
    private int weakWordsCount;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;
}
