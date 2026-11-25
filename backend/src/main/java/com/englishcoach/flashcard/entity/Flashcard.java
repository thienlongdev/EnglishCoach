package com.englishcoach.flashcard.entity;

import com.englishcoach.auth.entity.User;
import com.englishcoach.dictionary.entity.DictionaryEntry;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDateTime;

@Entity
@Table(name = "flashcards", indexes = {
    @Index(name = "idx_flashcards_user_state", columnList = "user_id, state"),
    @Index(name = "idx_flashcards_user_due", columnList = "user_id, state, status, next_review_date"),
    @Index(name = "idx_flashcards_user_dict", columnList = "user_id, dictionary_entry_id"),
    @Index(name = "idx_flashcards_user_deck", columnList = "user_id, deck_id"),
    @Index(name = "idx_flashcards_user_deck_status", columnList = "user_id, deck_id, status")
})
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class Flashcard {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    @com.fasterxml.jackson.annotation.JsonIgnore
    private User user;

    @ManyToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "dictionary_entry_id", nullable = false)
    private DictionaryEntry dictionaryEntry;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "deck_id")
    @com.fasterxml.jackson.annotation.JsonIgnore
    private VocabDeck deck;

    private int reviewCount;

    @Builder.Default
    @Column(name = "status", nullable = false)
    private String status = "NEW";

    @Builder.Default
    @Column(name = "is_system", nullable = false)
    private boolean isSystem = false;

    @Builder.Default
    @Column(name = "state", nullable = false, columnDefinition = "integer default 0")
    private int state = 0;

    private LocalDateTime nextReviewDate;

    /** The learner's own meaning / example typed when the card was saved (V101); shown before the dictionary's. */
    @Column(name = "custom_meaning", columnDefinition = "TEXT")
    private String customMeaning;

    @Column(name = "custom_example", columnDefinition = "TEXT")
    private String customExample;

    /**
     * The contextual sense of a card the learner approved in Echo AI Card Studio (V117): its English definition, part of speech
     * and the Vietnamese translation of the example. When present the card shows only this sense (never the dictionary row's
     * other senses). Null on every other card.
     */
    @Column(name = "custom_definition", columnDefinition = "TEXT")
    private String customDefinition;

    @Column(name = "custom_part_of_speech", length = 32)
    private String customPartOfSpeech;

    @Column(name = "custom_example_vi", columnDefinition = "TEXT")
    private String customExampleVi;

    /**
     * The sense the card's deck teaches (V106 curated topic decks); attached by FlashcardService when the card is read,
     * never stored on the card. Null for personal cards and for decks without curated senses.
     */
    @Transient
    private com.englishcoach.flashcard.dto.DeckSense deckSense;

    /** Client id of the last rating applied (V101): a retried rating with the same id is not applied twice. */
    @Column(name = "last_review_request_id", length = 64)
    @com.fasterxml.jackson.annotation.JsonIgnore
    private String lastReviewRequestId;

    @CreationTimestamp
    @Column(nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @UpdateTimestamp
    private LocalDateTime updatedAt;

    public int getRepetitions() {
        return this.reviewCount;
    }

    public void setRepetitions(int repetitions) {
        this.reviewCount = repetitions;
    }
}
