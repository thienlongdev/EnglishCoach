package com.englishcoach.flashcard.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.LocalDateTime;

@Entity
@Table(name = "vocab_decks")
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class VocabDeck {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true, length = 100)
    private String slug;

    @Column(nullable = false, length = 255)
    private String title;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(nullable = false, length = 50)
    private String category;

    @Builder.Default
    @Column(name = "theme_color", nullable = false, length = 50)
    private String themeColor = "emerald";

    @Builder.Default
    @Column(nullable = false, length = 50)
    private String icon = "book";

    @Builder.Default
    @Column(name = "total_words", nullable = false)
    private int totalWords = 0;

    @Builder.Default
    @Column(name = "is_system", nullable = false)
    private boolean isSystem = true;

    @Builder.Default
    @Column(name = "sort_order", nullable = false)
    private int sortOrder = 0;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at")
    private LocalDateTime updatedAt;
}
